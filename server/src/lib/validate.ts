import type { z } from "zod";
import { ApiError } from "./errors.js";

/** Parses input with a zod schema, converting failures into a structured 400 with field messages. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_";
    fields[key] ??= issue.message;
  }
  const first = Object.values(fields)[0] ?? "Invalid input.";
  throw new ApiError(400, "VALIDATION_ERROR", first, { fields });
}
