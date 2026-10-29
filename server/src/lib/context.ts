import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { unauthorized } from "./errors.js";

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  status: string;
  is_system_admin: boolean;
}

/** Request metadata recorded with every audit row. */
export interface AuditContext {
  actorId: string | null;
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
}

export function auditContext(req: FastifyRequest): AuditContext {
  return {
    actorId: req.user?.id ?? null,
    requestId: req.id,
    ipHash: req.ip ? createHash("sha256").update(`ttc:${req.ip}`).digest("hex").slice(0, 32) : null,
    userAgent: summarizeUserAgent(req.headers["user-agent"]),
  };
}

export function summarizeUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Other";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Other";
  return `${browser} on ${os}`;
}

export function requireUser(user: AuthUser | null): AuthUser {
  if (!user) throw unauthorized();
  return user;
}
