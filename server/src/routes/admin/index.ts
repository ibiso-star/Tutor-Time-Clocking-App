import type { FastifyInstance } from "fastify";
import { oversightRoutes } from "./oversight.js";
import { reviewRoutes } from "./review.js";
import { exportRoutes } from "./exports.js";
import { manageRoutes } from "./manage.js";

export async function adminRoutes(app: FastifyInstance) {
  await app.register(oversightRoutes);
  await app.register(reviewRoutes);
  await app.register(exportRoutes);
  await app.register(manageRoutes);
}
