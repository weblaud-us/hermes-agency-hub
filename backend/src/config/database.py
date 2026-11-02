"""Async SQLAlchemy engine, session factory and declarative base.

The engine is built lazily rather than at import. Creating it eagerly meant
that merely importing a model required the database driver to be installed and
the URL to be parseable — so a typo in ``DATABASE_URL`` crashed the process
during import, before any logging or error handling existed to explain it, and
tooling that only wanted the table metadata (Alembic autogenerate, tests)
dragged in a Postgres driver it never used.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from .settings import get_settings


class Base(DeclarativeBase):
    """Declarative base for every hub table."""


_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """The process-wide engine, created on first use."""
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.database_url,
            echo=settings.db_echo,
            # Provisioning requests are long (minutes, when an image pulls),
            # so a connection can sit idle long enough for the server or an
            # intermediary to drop it. Pre-ping trades a trivial round trip
            # for not failing the request on a stale connection.
            pool_pre_ping=True,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            get_engine(),
            # The provisioner reads client attributes after the request's
            # commit (to build the response); expiring them would trigger
            # lazy refreshes against a closed session.
            expire_on_commit=False,
            class_=AsyncSession,
        )
    return _session_factory


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request, committed on success."""
    async with get_session_factory()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Session for background tasks, which have no request to hang off."""
    async with get_session_factory()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def dispose_engine() -> None:
    """Release pooled connections on shutdown. Safe if never created."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
    _session_factory = None
