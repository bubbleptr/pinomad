import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { copy } from "../src/landing/copy.tsx";
import { anywhereContent } from "../src/landing/mock/anywhere-content.ts";
import { mockContent } from "../src/landing/mock/content.ts";
import { Anywhere } from "../src/landing/sections.tsx";

// The "away from your desk" section draws two iPhone screens in HTML. Its first
// frame is the prerendered one, and what a visitor without JS sees for good: the
// whole back screen and the first step in front, not an empty phone.

const escape = (text: string) => renderToString(<>{text}</>);

describe("anywhere mock", () => {
  for (const lang of ["en", "zh"] as const) {
    it(`prerenders both screens and the steps (${lang})`, () => {
      const t = copy[lang].anywhere;
      const html = renderToString(<Anywhere lang={lang} t={t} />);
      // The back screen: the app's home list, a group per machine with its
      // projects, from the hero's story.
      for (const machine of mockContent[lang].machines) {
        expect(html).toContain(escape(machine.name));
        for (const project of machine.projects) expect(html).toContain(escape(project.name));
      }
      // The front screen opens on the first step: the message sent from the phone.
      const start = anywhereContent[lang].start;
      for (const block of start) {
        if (block.kind === "user") expect(html).toContain(escape(block.text));
        if (block.kind === "trace") expect(html).toContain(escape(block.label));
      }
      // The steps that switch it, the first one pressed.
      for (const step of t.steps) expect(html).toContain(escape(step));
      expect(html).toMatch(/aria-pressed="true"[^>]*>[^<]*/);
      // The page's CSP allows no inline styles on the landing page.
      expect(html).not.toContain('style="');
    });
  }
});
