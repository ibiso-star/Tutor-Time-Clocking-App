import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random token for personal links and kiosk pairing. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// Crockford base32: no I, L, O, U — easy to read aloud and type on a tablet.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 12-character badge code (60 bits), shown as XXXX-XXXX-XXXX. Only usable together with a kiosk token. */
export function newBadgeCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Accepts typed codes with any case, spaces or dashes, and common look-alike letters. */
export function normalizeBadge(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function hashIp(ip: string | undefined): string | null {
  return ip ? createHash("sha256").update(`shift:${ip}`).digest("hex").slice(0, 32) : null;
}
