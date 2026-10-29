import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { hashPassword, hashToken, passwordProblem, randomToken, verifyPassword } from "../auth/password.js";
import { ApiError, badRequest, unauthorized } from "../lib/errors.js";
import { auditContext, requireUser, summarizeUserAgent } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { writeAudit } from "../services/audit.js";

export const SESSION_COOKIE = "ttc_session";
const RESET_TTL_MINUTES = 30;
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password.").max(200),
});

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.env === "production",
      path: "/",
      maxAge: config.sessionTtlHours * 3600,
    });

  app.post("/v1/auth/login", async (req, reply) => {
    app.limiter.check("login-ip", req.ip, 30, 15 * 60_000);
    const body = parse(loginSchema, req.body);
    app.limiter.check("login-email", body.email, 10, 15 * 60_000);
    const { rows } = await db.query(
      `SELECT u.id, u.status, c.password_hash, c.failed_attempts, c.locked_until
         FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
        WHERE lower(u.email) = $1`,
      [body.email],
    );
    const user = rows[0];
    const invalid = () => new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    if (!user?.password_hash) {
      await verifyPassword(body.password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA"); // equalize timing
      throw invalid();
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new ApiError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later or reset your password.");
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) {
      await db.query(
        `UPDATE user_credentials SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
          WHERE user_id = $1`,
        [user.id, MAX_FAILED, LOCK_MINUTES],
      );
      throw invalid();
    }
    if (user.status !== "active") {
      throw new ApiError(403, "ACCOUNT_INACTIVE", "Your account is not active. Contact your supervisor for help with any open time records.");
    }
    const token = randomToken();
    const csrf = randomToken(24);
    await withTransaction(db, async (tx) => {
      await tx.query(`UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`, [user.id]);
      await tx.query(
        `INSERT INTO auth_sessions (token_hash, user_id, csrf_token, expires_at, user_agent_summary)
         VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5)`,
        [hashToken(token), user.id, csrf, config.sessionTtlHours, summarizeUserAgent(req.headers["user-agent"])],
      );
      await writeAudit(tx, { ...auditContext(req), actorId: user.id }, { projectId: null, action: "auth.login", targetType: "user", targetId: user.id });
    });
    setCookie(reply, token);
    return { ok: true, csrf_token: csrf };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    if (req.authSessionId) {
      await db.query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1`, [req.authSessionId]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/v1/auth/password-reset/request", async (req, reply) => {
    app.limiter.check("reset-ip", req.ip, 10, 15 * 60_000);
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email address.") }), req.body);
    const { rows } = await db.query<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM users WHERE lower(email) = $1`,
      [body.email],
    );
    const user = rows[0];
    if (user && (user.status === "active" || user.status === "invited")) {
      const token = randomToken();
      await withTransaction(db, async (tx) => {
        await tx.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
        await tx.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
          [user.id, hashToken(token), RESET_TTL_MINUTES],
        );
        await writeAudit(tx, { ...auditContext(req), actorId: null }, { projectId: null, action: "auth.password_reset_requested", targetType: "user", targetId: user.id });
      });
      await app.mailer.send({
        to: user.email,
        subject: "Reset your Tutor Time Clock password",
        text: `Use this link within ${RESET_TTL_MINUTES} minutes to set a new password:\n${config.appBaseUrl}/reset-password?token=${token}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    }
    // Same response whether or not the account exists, to avoid account enumeration.
    reply.status(202);
    return { ok: true, message: "If that email has an account, a reset link is on its way." };
  });

  app.post("/v1/auth/password-reset/confirm", async (req) => {
    app.limiter.check("reset-confirm-ip", req.ip, 20, 15 * 60_000);
    const body = parse(z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }), req.body);
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest("WEAK_PASSWORD", problem);
    const hash = await hashPassword(body.password);
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [hashToken(body.token)],
      );
      const t = rows[0];
      if (!t) throw badRequest("INVALID_TOKEN", "This reset link is invalid or has expired. Request a new one.");
      await tx.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [t.id]);
      await tx.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_updated_at = now(),
                                             failed_attempts = 0, locked_until = NULL`,
        [t.user_id, hash],
      );
      await tx.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'invited'`, [t.user_id]);
      // Sign out everywhere after a reset.
      await tx.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
      await writeAudit(tx, { ...auditContext(req), actorId: t.user_id }, { projectId: null, action: "auth.password_reset_completed", targetType: "user", targetId: t.user_id });
    });
    return { ok: true };
  });

  app.post("/v1/auth/change-password", async (req) => {
    const user = requireUser(req.user);
    const body = parse(z.object({ current_password: z.string().max(200), new_password: z.string().max(200) }), req.body);
    const { rows } = await db.query<{ password_hash: string }>(`SELECT password_hash FROM user_credentials WHERE user_id = $1`, [user.id]);
    if (!rows[0] || !(await verifyPassword(body.current_password, rows[0].password_hash))) {
      throw unauthorized("Your current password is incorrect.");
    }
    const problem = passwordProblem(body.new_password);
    if (problem) throw badRequest("WEAK_PASSWORD", problem);
    const hash = await hashPassword(body.new_password);
    await withTransaction(db, async (tx) => {
      await tx.query(`UPDATE user_credentials SET password_hash = $2, password_updated_at = now() WHERE user_id = $1`, [user.id, hash]);
      await tx.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, req.authSessionId]);
      await writeAudit(tx, auditContext(req), { projectId: null, action: "auth.password_changed", targetType: "user", targetId: user.id });
    });
    return { ok: true };
  });
}
