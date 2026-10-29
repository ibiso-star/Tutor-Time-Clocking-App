import { describe, expect, it } from "vitest";
import { escapeCsvCell, toCsv } from "../../src/domain/csv.js";
import { DEFAULT_SETTINGS, isValidTimezone, parseSettings, projectSettingsSchema } from "../../src/domain/policy.js";

describe("CSV escaping", () => {
  it.each(["=SUM(A1:A2)", "+1", "-2+3", "@cmd", "\tx", "\rx"])("neutralises formula-leading %j", (v) => {
    expect(escapeCsvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  it("leaves numeric values and plain text alone", () => {
    expect(escapeCsvCell(-15)).toBe("-15");
    expect(escapeCsvCell("Ada Lovelace")).toBe("Ada Lovelace");
  });
  it("quotes commas, quotes and newlines", () => {
    expect(escapeCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(toCsv(["h1", "h2"], [["x", 1]])).toBe("h1,h2\r\nx,1\r\n");
  });
});

describe("project policy", () => {
  it("defaults sensitive collection to off", () => {
    expect(DEFAULT_SETTINGS.location_controls.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.photo_capture.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.device_binding.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.rounding.mode).toBe("none");
  });
  it("refuses to enable phase-gated features", () => {
    const r = projectSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, photo_capture: { enabled: true } });
    expect(r.success).toBe(false);
  });
  it("fills defaults for partial stored settings", () => {
    expect(parseSettings({ max_shift_minutes: 480 }).max_shift_minutes).toBe(480);
    expect(parseSettings({}).breaks.enabled).toBe(true);
  });
  it("accepts IANA zones and rejects fixed offsets", () => {
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("UTC+5")).toBe(false);
    expect(isValidTimezone("+05:00")).toBe(false);
    expect(isValidTimezone("Mars/Base")).toBe(false);
  });
});
