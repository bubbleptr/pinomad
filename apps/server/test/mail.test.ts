// The SMTP mailer's transport settings (ADR-0044 §2): codes must never go out
// over a connection that quietly stayed plaintext.
import { describe, expect, it, vi } from "vitest";

const createTransport = vi.fn((_options: unknown) => ({ sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport }));

const { loadMailer } = await import("../src/mail.ts");

describe("loadMailer", () => {
  it("makes STARTTLS mandatory on smtp:// and leaves smtps:// to implicit TLS", () => {
    loadMailer({ PINOMAD_SERVER_SMTP_URL: "smtp://user:pass@mail.example.com:587", PINOMAD_SERVER_MAIL_FROM: "a@example.com" });
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "smtp://user:pass@mail.example.com:587", requireTLS: true }),
    );
    loadMailer({ PINOMAD_SERVER_SMTP_URL: "smtps://user:pass@mail.example.com:465", PINOMAD_SERVER_MAIL_FROM: "a@example.com" });
    const [options] = createTransport.mock.lastCall!;
    expect(options).toEqual(expect.objectContaining({ url: "smtps://user:pass@mail.example.com:465" }));
    expect((options as { requireTLS?: boolean }).requireTLS).not.toBe(true);
  });

  it("is off without configuration and refuses half of one", () => {
    expect(loadMailer({})).toBeUndefined();
    expect(() => loadMailer({ PINOMAD_SERVER_SMTP_URL: "smtp://mail.example.com" })).toThrow();
  });
});
