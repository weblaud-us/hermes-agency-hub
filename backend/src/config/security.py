"""Secrets shared between the hub and its tenants.

Who may call the hub is decided in ``auth/dependencies.py``.
"""

from __future__ import annotations

import secrets


def new_internal_token() -> str:
    """Shared secret the hub and one client container use to talk to each other."""
    return secrets.token_urlsafe(32)
