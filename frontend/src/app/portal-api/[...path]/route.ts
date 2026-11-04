import type { NextRequest } from "next/server";

/**
 * Same-origin door to the hub's portal routes, and nothing else on the hub.
 *
 * Client browsers talk to this frontend, so the hub stays off the public internet
 * and its address stays out of the bundle and the network tab. The path prefix is
 * fixed and each segment is checked, so no request can climb to the admin API.
 */

const HUB_URL = (process.env.PORTAL_HUB_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Longer than the hub's own chat timeout, so the hub reports that failure itself. */
const TIMEOUT_MS = 130_000;

/** The one signal the client treats as "no backend": everything else is a real answer. */
function unavailable() {
  return Response.json(
    { error: "portal_backend_unavailable", detail: "The portal service is unavailable." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!HUB_URL) return unavailable();

  const { path } = await context.params;
  if (!path.every((segment) => SAFE_SEGMENT.test(segment) && !segment.includes(".."))) {
    return Response.json({ error: "not_found", detail: "Not found." }, { status: 404 });
  }

  const headers: Record<string, string> = {};
  const token = request.headers.get("x-client-portal-token");
  if (token) headers["X-Client-Portal-Token"] = token;
  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  let upstream: Response;
  try {
    upstream = await fetch(`${HUB_URL}/api/v1/portal/${path.join("/")}`, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unavailable();
  }

  // Only the status and body cross: upstream headers name the server software.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
