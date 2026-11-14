// The mail both bodies come from (ADR-0044 §2): the HTML part carries what the
// text part says, and nothing a caller interpolates becomes markup.
import { describe, expect, it } from "vitest";
import { renderMail } from "../src/mail-template.ts";

describe("renderMail", () => {
  it("keeps the code in one piece in both bodies, so it can be copied and autofilled", () => {
    const { text, html } = renderMail({ lead: "Your PiNomad sign-up code", code: "042917", note: "If you didn't ask for it, ignore this email." });
    expect(text).toBe("Your PiNomad sign-up code is 042917. It expires in 10 minutes.\n\nIf you didn't ask for it, ignore this email.\n");
    expect(html).toMatch(/>042917</);
    expect(html).toContain("If you didn&#39;t ask for it, ignore this email.");
  });

  it("escapes what it is given in the HTML body and leaves the text body alone", () => {
    const hostile = `"><script>alert(1)</script>&`;
    const { text, html } = renderMail({ lead: `The email was changed to ${hostile}.`, note: hostile });
    expect(text).toBe(`The email was changed to ${hostile}.\n\n${hostile}\n`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;");
  });
});
