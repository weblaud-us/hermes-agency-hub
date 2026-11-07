import type { NextRequest } from "next/server";

/**
 * Shared by the two same-origin doors to the hub, /portal-api and /hub-api.
 *
 * Browsers only ever talk to this frontend, so the hub stays off the public
 * internet, its address stays out of the bundle, and the session cookies live on
 * this origin where the route guard in proxy.ts can see them. Each door fixes its
 * own path prefix, and every segment is checked, so no request can climb out of it.
 */

export const HUB_URL = (process.env.PORTAL_HUB_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_COOKIES = new Set(["hub_access", "hub_refresh"]);

/** The one signal the client treats as "no backend": everything else is a real answer. */
export function unavailable() {
  return Response.json(
    { error: "portal_backend_unavailable", detail: "The portal service is unavailable." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export function notFound() {
  return Response.json({ error: "not_found", detail: "Not found." }, { status: 404 });
}

export function safePath(path: string[]): boolean {
  return path.every((segment) => SAFE_SEGMENT.test(segment) && !segment.includes(".."));
}

/** Only the session cookies cross. Anything else on this origin is none of the hub's business. */
function sessionCookies(request: NextRequest): string | null {
  const pairs = request.cookies
    .getAll()
    .filter((cookie) => SESSION_COOKIES.has(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/**
 * Cookies are SameSite=Lax, but tenants live on sibling subdomains, which browsers
 * count as the same site. So a page on a tenant's subdomain could still POST here
 * with the owner's cookies, and the Origin check is what refuses it.
 */
function crossOrigin(request: NextRequest): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function forwardToHub(
  request: NextRequest,
  upstreamPath: string,
  { timeoutMs, extraHeaders = {} }: { timeoutMs: number; extraHeaders?: Record<string, string> },
): Promise<Response> {
  if (!HUB_URL) return unavailable();
  if (crossOrigin(request)) {
    return Response.json({ error: "cross_origin", detail: "That request was not allowed." }, { status: 403 });
  }

  const headers: Record<string, string> = { ...extraHeaders };
  // The hub rate-limits sign-in per caller, and from its side every request comes from this
  // server. The visitor's address, as our own reverse proxy saw it, is passed on for that.
  const visitor = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip");
  if (visitor) headers["X-Forwarded-For"] = visitor;
  const cookie = sessionCookies(request);
  if (cookie) headers.Cookie = cookie;
  const requestType = request.headers.get("content-type");
  if (requestType) headers["Content-Type"] = requestType;

  let upstream: Response;
  try {
    upstream = await fetch(`${HUB_URL}${upstreamPath}${request.nextUrl.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return unavailable();
  }

  // Only the status, the body and the session cookies cross: other upstream
  // headers name the server software.
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const isImage = contentType.startsWith("image/");
  const responseHeaders = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  if (isImage) {
    // Post visuals are served as images and must never be run as a page.
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    responseHeaders.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  for (const value of upstream.headers.getSetCookie()) responseHeaders.append("Set-Cookie", value);

  const nullBody = upstream.status === 204 || upstream.status === 304;
  // Images are bytes: reading one as text would corrupt it.
  const body = nullBody ? null : isImage ? await upstream.arrayBuffer() : await upstream.text();
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}
