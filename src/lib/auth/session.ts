// Session helpers using Web Crypto API (works in Node + Edge runtime)

const COOKIE_NAME = 'fb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('Missing SESSION_SECRET env var');
  return secret;
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sign a new session. Returns `expires|signature`.
 */
export async function signSession(): Promise<string> {
  const expires = Date.now() + SESSION_TTL_MS;
  const sig = await hmacSha256(getSecret(), String(expires));
  return `${expires}|${sig}`;
}

/**
 * Verify a session token. Returns true if signature is valid and not expired.
 */
export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('|');
  if (parts.length !== 2) return false;
  const [expiresStr, sig] = parts;
  const expires = parseInt(expiresStr, 10);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;

  try {
    const expected = await hmacSha256(getSecret(), expiresStr);
    if (sig.length !== expected.length) return false;
    // Constant-time comparison
    let mismatch = 0;
    for (let i = 0; i < sig.length; i++) {
      mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return mismatch === 0;
  } catch {
    return false;
  }
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
