import { describe, expect, it } from "vitest";
import { linkBase } from "../src/cli/web-link.ts";

const answers = (...bases: string[]) => (probe: string) => Promise.resolve(bases.includes(probe));
const VITE = "http://127.0.0.1:5199/";
const HOST = "http://127.0.0.1:7431";

describe("linkBase", () => {
  it("prefers a live vite dev server over the host's own port", async () => {
    expect(await linkBase("ws://127.0.0.1:7431", answers(VITE, HOST))).toBe(VITE);
  });

  it("uses the host's own HTTP port when no dev server answers", async () => {
    expect(await linkBase("ws://127.0.0.1:7431", answers(HOST))).toBe(HOST);
    expect(await linkBase("wss://pinomad.example.com", answers("https://pinomad.example.com"))).toBe(
      "https://pinomad.example.com",
    );
  });

  it("falls back to the dev-server URL when nothing answers", async () => {
    expect(await linkBase("ws://127.0.0.1:7431", answers())).toBe(VITE);
  });
});
