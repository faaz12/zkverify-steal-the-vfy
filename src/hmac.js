// HMAC helpers for the zkVerify Agent Games platform.
//
// The platform signs incoming turn envelopes with the
// `x-agent-games-signature` header and expects our responses signed the
// same way, with the 32-byte secret issued once at agent registration.
//
// The exact scheme is NOT documented publicly. Default assumption: hex
// HMAC-SHA256 over the raw body. The scheme lives in ONE place here so it
// can be swapped after preflight:
//   HMAC_SCHEME=hex     -> hex digest (default), accepts an optional `sha256=` prefix
//   HMAC_SCHEME=base64  -> base64 digest
// Set the env var to switch; verifyHmac/signHmac always use the same scheme.
//
// NOTE: this agent gets its OWN HMAC secret at registration — do NOT reuse
// the Proof Gatekeeper secret (each registered agent has its own).
import crypto from 'node:crypto';

export const HMAC_SCHEME = process.env.HMAC_SCHEME || 'hex';

function digest(secret, rawBody) {
  const h = crypto.createHmac('sha256', secret);
  h.update(rawBody);
  return HMAC_SCHEME === 'base64' ? h.digest('base64') : h.digest('hex');
}

function normalise(signature) {
  if (!signature) return null;
  let s = String(signature).trim();
  if (s.toLowerCase().startsWith('sha256=')) s = s.slice(7);
  return s;
}

// Constant-time comparison. Returns false (never throws) on missing /
// malformed / length-mismatched signatures.
export function verifyHmac(secret, rawBody, signature) {
  const expected = digest(secret, rawBody);
  const provided = normalise(signature);
  if (!provided) return false;
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signHmac(secret, rawBody) {
  return digest(secret, rawBody);
}
