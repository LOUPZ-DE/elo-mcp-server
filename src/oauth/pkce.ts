import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 7636 §4.1 defines the verifier's alphabet and length. Checking it before
// hashing means a malformed verifier is rejected as such instead of silently
// failing the comparison further down.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** URL-safe random string. 32 bytes → 43 characters. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** RFC 7636 §4.6: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = Buffer.from(s256Challenge(verifier));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
