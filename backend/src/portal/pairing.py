"""WhatsApp re-linking: run the agent's own pairing process and relay its QR.

The agent's bridge emits JSON lines under ``--pair-only --pair-json`` and rotates
its QR about every 20 seconds, so one pairing is a long-lived process rather than
a single answer. A worker thread reads the stream into a :class:`PairingSession`
and the portal polls it. Sessions live in this process's memory: a hub restart
ends the wait, and the owner simply starts again.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import segno

from ..clients.models import Client
from ..config.settings import Settings
from ..orchestrator.docker_service import DockerService, OrchestratorError

logger = logging.getLogger(__name__)

#: Long enough to find a phone and open the linked-devices screen, and short
#: enough that an abandoned pairing does not leave a process behind for long.
PAIRING_TIMEOUT_SECONDS = 180
QR_ROTATION_SECONDS = 20


@dataclass
class PairingSession:
    state: str = "qr_pending"
    qr_payload: str | None = None
    qr_updated_at: float = 0.0
    started_at: float = field(default_factory=time.monotonic)

    @property
    def finished(self) -> bool:
        return self.state in {"connected", "failed"}

    @property
    def expired(self) -> bool:
        return time.monotonic() - self.started_at > PAIRING_TIMEOUT_SECONDS

    def qr_png_base64(self) -> str | None:
        if not self.qr_payload:
            return None
        buffer = io.BytesIO()
        segno.make(self.qr_payload, error="l").save(buffer, kind="png", scale=8, border=2)
        return base64.b64encode(buffer.getvalue()).decode("ascii")

    def seconds_until_refresh(self) -> int:
        age = time.monotonic() - self.qr_updated_at
        return max(0, round(QR_ROTATION_SECONDS - age))


def apply_pair_event(session: PairingSession, event: dict[str, Any]) -> None:
    """Fold one bridge event into the session. Unknown events are ignored."""
    kind = event.get("event")
    if kind == "qr" and isinstance(event.get("qr"), str) and event["qr"].strip():
        session.qr_payload = event["qr"].strip()
        session.qr_updated_at = time.monotonic()
        session.state = "qr_ready"
    elif kind == "connected":
        session.state = "connected"
        session.qr_payload = None
    elif kind == "error":
        session.state = "failed"
        session.qr_payload = None


class PairingRegistry:
    def __init__(self) -> None:
        self._sessions: dict[uuid.UUID, PairingSession] = {}
        self._lock = threading.Lock()

    def current(self, client_id: uuid.UUID) -> PairingSession | None:
        with self._lock:
            session = self._sessions.get(client_id)
        if session is not None and session.expired and not session.finished:
            session.state = "failed"
            session.qr_payload = None
        return session

    def start(
        self, client: Client, docker: DockerService, settings: Settings
    ) -> PairingSession:
        """Begin pairing, or return the attempt already running.

        Never two at once: both would write the same session directory.
        """
        with self._lock:
            existing = self._sessions.get(client.id)
            if existing and not existing.finished and not existing.expired:
                return existing
            session = PairingSession()
            self._sessions[client.id] = session

        name = client.container_name or settings.container_name_for(client.slug)
        thread = threading.Thread(
            target=self._run,
            args=(session, docker, settings, name),
            name="portal-whatsapp-pairing",
            daemon=True,
        )
        thread.start()
        return session

    @staticmethod
    def _run(
        session: PairingSession, docker: DockerService, settings: Settings, name: str
    ) -> None:
        command = [
            "node",
            settings.whatsapp_bridge_script,
            "--pair-only",
            "--pair-json",
            "--session",
            settings.whatsapp_session_path,
        ]
        try:
            # As the agent's user: a root-owned session file would be unreadable
            # to the gateway that has to use it afterwards.
            lines = docker.exec_lines_sync(
                name,
                command,
                user="hermes",
                environment={"WHATSAPP_DM_POLICY": "pairing"},
            )
            for line in lines:
                if session.expired:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict):
                    apply_pair_event(session, event)
                    if session.state == "connected":
                        # The running gateway has no session open, so it has to
                        # start again to use the one just created.
                        docker.restart_sync(name)
                    if session.finished:
                        return
        except OrchestratorError:
            logger.exception("WhatsApp pairing could not start in %s", name)
        except Exception:  # noqa: BLE001 - a dying thread must still end the wait
            logger.exception("WhatsApp pairing stream failed for %s", name)
        if not session.finished:
            session.state = "failed"
            session.qr_payload = None


pairing_registry = PairingRegistry()
