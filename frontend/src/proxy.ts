import { NextResponse, type NextRequest } from "next/server";

/**
 * The route guard. It sends people to the right page, and that is all it does.
 *
 * It reads the session cookie's claims without verifying the signature, because
 * the signing key stays on the hub. That is safe because these pages are empty
 * shells: every figure they show comes from the hub, which checks the signature,
 * the role and the tenant on each request. A forged cookie gets a blank page.
 *
 * /portal/* stays open to signed-out visitors on purpose. An owner's access link
 * carries its token in the URL fragment, which never reaches the server, so this
 * cannot tell a link from a stranger, and the page itself decides who gets in.
 */

interface Claims {
  role: string;
  tenant: string | null;
  exp: number;
}

function readClaims(token: string | undefined, now: number): Claims | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Partial<Claims>;
    if (typeof claims.role !== "string" || typeof claims.exp !== "number" || claims.exp <= now) return null;
    return { role: claims.role, tenant: claims.tenant ?? null, exp: claims.exp };
  } catch {
    return null;
  }
}

function homeFor(claims: Claims): string {
  if (claims.role === "CLIENT_OWNER") return claims.tenant ? `/portal/${claims.tenant}` : "/";
  return "/admin";
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const now = Date.now() / 1000;
  const claims =
    readClaims(request.cookies.get("hub_access")?.value, now) ??
    // An expired access token with a live refresh token is still a session: the
    // page renews it on its first request.
    readClaims(request.cookies.get("hub_refresh")?.value, now);

  const redirect = (path: string) => NextResponse.redirect(new URL(path, request.url));

  if (pathname === "/login") {
    return claims ? redirect(homeFor(claims)) : NextResponse.next();
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!claims) {
      // ?preview shows the sample console when the hub is down. With the hub up,
      // the page finds there is no session and sends the visitor back to sign in.
      const noHub = !process.env.PORTAL_HUB_URL && !process.env.NEXT_PUBLIC_API_URL;
      if (noHub || request.nextUrl.searchParams.has("preview")) return NextResponse.next();
      return redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
    }
    return claims.role === "CLIENT_OWNER" ? redirect(homeFor(claims)) : NextResponse.next();
  }

  if (pathname.startsWith("/portal/") && claims) {
    const slug = pathname.split("/")[2];
    if (claims.role === "CLIENT_OWNER" && claims.tenant !== slug) return redirect(homeFor(claims));
    if (claims.role === "SALES_OPS") return redirect("/admin");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/login", "/admin", "/admin/:path*", "/portal/:path*"],
};
