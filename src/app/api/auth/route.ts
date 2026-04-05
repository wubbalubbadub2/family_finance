import { NextRequest, NextResponse } from 'next/server';
import { signSession, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@/lib/auth/session';

export async function POST(req: NextRequest) {
  let pin: string | undefined;
  try {
    const body = await req.json();
    pin = body.pin;
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const expectedPin = process.env.DASHBOARD_PIN;
  if (!expectedPin) {
    return NextResponse.json({ error: 'PIN not configured on server' }, { status: 500 });
  }

  if (!pin || pin !== expectedPin) {
    return NextResponse.json({ error: 'Неверный PIN' }, { status: 401 });
  }

  const token = await signSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
