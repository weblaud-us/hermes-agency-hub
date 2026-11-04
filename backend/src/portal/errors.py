"""The only failure the portal surface is allowed to report.

Every other exception in the hub carries operator detail: an
``OrchestratorError`` names the tenant's container and an ``OSError`` carries a
host path. ``main.py`` maps this type to a response, and the portal converts
everything else to it first, so ``detail`` is always written for a business
owner and never interpolates anything from the system underneath.
"""

from __future__ import annotations

from fastapi import status


class PortalError(Exception):
    def __init__(self, status_code: int, slug: str, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.slug = slug
        self.detail = detail


def unauthorized() -> PortalError:
    """One answer for an unknown tenant and a bad token, so neither can be probed."""
    return PortalError(
        status.HTTP_401_UNAUTHORIZED,
        "portal_unauthorized",
        "This access link is not valid. Ask your account manager for a new one.",
    )


def data_unavailable() -> PortalError:
    return PortalError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "portal_data_unavailable",
        "This information is temporarily unavailable. Please try again shortly.",
    )


def coordinator_unavailable() -> PortalError:
    return PortalError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "coordinator_unavailable",
        "Your Coordinator is not reachable right now. Please try again shortly.",
    )
