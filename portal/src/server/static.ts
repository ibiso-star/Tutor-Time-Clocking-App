import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const SPA_ROUTES = new Set(["/", "/s", "/kiosk", "/admin"]);

export const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
  "media-src 'self' blob: mediastream:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Serves the built frontend for long-running deployments (no dependency; Vercel and other CDNs serve
 * the same files themselves). Hashed assets are cached forever; HTML is never cached.
 */
export function registerStatic(app: FastifyInstance, root: string) {
  const resolved = path.resolve(root);
  app.get("/*", async (req, reply) => {
    const urlPath = decodeURIComponent((req.url.split("?")[0] ?? "/").replace(/\/+$/, "") || "/");
    const file = SPA_ROUTES.has(urlPath) ? "index.html" : urlPath.slice(1);
    const full = path.resolve(resolved, file);
    if (!full.startsWith(resolved + path.sep)) return reply.code(404).send();
    try {
      const body = await readFile(full);
      const ext = path.extname(full);
      reply
        .header("content-type", TYPES[ext] ?? "application/octet-stream")
        .header("cache-control", file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store")
        .header("content-security-policy", CSP)
        .header("permissions-policy", urlPath === "/kiosk" ? "camera=(self), microphone=()" : "camera=(), microphone=()")
        .header("x-frame-options", "DENY");
      return reply.send(body);
    } catch {
      return reply.code(404).type("text/plain").send("Not found");
    }
  });
}
