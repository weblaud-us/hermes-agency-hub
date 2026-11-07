import { ApiError } from "./hub-types";

/**
 * Sign-in, through the same-origin door. The hub sets HttpOnly cookies on the way
 * back, so the tokens in its login response are deliberately ignored here: a token
 * this script can hold is a token an injected script could steal.
 */

const BASE = "/hub-api/auth";

export type Role = "SUPER_ADMIN" | "GROWTH_OPS" | "SALES_OPS" | "CLIENT_OWNER";

export const PERMISSIONS = {
  clientsRead: "clients:read",
  clientsWrite: "clients:write",
  clientsLogs: "clients:logs",
  provision: "containers:provision",
  terminate: "containers:terminate",
  portalLinks: "portal:links",
  portalAny: "portal:any",
  qa: "qa:queue",
  skillsRead: "skills:read",
  kitsWrite: "kits:write",
  roiRead: "roi:read",
  roiWrite: "roi:write",
  crm: "crm:manage",
  drafts: "drafts:manage",
  standup: "standup:manage",
} as const;

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  GROWTH_OPS: "Growth Ops",
  SALES_OPS: "Sales Ops",
  CLIENT_OWNER: "Business Owner",
};

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  clientId: string | null;
  clientSlug: string | null;
  permissions: string[];
}

export interface OtpRequested {
  channel: string;
  expiresIn: number;
  /** Set only while delivery is simulated on a local install. */
  simulatedCode: string | null;
  detail: string;
}

interface UserWire {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  client_id: string | null;
  client_slug: string | null;
  permissions: string[];
}

function toUser(wire: UserWire): SessionUser {
  return {
    id: wire.id,
    email: wire.email,
    fullName: wire.full_name,
    role: wire.role,
    clientId: wire.client_id,
    clientSlug: wire.client_slug,
    permissions: wire.permissions,
  };
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload as T;
  const failure = (payload ?? {}) as { error?: string; detail?: unknown };
  throw new ApiError(
    response.status,
    failure.error ?? `http_${response.status}`,
    typeof failure.detail === "string" ? failure.detail : "That did not work. Please try again.",
  );
}

/** `subdomain` scopes a business sign-in: only that business's owner gets in. */
export async function login(email: string, password: string, subdomain?: string): Promise<SessionUser> {
  const body = await post<{ user: UserWire }>("login", { email, password, ...(subdomain ? { subdomain } : {}) });
  return toUser(body.user);
}

export async function requestOtp(identifier: string, subdomain?: string): Promise<OtpRequested> {
  const body = await post<{ channel: string; expires_in: number; simulated_code: string | null; detail: string }>(
    "magic-otp/request",
    { identifier, ...(subdomain ? { subdomain } : {}) },
  );
  return { channel: body.channel, expiresIn: body.expires_in, simulatedCode: body.simulated_code, detail: body.detail };
}

export async function verifyOtp(identifier: string, code: string, subdomain?: string): Promise<SessionUser> {
  const body = await post<{ user: UserWire }>("magic-otp/verify", {
    identifier,
    code,
    ...(subdomain ? { subdomain } : {}),
  });
  return toUser(body.user);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await post("change-password", { current_password: currentPassword, new_password: newPassword });
}

export async function logout(): Promise<void> {
  await post("logout").catch(() => undefined);
}

/** An unread body keeps its connection open, and a browser only gets six per host. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

let refreshing: Promise<boolean> | null = null;

/** Shared, so a page's parallel requests that all see a 401 only renew once. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${BASE}/refresh`, { method: "POST" })
    .then(async (response) => {
      await discardBody(response);
      return response.ok;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** The signed-in user, or null when there is no session. Throws when the hub cannot say. */
export async function fetchMe(): Promise<SessionUser | null> {
  const read = () => fetch(`${BASE}/me`, { signal: AbortSignal.timeout(12_000) });
  let response: Response;
  try {
    response = await read();
    if (response.status === 401) {
      await discardBody(response);
      if (!(await refreshSession())) return null;
      response = await read();
    }
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the server.");
  }
  if (!response.ok) {
    await discardBody(response);
    if (response.status === 401) return null;
    throw new ApiError(response.status, `http_${response.status}`, "Could not read your session.");
  }
  return toUser((await response.json()) as UserWire);
}

/**
 * A full page load on purpose: it drops secrets held in memory on the way out, and
 * lets the route guard see the new cookies on the way in.
 */
export function goTo(path: string): void {
  window.location.assign(path);
}

export function homeFor(user: SessionUser): string {
  if (user.role === "CLIENT_OWNER") return user.clientSlug ? `/portal/${user.clientSlug}` : "/";
  return "/admin";
}

/** Only a path on this site: `next` comes from the URL, so it could point anywhere. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : null;
}
