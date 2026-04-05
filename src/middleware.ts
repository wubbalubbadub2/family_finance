import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/auth/session';

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isValid = await verifySession(token);

  if (isValid) return NextResponse.next();

  // API routes: return 401 JSON
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Page routes: redirect to /login
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

// Exclude login flow, telegram webhook, cron jobs, and static assets
export const config = {
  matcher: [
    '/((?!login|api/auth|api/telegram|api/cron|_next/static|_next/image|favicon.ico|manifest.json).*)',
  ],
};
