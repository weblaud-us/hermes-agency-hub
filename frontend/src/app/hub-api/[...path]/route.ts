import type { NextRequest } from "next/server";
import { forwardToHub, notFound, safePath } from "@/lib/hub-proxy";

/**
 * Same-origin door to the hub's team routes.
 *
 * It carries the session cookie and nothing more. The hub decides what each role
 * may do, so this holds no permission logic of its own, and it deliberately never
 * forwards X-API-Key: the admin key is for scripts talking to the hub directly.
 */

const ALLOWED = new Set(["auth", "clients", "qa", "crm", "kits", "skills"]);
const TIMEOUT_MS = 130_000;
/** Onboarding is one synchronous request, including the tenant's health probe. */
const ONBOARD_TIMEOUT_MS = 15 * 60_000;

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!safePath(path)) return notFound();
  if (path.length === 1 && path[0] === "healthz") {
    return forwardToHub(request, "/healthz", { timeoutMs: 5000 });
  }
  if (!ALLOWED.has(path[0])) return notFound();

  const onboarding = path[0] === "clients" && path[1] === "onboard";
  return forwardToHub(request, `/api/v1/${path.join("/")}`, {
    timeoutMs: onboarding ? ONBOARD_TIMEOUT_MS : TIMEOUT_MS,
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
