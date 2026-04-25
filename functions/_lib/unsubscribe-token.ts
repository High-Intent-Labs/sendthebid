// HMAC-signed unsubscribe tokens. Used by:
// - functions/api/email-scheduler.ts (mints tokens, builds the unsub URL)
// - functions/api/email-unsubscribe.ts (verifies tokens before suppressing)
//
// Token format: "<email-base64url>.<hmac-base64url>"
// HMAC algorithm: HMAC-SHA256 over the email, keyed by env.UNSUBSCRIBE_SIGNING_KEY.
// No expiry — unsubscribe links are persistent on purpose. Every email a user
// receives has the same token for that email address; clicking the link in
// any email permanently suppresses future sends.

const enc = new TextEncoder();

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** Mint an unsub token for `email`. */
export async function mintUnsubscribeToken(email: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const emailBytes = enc.encode(email.toLowerCase());
  const sig = await crypto.subtle.sign('HMAC', key, emailBytes as BufferSource);
  return `${bytesToBase64Url(emailBytes)}.${bytesToBase64Url(sig)}`;
}

/** Verify a token. Returns the email if valid, null otherwise. */
export async function verifyUnsubscribeToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let emailBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    emailBytes = base64UrlToBytes(parts[0]);
    sigBytes = base64UrlToBytes(parts[1]);
  } catch {
    return null;
  }
  const email = new TextDecoder().decode(emailBytes);
  const key = await importKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as BufferSource,
    enc.encode(email.toLowerCase()) as BufferSource
  );
  return ok ? email : null;
}

/** Build the full unsubscribe URL for a given email. */
export async function buildUnsubscribeUrl(email: string, secret: string): Promise<string> {
  const token = await mintUnsubscribeToken(email, secret);
  // Hard-coded host: this URL ships in transactional email bodies, so we want
  // it stable regardless of the request that's running the scheduler.
  return `https://nailthequote.com/api/email-unsubscribe?token=${token}`;
}
