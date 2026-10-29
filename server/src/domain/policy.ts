import { z } from "zod";
import { IANAZone } from "luxon";

/**
 * Project policy. Sensitive collection (location coordinates, photo, device binding) is off by default.
 * Photo capture and device binding are phase-gated: they are not implemented in this release, so the
 * schema only accepts `false` until legal/privacy review approves them (PRD §6).
 */
export const roundingPolicySchema = z.object({
  mode: z.enum(["none", "nearest", "up", "down"]),
  increment_minutes: z.union([z.literal(1), z.literal(5), z.literal(6), z.literal(10), z.literal(15)]),
});
export type RoundingPolicy = z.infer<typeof roundingPolicySchema>;

export const projectSettingsSchema = z
  .object({
    breaks: z.object({
      enabled: z.boolean(),
      /** require_end: tutor must end break before clocking out. allow_combined: offer an explicit
       *  "End break and clock out" action that records both events. Never inferred silently. */
      clock_out_while_on_break: z.enum(["require_end", "allow_combined"]),
      max_break_minutes: z.number().int().positive().max(24 * 60).nullable(),
    }),
    rounding: roundingPolicySchema,
    max_shift_minutes: z.number().int().min(15).max(24 * 60),
    confirm_clock_out: z.boolean(),
    require_location: z.boolean(),
    location_controls: z.object({
      /** When true, the client may send coordinates at clock-in only and geofence modes apply. */
      enabled: z.boolean(),
    }),
    photo_capture: z.object({ enabled: z.literal(false) }),
    device_binding: z.object({ enabled: z.literal(false) }),
    offline_sync: z.object({ enabled: z.literal(false) }),
    alerts: z.object({
      long_session: z.boolean(),
      missed_clock_out: z.boolean(),
    }),
    correction_service_target_hours: z.number().int().positive().max(24 * 30),
  })
  .strict();
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const DEFAULT_SETTINGS: ProjectSettings = {
  breaks: { enabled: true, clock_out_while_on_break: "require_end", max_break_minutes: 60 },
  rounding: { mode: "none", increment_minutes: 1 },
  max_shift_minutes: 600,
  confirm_clock_out: false,
  require_location: false,
  location_controls: { enabled: false },
  photo_capture: { enabled: false },
  device_binding: { enabled: false },
  offline_sync: { enabled: false },
  alerts: { long_session: true, missed_clock_out: true },
  correction_service_target_hours: 72,
};

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz) && !/^(UTC|GMT)?[+-]\d/.test(tz);
}

export const timezoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimezone, { message: "Use an IANA timezone name such as America/Los_Angeles." });

/** Settings with defaults filled in, tolerant of rows written by older versions. */
export function parseSettings(raw: unknown): ProjectSettings {
  const merged = deepMerge(DEFAULT_SETTINGS, (raw ?? {}) as Record<string, unknown>);
  return projectSettingsSchema.parse(merged);
}

function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object") {
      out[key] = deepMerge(current, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function describeRounding(policy: RoundingPolicy): string {
  if (policy.mode === "none") return "Exact (no rounding)";
  const verb = policy.mode === "nearest" ? "Nearest" : policy.mode === "up" ? "Up to" : "Down to";
  return `${verb} ${policy.increment_minutes} min per session`;
}
