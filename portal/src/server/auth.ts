import type { FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { hashSecret, normalizeBadge, safeEqual } from "./credentials.js";

export interface LinkPrincipal { kind: "link"; employeeId: string; displayName: string }
export interface KioskPrincipal { kind: "kiosk"; kioskId: string; name: string }

const invalid = () => new ApiError(401, "INVALID_CREDENTIAL", "This link or device is not valid any more. Ask your manager for a new one.");

function credential(req: FastifyRequest, scheme: "Link" | "Kiosk" | "Bearer"): string {
  const header = req.headers.authorization ?? "";
  const [s, value] = header.split(" ", 2);
  if (s !== scheme || !value || value.length > 200) throw invalid();
  return value;
}

/** Personal link: the token alone identifies one employee. Only its SHA-256 hash is stored. */
export async function requireLink(db: Db, req: FastifyRequest): Promise<LinkPrincipal> {
  const token = credential(req, "Link");
  const { rows } = await db.query<{ id: string; display_name: string; link_enabled: boolean; active: boolean }>(
    `SELECT id, display_name, link_enabled, active FROM shift.employees WHERE link_token_hash = $1`,
    [hashSecret(token)],
  );
  const e = rows[0];
  if (!e || !e.active) throw invalid();
  if (!e.link_enabled) throw new ApiError(403, "LINK_DISABLED", "Personal links are turned off for you. Please use the kiosk.");
  return { kind: "link", employeeId: e.id, displayName: e.display_name };
}

export async function requireKiosk(db: Db, req: FastifyRequest): Promise<KioskPrincipal> {
  const token = credential(req, "Kiosk");
  const { rows } = await db.query<{ id: string; name: string }>(
    `UPDATE shift.kiosks SET last_seen_at = now() WHERE token_hash = $1 AND active RETURNING id, name`,
    [hashSecret(token)],
  );
  if (!rows[0]) throw invalid();
  return { kind: "kiosk", kioskId: rows[0].id, name: rows[0].name };
}

/** Badge codes are only meaningful together with a paired kiosk token. */
export async function employeeByBadge(db: Db, badge: string) {
  const { rows } = await db.query<{ id: string; display_name: string; kiosk_enabled: boolean; active: boolean; state: string; state_since: Date | null }>(
    `SELECT id, display_name, kiosk_enabled, active, state, state_since FROM shift.employees WHERE badge_code_hash = $1`,
    [hashSecret(normalizeBadge(badge))],
  );
  const e = rows[0];
  if (!e || !e.active || !e.kiosk_enabled) throw new ApiError(404, "BADGE_NOT_RECOGNISED", "Badge not recognised. Try again or ask your manager.");
  return e;
}

export function requireApiKey(apiKey: string, req: FastifyRequest): void {
  const header = req.headers.authorization ?? "";
  const [s, value] = header.split(" ", 2);
  if (s !== "Bearer" || !value || !safeEqual(value, apiKey)) throw new ApiError(401, "INVALID_API_KEY", "A valid API key is required.");
}
