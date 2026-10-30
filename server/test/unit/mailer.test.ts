import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createMailer, MailError, OutboxMailer, ResendMailer } from "../../src/lib/mailer.js";

const message = { to: "tutor@example.org", subject: "Hello", text: "Reset link: https://x/reset-password?token=secret" };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("ResendMailer", () => {
  it("posts the message to Resend with the API key", async () => {
    const f = fakeFetch(200, { id: "abc" });
    await new ResendMailer("re_key", "Clock <noreply@example.org>", f.impl).send(message);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ from: "Clock <noreply@example.org>", to: ["tutor@example.org"], subject: "Hello", text: message.text });
  });

  it("throws a MailError on rejection without echoing the message body", async () => {
    const f = fakeFetch(403, { name: "validation_error", message: "The domain is not verified." });
    const err = await new ResendMailer("re_key", "x@example.org", f.impl).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("The domain is not verified.");
    expect(err.message).not.toContain("secret");
  });

  it("throws a MailError when the provider is unreachable", async () => {
    const impl = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(new ResendMailer("re_key", "x@example.org", impl).send(message)).rejects.toBeInstanceOf(MailError);
  });
});

describe("mail configuration", () => {
  it("uses the logging outbox when no provider is configured", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.mail).toBeNull();
    expect(createMailer(config, () => undefined)).toBeInstanceOf(OutboxMailer);
  });

  it("uses Resend when RESEND_API_KEY and MAIL_FROM are set", () => {
    const config = loadConfig({ NODE_ENV: "test", RESEND_API_KEY: "re_key", MAIL_FROM: "Clock <noreply@example.org>" });
    expect(config.mail).toEqual({ provider: "resend", apiKey: "re_key", from: "Clock <noreply@example.org>" });
    expect(createMailer(config, () => undefined)).toBeInstanceOf(ResendMailer);
  });

  it("refuses an API key without a sender address", () => {
    expect(() => loadConfig({ NODE_ENV: "test", RESEND_API_KEY: "re_key" })).toThrow(/MAIL_FROM/);
  });
});
