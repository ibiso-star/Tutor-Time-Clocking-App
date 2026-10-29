export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development/test mailer: records messages and logs them. Production deployments should provide a
 * real transactional email implementation (see docs/DEPLOYMENT.md).
 */
export class OutboxMailer implements Mailer {
  readonly outbox: MailMessage[] = [];
  constructor(private readonly log?: (msg: string) => void) {}
  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    this.log?.(`[mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}
