// The bodies of the mails the server sends (ADR-0044 §2): one content, a
// text part and an HTML part that say the same thing. The HTML is written for
// mail clients, not browsers: tables and inline styles, no remote images or
// fonts (a self-hosted server has no asset host, and remote loads tell the
// sender when a mail is opened), and dark colors only where the client honors
// prefers-color-scheme.

/** What a mail says: a lead sentence and a closing note, around a code when it carries one. */
export interface MailContent {
  /** With a code, what the code is ("Your PiNomad sign-up code"); without, the first paragraph. */
  readonly lead: string;
  readonly code?: string;
  readonly note: string;
}

/** The two parts of one mail. */
export interface MailBody {
  readonly text: string;
  readonly html: string;
}

const EXPIRY = "It expires in 10 minutes.";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// Clients that drop <style> (Gmail on some paths) keep the inline light
// colors, which also read correctly if the client inverts them itself.
const DARK = `@media (prefers-color-scheme: dark) {
  .bg { background: #161618 !important; }
  .card { background: #1c1c1e !important; border-color: #323234 !important; }
  .fg { color: #ebebeb !important; }
  .muted { color: #a1a1a6 !important; }
  .code { background: #2a2a2d !important; color: #ffffff !important; }
}`;

export function renderMail({ lead, code, note }: MailContent): MailBody {
  const first = code === undefined ? lead : `${lead} is ${code}. ${EXPIRY}`;
  const paragraph = (className: string, color: string, size: number, margin: string, body: string): string =>
    `<p class="${className}" style="margin:${margin};font-family:${SANS};font-size:${size}px;line-height:1.5;color:${color};">${body}</p>`;
  const main =
    code === undefined
      ? paragraph("fg", "#1c1c1e", 16, "0 0 16px", escapeHtml(lead))
      : paragraph("fg", "#1c1c1e", 16, "0 0 20px", escapeHtml(lead)) +
        // One element holds the whole code: selecting it copies six digits,
        // and iOS can offer it above the keyboard. The left padding matches
        // the spacing after the last digit, so the digits sit centered.
        `<div class="code" style="margin:0 0 12px;padding:18px 0 18px 8px;border-radius:10px;background:#f4f4f5;color:#111113;` +
        `font-family:${MONO};font-size:32px;line-height:1.2;font-weight:600;letter-spacing:8px;text-align:center;">${escapeHtml(code)}</div>` +
        paragraph("muted", "#6e6e73", 14, "0 0 24px", EXPIRY);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>${DARK}</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(first)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td class="fg" style="padding:0 4px 16px;font-family:${SANS};font-size:15px;font-weight:600;letter-spacing:-0.01em;color:#1c1c1e;">PiNomad</td></tr>
<tr><td class="card" style="padding:32px 28px;border:1px solid #e4e4e7;border-radius:12px;background:#ffffff;">
${main}
${paragraph("muted", "#6e6e73", 14, "0", escapeHtml(note))}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  return { text: `${first}\n\n${note}\n`, html };
}
