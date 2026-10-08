import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const webRequire = createRequire(new URL("../package.json", import.meta.url));
const styles = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");

describe("design system foundation (ADR-0014)", () => {
  it("keeps circles and pills round under the global squircle rule", () => {
    const astryx = readFileSync(webRequire.resolve("@astryxdesign/core/astryx.css"), "utf8");
    expect(styles).toContain(".rounded-full,");
    // Astryx StyleX atomics that emit border-radius:50% / var(--radius-full).
    // Content-addressed, so an upgrade that drops one must fail here loudly
    // instead of silently squaring every circle in the app.
    for (const atomic of [".x16rqkct", ".xy0xnkn", ".xjspbzw", ".x19415el", ".x1dgc8on", ".x1wc3881", ".x8agd5o"]) {
      expect(styles).toContain(atomic);
      expect(astryx).toContain(atomic);
    }
  });
});
