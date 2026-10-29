import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditContext, requireUser } from "../../lib/context.js";
import { notFound } from "../../lib/errors.js";
import { parse } from "../../lib/validate.js";
import { isUuid } from "../../services/access.js";
import { createExport, downloadExport, exportInputSchema, getExport, listExports, previewExport } from "../../services/exports.js";

export async function exportRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post("/v1/admin/exports/preview", async (req) => {
    const user = requireUser(req.user);
    return previewExport(db, user, parse(exportInputSchema, req.body));
  });

  app.post("/v1/admin/exports", async (req, reply) => {
    const user = requireUser(req.user);
    app.limiter.check("exports", user.id, 30, 60 * 60_000);
    const job = await createExport(db, auditContext(req), user, parse(exportInputSchema, req.body));
    reply.status(201);
    return job;
  });

  app.get("/v1/admin/exports", async (req) => {
    const user = requireUser(req.user);
    const q = parse(z.object({ project_id: z.uuid() }), req.query);
    return { exports: await listExports(db, user, q.project_id) };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/exports/:id", async (req) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Export not found.");
    const job = await getExport(db, user, req.params.id);
    return { ...job, download_url: job.status === "completed" ? `/v1/admin/exports/${job.id}/download` : null };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/exports/:id/download", async (req, reply) => {
    const user = requireUser(req.user);
    if (!isUuid(req.params.id)) throw notFound("Export not found.");
    const job = await downloadExport(db, auditContext(req), user, req.params.id);
    reply
      .header("content-type", job.content_type)
      .header("content-disposition", `attachment; filename="${job.file_name}"`)
      .header("x-checksum-sha256", job.checksum);
    return reply.send(job.file_content);
  });
}
