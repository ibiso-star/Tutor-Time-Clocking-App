import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditContext, requireUser } from "../lib/context.js";
import { badRequest } from "../lib/errors.js";
import { parse } from "../lib/validate.js";
import { executeClock, timeStatus } from "../services/clock.js";
import { loadProject } from "../services/access.js";

const clockSchema = z.object({
  project_id: z.uuid(),
  event_type: z.enum(["CLOCK_IN", "CLOCK_OUT", "BREAK_START", "BREAK_END"]),
  location_id: z.uuid().nullish(),
  shift_id: z.uuid().nullish(),
  end_open_break: z.boolean().optional(),
  client_captured_at: z.iso.datetime({ offset: true }).nullish(),
  coords: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracy_m: z.number().min(0).max(100000).nullish(),
    })
    .nullish(),
});

export async function clockRoutes(app: FastifyInstance) {
  app.post("/v1/clock-events", async (req, reply) => {
    const user = requireUser(req.user);
    app.limiter.check("clock", user.id, 30, 60_000);
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !z.uuid().safeParse(key).success) {
      throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "Send a UUID Idempotency-Key header with each clock action.");
    }
    const body = parse(clockSchema, req.body);
    const result = await executeClock(app.db, auditContext(req), user, { ...body, idempotency_key: key });
    const project = await loadProject(app.db, body.project_id);
    const status = await timeStatus(app.db, user.id, project, new Date());
    reply.status(result.replayed ? 200 : 201);
    return { ...result, status };
  });
}
