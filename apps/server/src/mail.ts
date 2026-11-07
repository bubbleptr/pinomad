// SMTP for mailed codes (ADR-0044 §2): PINOMAD_SERVER_SMTP_URL names the
// relay (smtps://user:pass@host:465, or smtp:// with STARTTLS), and
// PINOMAD_SERVER_MAIL_FROM the sender. Only main.ts imports this, so tests
// and everything else never load nodemailer.
import { createTransport } from "nodemailer";
import type { Mailer } from "./accounts.ts";

/** The mailer the environment configures, or undefined when it configures none; half a configuration is an error. */
export function loadMailer(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  const url = env.PINOMAD_SERVER_SMTP_URL;
  const from = env.PINOMAD_SERVER_MAIL_FROM;
  if (url === undefined && from === undefined) return undefined;
  if (url === undefined || from === undefined) {
    throw new Error("PINOMAD_SERVER_SMTP_URL and PINOMAD_SERVER_MAIL_FROM go together");
  }
  const transport = createTransport(url);
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
