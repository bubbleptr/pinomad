// jsdom: the marker the marketing site reads before it paints (#354). The site
// checks for the `pinomad_app=1` pair, so the assignment must carry both.
import { describe, expect, it } from "vitest";
import { appHintCookie, syncAppHint } from "./app-hint.ts";

const OFFICIAL_APP_HOST = "app.pinomad.si";

const assignment = (maxAge: number): string =>
  `pinomad_app=1; Domain=pinomad.si; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;

describe("the app-hint cookie", () => {
  it("sets a 30-day marker on the official app host", () => {
    expect(appHintCookie(OFFICIAL_APP_HOST, true)).toBe(assignment(2_592_000));
  });

  it("clears the marker when the browser no longer uses the web app", () => {
    expect(appHintCookie(OFFICIAL_APP_HOST, false)).toBe(assignment(0));
  });

  it("writes nothing away from the official app host", () => {
    for (const hostname of ["localhost", "127.0.0.1", "app.example.com", "pinomad.example", "pinomad", ""]) {
      for (const inUse of [true, false]) {
        const jar = { cookie: "" };
        syncAppHint(hostname, inUse, jar);
        expect(jar.cookie).toBe("");
      }
    }
  });

  it("refreshes the marker through the cookie jar on the official app host", () => {
    const jar = { cookie: "" };
    syncAppHint(OFFICIAL_APP_HOST, true, jar);
    expect(jar.cookie).toBe(assignment(2_592_000));
  });

  it("clears the marker through the cookie jar once it no longer applies", () => {
    const jar = { cookie: "" };
    syncAppHint(OFFICIAL_APP_HOST, false, jar);
    expect(jar.cookie).toBe(assignment(0));
  });
});
