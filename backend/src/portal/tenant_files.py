"""Filesystem access locked to one tenant's directory.

The agent inside a tenant container has a shell and owns its data directory, so
every file here must be treated as potentially hostile. The dangerous case is a
symlink: inside the container ``memories/MEMORY.md -> /srv/.../other-tenant/.env``
points nowhere, but the hub resolves it on the host, where it lands on another
tenant's secrets. Reads would hand those to this tenant's owner and writes would
overwrite them. So any path that does not resolve to exactly itself is refused,
which rejects symlinks at every level, and anything but a regular file is
refused, because opening a FIFO would hang a worker thread forever.

All of this blocks, so callers run it through ``asyncio.to_thread``.
"""

from __future__ import annotations

import contextlib
import errno
import json
import logging
import os
import secrets
import stat
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .errors import PortalError, data_unavailable

logger = logging.getLogger(__name__)

#: Generous for a skill or a report; a cap so a runaway file cannot exhaust memory.
MAX_FILE_BYTES = 512 * 1024

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]
try:
    import msvcrt
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None  # type: ignore[assignment]


class TenantPathError(ValueError):
    """The path leaves the tenant directory or passes through a symlink."""


class TenantFiles:
    def __init__(self, root: Path) -> None:
        self.root = root

    def contained(self, *parts: str) -> Path:
        """``root/parts``, refused unless it resolves to exactly that location."""
        try:
            real_root = self.root.resolve()
            target = real_root.joinpath(*parts)
            if target.resolve() != target:
                raise TenantPathError(f"refused path under {self.root.name}")
        except (OSError, RuntimeError) as exc:  # RuntimeError: symlink loop
            raise TenantPathError(f"unresolvable path under {self.root.name}") from exc
        return target

    def unavailable(self, path: Path, exc: OSError) -> PortalError:
        # The one log line an operator needs. See "Client portal" in the README
        # for why a hub without read access to tenant files lands here.
        logger.error(
            "Portal cannot access %s: %s. The hub needs the same uid as the tenant "
            "(CLIENT_UID) to read its files.",
            path,
            exc,
        )
        return data_unavailable()

    @staticmethod
    def _parts(parts: tuple[str, ...]) -> tuple[str, ...]:
        """Validate relative path components before handing them to ``openat``.

        Callers normally use constants, but job and skill names ultimately come
        from tenant-owned files.  A component is deliberately stricter than the
        host filesystem: separators and traversal notation are never paths in
        the tenant-file API.
        """
        if not parts or any(
            not part
            or part in {".", ".."}
            or "/" in part
            or "\\" in part
            for part in parts
        ):
            raise TenantPathError("invalid tenant path")
        return parts

    @property
    def _descriptor_safe(self) -> bool:
        """Whether this interpreter can keep every path component anchored.

        The hub's production image is Linux.  Windows lacks ``dir_fd`` and
        ``O_NOFOLLOW`` in CPython, so it retains the compatibility path below
        for local development; it cannot offer the same hostile-tenant
        guarantee because Windows has no equivalent primitives exposed here.
        """
        return os.name == "posix" and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")

    def _open_root(self) -> int:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        return os.open(self.root, flags)

    def _open_parent(self, parts: tuple[str, ...], *, create: bool = False) -> tuple[int, str]:
        """Open the parent directory without following any tenant-controlled link.

        Each directory is opened relative to the descriptor already verified as
        a directory.  Renaming a directory after it has been opened cannot
        redirect later operations because they use that descriptor, not its
        pathname.
        """
        pieces = self._parts(parts)
        descriptor = self._open_root()
        try:
            for piece in pieces[:-1]:
                flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                try:
                    child = os.open(piece, flags, dir_fd=descriptor)
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        os.mkdir(piece, 0o700, dir_fd=descriptor)
                    except FileExistsError:
                        # Another writer won the create race. Opening it with
                        # O_NOFOLLOW below still rejects a substituted link.
                        pass
                    child = os.open(piece, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            return descriptor, pieces[-1]
        except Exception:
            os.close(descriptor)
            raise

    def _open_regular(self, *parts: str) -> int | None:
        """Descriptor for a regular tenant file, anchored to the tenant root."""
        if not self._descriptor_safe:
            return self._open_regular_legacy(*parts)
        try:
            parent, name = self._open_parent(tuple(parts))
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc
        try:
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            descriptor = os.open(name, flags, dir_fd=parent)
        except FileNotFoundError:
            return None
        except OSError as exc:
            # A symlink or a swapped directory is hostile input, not an
            # availability problem worth exposing to the tenant owner.
            if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                return None
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc
        finally:
            os.close(parent)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                logger.warning("Refusing non-regular file under %s", self.root.name)
                os.close(descriptor)
                return None
            return descriptor
        except OSError as exc:
            os.close(descriptor)
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc

    def _open_regular_legacy(self, *parts: str) -> int | None:
        """Compatibility implementation for local Windows development only."""
        try:
            path = self.contained(*parts)
            info = os.lstat(path)
        except FileNotFoundError:
            return None
        except (OSError, TenantPathError) as exc:
            if isinstance(exc, OSError):
                raise self.unavailable(self.root.joinpath(*parts), exc) from exc
            return None
        if not stat.S_ISREG(info.st_mode):
            return None
        try:
            return os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise self.unavailable(path, exc) from exc

    def read_bytes(self, *parts: str, max_bytes: int = MAX_FILE_BYTES) -> bytes | None:
        """File contents, or ``None`` if absent, refused or over ``max_bytes``."""
        try:
            self._parts(parts)
        except TenantPathError:
            logger.warning("Refused tenant path %s under %s", "/".join(parts), self.root)
            return None
        descriptor = self._open_regular(*parts)
        if descriptor is None:
            return None
        with os.fdopen(descriptor, "rb") as handle:
            data = handle.read(max_bytes + 1)
        if len(data) > max_bytes:
            logger.warning("Ignoring oversized tenant file under %s", self.root.name)
            return None
        return data

    def read_text(self, *parts: str, max_bytes: int = MAX_FILE_BYTES) -> str | None:
        data = self.read_bytes(*parts, max_bytes=max_bytes)
        return None if data is None else data.decode("utf-8-sig", errors="replace")

    def read_tail(self, *parts: str, max_bytes: int = MAX_FILE_BYTES) -> str | None:
        """The end of an append-only log, starting at a whole line."""
        try:
            self._parts(parts)
        except TenantPathError:
            return None
        descriptor = self._open_regular(*parts)
        if descriptor is None:
            return None
        with os.fdopen(descriptor, "rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - max_bytes))
            data = handle.read()
        if size > max_bytes:
            data = data.partition(b"\n")[2]
        return data.decode("utf-8", errors="replace")

    def read_json(self, *parts: str) -> Any | None:
        text = self.read_text(*parts)
        if text is None:
            return None
        try:
            return json.loads(text)
        except ValueError:
            logger.warning("Ignoring malformed tenant JSON %s", "/".join(parts))
            return None

    def list_regular_names(self, *parts: str, suffix: str = "") -> list[str]:
        """Regular-file names in a tenant directory, without following links."""
        if not self._descriptor_safe:
            try:
                directory = self.contained(*parts)
                return sorted(
                    entry.name for entry in os.scandir(directory)
                    if entry.is_file() and (not suffix or entry.name.endswith(suffix))
                )
            except (OSError, TenantPathError):
                return []
        try:
            parent, name = self._open_parent(tuple(parts))
            try:
                directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            finally:
                os.close(parent)
        except (FileNotFoundError, TenantPathError):
            return []
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                return []
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc
        try:
            names: list[str] = []
            for entry in os.listdir(directory):
                if suffix and not entry.endswith(suffix):
                    continue
                try:
                    info = os.stat(entry, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISREG(info.st_mode):
                    names.append(entry)
            return sorted(names)
        finally:
            os.close(directory)

    def directories_with_file(
        self,
        *parts: str,
        filename: str,
        max_depth: int,
        max_results: int,
        skip_names: set[str],
    ) -> list[tuple[str, ...]]:
        """Tenant-relative directories containing a regular ``filename``.

        Directory traversal is descriptor-relative throughout.  It replaces
        ``os.walk(path)`` for tenant-owned trees, where a pathname can be
        redirected after it was validated.
        """
        if not self._descriptor_safe:
            return self._directories_with_file_legacy(
                *parts, filename=filename, max_depth=max_depth,
                max_results=max_results, skip_names=skip_names,
            )
        try:
            parent, name = self._open_parent(tuple(parts))
            try:
                root = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            finally:
                os.close(parent)
        except (FileNotFoundError, TenantPathError):
            return []
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                return []
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc

        found: list[tuple[str, ...]] = []

        def walk(directory: int, relative: tuple[str, ...]) -> None:
            try:
                names = os.listdir(directory)
            except PermissionError:
                raise
            if filename in names:
                try:
                    info = os.stat(filename, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    info = None
                if info is not None and stat.S_ISREG(info.st_mode) and relative:
                    found.append(relative)
                    return
            if len(relative) >= max_depth:
                return
            for child_name in names:
                if child_name.startswith(".") or child_name in skip_names:
                    continue
                try:
                    info = os.stat(child_name, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if not stat.S_ISDIR(info.st_mode):
                    continue
                try:
                    child = os.open(child_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                except FileNotFoundError:
                    continue
                except OSError as exc:
                    # A concurrent rename can make a just-inspected directory
                    # disappear; a permission failure is real availability
                    # trouble and must not look like an empty skills library.
                    if exc.errno in {errno.ELOOP, errno.ENOTDIR}:
                        continue
                    raise
                try:
                    walk(child, (*relative, child_name))
                finally:
                    os.close(child)
                if len(found) >= max_results:
                    return

        try:
            walk(root, ())
        except PermissionError as exc:
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc
        finally:
            os.close(root)
        return found

    def _directories_with_file_legacy(
        self, *parts: str, filename: str, max_depth: int, max_results: int, skip_names: set[str]
    ) -> list[tuple[str, ...]]:
        """Compatibility traversal for local Windows development only."""
        try:
            root = self.contained(*parts)
        except TenantPathError:
            return []
        found: list[tuple[str, ...]] = []
        for current, directories, filenames in os.walk(root):
            relative = os.path.relpath(current, root)
            depth_parts = () if relative == "." else tuple(relative.split(os.sep))
            if filename in filenames and depth_parts:
                found.append(depth_parts)
                directories[:] = []
            elif len(depth_parts) >= max_depth:
                directories[:] = []
            else:
                directories[:] = [name for name in directories if name not in skip_names]
            if len(found) >= max_results:
                break
        return found

    @contextlib.contextmanager
    def readonly_uri(self, *parts: str) -> Iterator[str | None]:
        """A stable SQLite URI for a regular tenant file, or ``None`` if absent."""
        descriptor = self._open_regular(*parts)
        if descriptor is None:
            yield None
            return
        try:
            if self._descriptor_safe:
                # `/proc/self/fd/N` refers to this exact opened inode.  Keeping
                # the descriptor open prevents a rename from changing what
                # SQLite subsequently opens through the procfs link.
                yield f"file:/proc/self/fd/{descriptor}?mode=ro&immutable=1"
            else:  # pragma: no cover - local Windows compatibility
                yield self.contained(*parts).as_uri() + "?mode=ro"
        finally:
            os.close(descriptor)

    def write_atomic(self, text: str, *parts: str, default_mode: int = 0o600) -> None:
        """Replace a file so a concurrent reader never sees a partial write.

        Keeps the existing mode and, where the OS allows, its owner: a file left
        owned by the hub at 0600 is unreadable to the agent, which would quietly
        lose its memory or configuration.
        """
        if not self._descriptor_safe:
            self._write_atomic_legacy(text, *parts, default_mode=default_mode)
            return

        temp_name: str | None = None
        parent: int | None = None
        try:
            parent, name = self._open_parent(tuple(parts), create=True)
            try:
                existing = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                raise data_unavailable()

            for _ in range(10):
                temp_name = f".portal_{secrets.token_hex(16)}"
                try:
                    descriptor = os.open(
                        temp_name,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        default_mode,
                        dir_fd=parent,
                    )
                    break
                except FileExistsError:
                    continue
            else:  # pragma: no cover - cryptographic collision is implausible
                raise OSError("could not allocate an atomic tenant-file temporary")
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
                os.fchmod(
                    handle.fileno(),
                    stat.S_IMODE(existing.st_mode) if existing else default_mode,
                )
                if existing is not None and hasattr(os, "fchown"):
                    with contextlib.suppress(PermissionError):
                        os.fchown(handle.fileno(), existing.st_uid, existing.st_gid)
            os.replace(temp_name, name, src_dir_fd=parent, dst_dir_fd=parent)
            temp_name = None
        except TenantPathError as exc:
            raise data_unavailable() from exc
        except OSError as exc:
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc
        finally:
            if temp_name is not None:
                with contextlib.suppress(OSError):
                    if parent is not None:
                        os.unlink(temp_name, dir_fd=parent)
            if parent is not None:
                os.close(parent)

    def _write_atomic_legacy(self, text: str, *parts: str, default_mode: int) -> None:
        """Compatibility implementation for local Windows development only."""
        try:
            path = self.contained(*parts)
        except TenantPathError as exc:
            raise data_unavailable() from exc
        temp_name: str | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            existing = path.stat() if path.exists() else None
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                raise data_unavailable()
            descriptor, temp_name = tempfile.mkstemp(dir=path.parent, prefix=".portal_")
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_name, stat.S_IMODE(existing.st_mode) if existing else default_mode)
            os.replace(temp_name, path)
            temp_name = None
        except OSError as exc:
            raise self.unavailable(path, exc) from exc
        finally:
            if temp_name is not None:
                with contextlib.suppress(OSError):
                    os.unlink(temp_name)

    @contextlib.contextmanager
    def locked(self, *parts: str) -> Iterator[None]:
        """Hold the agent's own lock for a file while changing it.

        The agent serialises writes through ``<file>.lock``, and ``flock`` on a
        shared bind mount holds across containers, so taking the same lock stops
        the hub and the agent from overwriting each other's changes.
        """
        *directory, name = self._parts(parts)
        if not self._descriptor_safe:
            with self._locked_legacy(*parts):
                yield
            return
        parent: int | None = None
        try:
            parent, lock_name = self._open_parent((*directory, f"{name}.lock"), create=True)
            flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
            descriptor = os.open(lock_name, flags, 0o600, dir_fd=parent)
        except TenantPathError as exc:
            raise data_unavailable() from exc
        except OSError as exc:
            raise self.unavailable(self.root.joinpath(*parts), exc) from exc
        finally:
            if parent is not None:
                os.close(parent)
        try:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            elif msvcrt is not None:  # pragma: no cover - Windows
                msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - Windows
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            os.close(descriptor)

    @contextlib.contextmanager
    def _locked_legacy(self, *parts: str) -> Iterator[None]:
        *directory, name = parts
        try:
            lock_path = self.contained(*directory, f"{name}.lock")
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as exc:
            raise self.unavailable(lock_path, exc) from exc
        try:
            if msvcrt is not None:  # pragma: no cover - Windows
                msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
            yield
        finally:
            if msvcrt is not None:  # pragma: no cover - Windows
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            os.close(descriptor)
