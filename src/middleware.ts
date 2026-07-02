import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { backendOnlyRedirect, PRODUCTION_FRONTEND_URL } from "@/lib/backend-redirect";

// Auth middleware — refreshes the Supabase session cookie on every request AND
// protects the app routes: no session → bounced to /sign-in. This is what makes
// the dashboard genuinely gated (not just a client-side redirect that a URL can
// skip).
//
// BACKEND-ONLY MODE (Fly): when BACKEND_ONLY=1 is set, this deployment is a pure
// agent backend. Any request whose path is NOT under /api/ is redirected (308) to
// the Vercel frontend (FRONTEND_URL). Only /api/* (especially /api/agent) is served
// here. This flag is set on the Fly app only — never on Vercel.
const PROTECTED = ["/dashboard", "/sources", "/settings", "/history", "/account"];

export async function middleware(request: NextRequest) {
  // BACKEND-ONLY redirect — must happen before any Supabase work (no cookies needed).
  if (process.env.BACKEND_ONLY === "1") {
    const path = request.nextUrl.pathname;
    const dest = backendOnlyRedirect(
      path,
      true,
      process.env.FRONTEND_URL ?? PRODUCTION_FRONTEND_URL
    );
    if (dest) {
      return NextResponse.redirect(dest, { status: 308 });
    }
    // /api/* passes through — no auth redirect, no cookie gymnastics.
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: getUser() (not getSession()) validates the token with the auth
  // server, so a revoked/expired session is actually rejected — this is what makes
  // admin "deactivate → kicked out" real on the next request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(p + "/"));

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // IMMEDIATE kick-out: a Supabase ban blocks new sign-ins but an already-issued
  // access token stays valid until it expires. So we ALSO check profiles.disabled
  // (a user can read their own row via RLS) on every protected request — a
  // disabled user is signed out + bounced NOW, regardless of token TTL.
  if (isProtected && user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("disabled")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.disabled) {
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = "/sign-in";
      url.searchParams.set("disabled", "1");
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  // Run on app routes; skip static assets + the auth API.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
