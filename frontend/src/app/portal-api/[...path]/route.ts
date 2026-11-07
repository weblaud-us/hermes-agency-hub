import type { NextRequest } from "next/server";
import { forwardToHub, notFound, safePath } from "@/lib/hub-proxy";

/** Same-origin door to the hub's portal routes, and nothing else on the hub. */

/** Longer than the hub's own chat timeout, so the hub reports that failure itself. */
const TIMEOUT_MS = 130_000;

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (!safePath(path)) return notFound();

  const token = request.headers.get("x-client-portal-token");
  return forwardToHub(request, `/api/v1/portal/${path.join("/")}`, {
    timeoutMs: TIMEOUT_MS,
    extraHeaders: token ? { "X-Client-Portal-Token": token } : {},
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
