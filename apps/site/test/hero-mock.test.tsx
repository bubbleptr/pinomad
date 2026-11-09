import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mockContent } from "../src/landing/mock/content.ts";
import { HeroApp } from "../src/landing/mock/hero-app.tsx";
import { runAt } from "../src/landing/mock/runs.ts";

// The hero's product window is HTML. Its first frame is the prerendered one: what
// a visitor without JS, or with reduced motion, sees for good, and what everyone
// sees before hydration. It has to be the whole picture, not an empty window that
// fills in later.

const escape = (text: string) => renderToString(<>{text}</>);

describe("hero mock", () => {
  for (const lang of ["en", "zh"] as const) {
    it(`prerenders the default conversation in both windows (${lang})`, () => {
      const content = mockContent[lang];
      const html = renderToString(<HeroApp lang={lang} label="label" />);
      const chats = content.machines.flatMap((machine) => machine.projects.flatMap((project) => project.chats));
      const shown = chats.find((chat) => chat.id === content.defaultChat);
      expect(shown).toBeDefined();
      const runs = shown!.blocks.flatMap((block) => (block.kind === "agents" ? block.runs : []));
      expect(runs.length).toBeGreaterThan(1);
      for (const run of runs) {
        // The card in the app, the card in the browser, and the row in the sidebar.
        expect(html.split(escape(run.title)).length - 1).toBeGreaterThanOrEqual(3);
      }
      for (const chat of chats) expect(html).toContain(escape(chat.title));
      expect(html).toContain(content.url);
    });
  }

  it("finishes a running card at its end time instead of ticking on", () => {
    const run = { title: "t", agent: "worker", model: "claude", modelId: "m", since: 40, finishesIn: 30 } as const;
    expect(runAt(run, 10)).toEqual({ status: "running", seconds: 50 });
    expect(runAt(run, 30)).toEqual({ status: "done", seconds: 70 });
    expect(runAt(run, 600)).toEqual({ status: "done", seconds: 70 });
  });
});
