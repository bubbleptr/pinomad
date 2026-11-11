import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { copy } from "../src/landing/copy.tsx";
import { Anywhere } from "../src/landing/sections.tsx";

// The "away from your desk" section switches the phone's screenshot with its steps.
// The prerendered frame is what a visitor without JS sees for good: the first step
// shown, not a blank screen or the last image in the stack.

const escape = (text: string) => renderToString(<>{text}</>);

describe("anywhere phone", () => {
  for (const lang of ["en", "zh"] as const) {
    it(`prerenders the first step (${lang})`, () => {
      const t = copy[lang].anywhere;
      const html = renderToString(<Anywhere lang={lang} t={t} />);
      for (const step of t.steps) expect(html).toContain(escape(step.title));
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      const shown = html.match(/<img[^>]*data-shown="true"[^>]*>/g) ?? [];
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain("anywhere-start");
      expect(shown[0]).toContain(`alt="${escape(t.shotAlt)}"`);
      // The page's CSP allows no inline styles on the landing page.
      expect(html).not.toContain('style="');
    });
  }
});
