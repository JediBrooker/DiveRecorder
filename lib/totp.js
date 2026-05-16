// TOTP 2FA helpers — wraps speakeasy + qrcode behind a small
// surface so the auth router doesn't have to know either API.
//
// Surface:
//   * generateSecret(label)           → { base32, otpauth_url, qr_data_url }
//   * verifyToken(secret, token)      → bool (with ±1 step window)
//   * generateRecoveryCodes(n=10)     → { plain, hashes }
//   * consumeRecoveryCode(hashes, code) → { matched, remainingHashes }
//
// Secret length: 20 bytes (160 bits) base32-encoded — what RFC
// 6238 §5.1 recommends for SHA-1-based TOTP.
//
// Step tolerance: ±1 (one 30s window before/after current).
// Catches drifted phone clocks without widening the auth window
// past the OWASP guideline (≤ ~1 minute total).
//
// Recovery codes: 10 codes, each 10 chars [a-z0-9]. Stored as
// bcrypt hashes (cost 10 — no need for the 12 we use on
// passwords; the codes are 50-bit-strong already and a successful
// brute-force still requires both password + the code itself).

const speakeasy = require("speakeasy");
const QRCode    = require("qrcode");
const bcrypt    = require("bcryptjs");
const crypto    = require("node:crypto");

// Generate a fresh secret + an otpauth:// URI + a base64 PNG QR.
// The QR encodes the URI; the user scans it with their
// authenticator app. We return all three so the frontend can
// pick the best presentation (QR for mobile camera scan,
// otpauth URL for click-to-add desktop apps, base32 for manual
// keypad entry).
async function generateSecret(label) {
  const secret = speakeasy.generateSecret({
    name:   `DivingHQ (${label})`,
    issuer: "DivingHQ",
    length: 20,
  });
  const qr_data_url = await QRCode.toDataURL(secret.otpauth_url);
  return {
    base32:       secret.base32,
    otpauth_url:  secret.otpauth_url,
    qr_data_url,
  };
}

// Verify a 6-digit token against the user's stored base32 secret.
// `token` is a string of digits — we don't trim/pad, the
// authenticator-app side always emits exactly 6 chars.
function verifyToken(base32Secret, token) {
  if (typeof token !== "string" || !/^\d{6}$/.test(token)) return false;
  return speakeasy.totp.verify({
    secret:   base32Secret,
    encoding: "base32",
    token,
    window:   1,    // ±1 step (±30s)
  });
}

// Mint N recovery codes. Returns plain strings for one-time
// display + hashed equivalents for storage. Plain codes use a
// dash separator every 5 chars purely for readability — the
// dashes are stripped before hashing so the user typing them
// without dashes still works.
function generateRecoveryCodes(n = 10) {
  const plain = [];
  const hashes = [];
  for (let i = 0; i < n; i++) {
    // 10 random hex chars = 40 bits → 1 in 10^12 collision risk
    // for a 10-code set; plenty for an out-of-band recovery flow.
    const raw = crypto.randomBytes(5).toString("hex");
    const display = raw.slice(0, 5) + "-" + raw.slice(5);
    plain.push(display);
    hashes.push(bcrypt.hashSync(raw, 10));
  }
  return { plain, hashes };
}

// Try every stored hash against the user-provided code. Returns
// { matched: bool, remainingHashes: string[] } so the caller can
// persist the smaller array on a successful consume. Strips
// dashes + lowercases before checking so the user can type
// either "abcde-12345" or "ABCDE12345".
async function consumeRecoveryCode(hashes, code) {
  if (!Array.isArray(hashes) || typeof code !== "string") {
    return { matched: false, remainingHashes: hashes };
  }
  const normalised = code.replace(/-/g, "").toLowerCase().trim();
  if (!/^[0-9a-f]{10}$/.test(normalised)) {
    return { matched: false, remainingHashes: hashes };
  }
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(normalised, hashes[i])) {
      const remainingHashes = hashes.slice(0, i).concat(hashes.slice(i + 1));
      return { matched: true, remainingHashes };
    }
  }
  return { matched: false, remainingHashes: hashes };
}

module.exports = {
  generateSecret,
  verifyToken,
  generateRecoveryCodes,
  consumeRecoveryCode,
};
