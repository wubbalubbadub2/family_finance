import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// HTTP Basic Auth gate for /admin/* and /api/admin/*. Single-admin scenario,
// no NextAuth complexity. Credentials checked against ADMIN_USERNAME +
// ADMIN_PASSWORD env vars.
//
// Edge runtime — no Node `crypto`. Constant-time string compare written by
// hand (defends against timing attacks even though they're hypothetical here;
// costs nothing).

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function middleware(req: NextRequest) {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) {
    return new NextResponse('Admin auth not configured', { status: 503 });
  }

  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice('Basic '.length));
      const colon = decoded.indexOf(':');
      if (colon !== -1) {
        const user = decoded.slice(0, colon);
        const pass = decoded.slice(colon + 1);
        if (timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass)) {
          const res = NextResponse.next();
          res.headers.set('Cache-Control', 'no-store');
          return res;
        }
      }
    } catch {
      // bad base64 — fall through to 401
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"' },
  });
}

// Matcher is explicit — we DO NOT cover the user-facing dashboard at /, /transactions,
// etc. (those remain auth-less, same as before this PR). Only admin surface gets gated.
export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
