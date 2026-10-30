import type { AppConfig } from "../config.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development/test mailer: records messages and logs them. Used when no email provider is configured
 * (see docs/DEPLOYMENT.md).
 */
export class OutboxMailer implements Mailer {
  readonly outbox: MailMessage[] = [];
  constructor(private readonly log?: (msg: string) => void) {}
  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    this.log?.(`[mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

export class MailError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MailError";
  }
}

/** Sends through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000,
  ) {}

  async send(message: MailMessage): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MailError(`Email provider unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      // Resend returns { name, message }; never include the request (it carries the reset link).
      let detail = "";
      try { detail = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* not JSON */ }
      throw new MailError(`Email provider rejected the message (HTTP ${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
  }
}

/** The configured provider, or the logging outbox when none is set. */
export function createMailer(config: AppConfig, log: (msg: string) => void): Mailer {
  if (config.mail) return new ResendMailer(config.mail.apiKey, config.mail.from);
  return new OutboxMailer(log);
}
