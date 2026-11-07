"""The role matrix: what each kind of user may do, in one table.

Routes ask for a :class:`Permission` rather than naming roles, so changing what
a role can do is an edit here and nowhere else. The login response sends the same
list to the frontend, which uses it to hide what the hub would refuse anyway.
"""

from __future__ import annotations

import enum

from .models import UserRole


class Permission(str, enum.Enum):
    CLIENTS_READ = "clients:read"
    CLIENTS_WRITE = "clients:write"
    CLIENTS_LOGS = "clients:logs"
    CONTAINERS_PROVISION = "containers:provision"
    CONTAINERS_TERMINATE = "containers:terminate"
    PORTAL_LINKS = "portal:links"
    PORTAL_ANY = "portal:any"
    #: Decide an owner-lane approval on someone else's behalf.
    PORTAL_DECIDE = "portal:decide"
    SERVER_SETTINGS = "server:settings"
    BILLING = "billing:manage"
    USERS_MANAGE = "users:manage"
    QA_QUEUE = "qa:queue"
    SKILLS_READ = "skills:read"
    KITS_WRITE = "kits:write"
    ROI_READ = "roi:read"
    ROI_WRITE = "roi:write"
    CRM = "crm:manage"
    AUDIT_TRACKER = "audit:tracker"
    ONBOARDING_DRAFTS = "drafts:manage"
    STANDUP = "standup:manage"


_ALL = frozenset(Permission)

ROLE_PERMISSIONS: dict[UserRole, frozenset[Permission]] = {
    UserRole.SUPER_ADMIN: _ALL,
    UserRole.GROWTH_OPS: frozenset(
        {
            Permission.CLIENTS_READ,
            Permission.CLIENTS_WRITE,
            Permission.CLIENTS_LOGS,
            Permission.PORTAL_LINKS,
            Permission.PORTAL_ANY,
            Permission.QA_QUEUE,
            Permission.SKILLS_READ,
            Permission.KITS_WRITE,
            Permission.ROI_READ,
            Permission.ROI_WRITE,
        }
    ),
    UserRole.SALES_OPS: frozenset(
        {
            Permission.CRM,
            Permission.AUDIT_TRACKER,
            Permission.ONBOARDING_DRAFTS,
            Permission.STANDUP,
        }
    ),
    # Everything a client owner can reach is scoped by tenant in the portal
    # router, not by a permission here.
    UserRole.CLIENT_OWNER: frozenset(),
}


def permissions_for(role: UserRole) -> list[str]:
    return sorted(permission.value for permission in ROLE_PERMISSIONS[role])
