// The desktop's provider sign-in listener (ADR-0044 §5): what it opens, which
// requests count, single use, and the timeout. Plain Node, no Electron.
import { describe, expect, it } from "vitest";
import { loopbackSignIn, type LoopbackSignInInput } from "../electron/oauth-loopback.ts";

const INPUT: LoopbackSignInInput = {
  serverOrigin: "https://pinomad.si",
  provider: "google",
  codeChallenge: "c".repeat(43),
  state: "state-1",
};

/** Starts a sign-in and hands back the URL it opened, with the listener's port. */
async function started(input: LoopbackSignInInput = INPUT, timeoutMs?: number) {
  let opened!: (url: string) => void;
  const openedUrl = new Promise<string>((resolve) => (opened = resolve));
  const result = loopbackSignIn(input, {
    openExternal: async (url) => opened(url),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const url = new URL(await openedUrl);
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  return { url, callback, result };
}

describe("loopbackSignIn", () => {
  it("opens the server's start route with a 127.0.0.1 redirect and answers the code", async () => {
    const { url, callback, result } = await started();
    expect(`${url.origin}${url.pathname}`).toBe("https://pinomad.si/api/oauth/google/start");
    expect(url.searchParams.get("client")).toBe("native");
    expect(url.searchParams.get("code_challenge")).toBe("c".repeat(43));
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.pathname).toBe("/callback");
    const reply = await fetch(`${callback}?code=one-time&state=state-1`);
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain("You're signed in. You can close this tab and return to PiNomad.");
    expect(await result).toEqual({ code: "one-time" });
  });

  it("turns away other paths, methods and states, and keeps waiting", async () => {
    const { callback, result } = await started();
    expect((await fetch(`${callback.origin}/other?code=x&state=state-1`)).status).toBe(404);
    expect((await fetch(`${callback}?code=x&state=someone-else`)).status).toBe(404);
    expect((await fetch(`${callback}?code=x&state=state-1`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${callback}?code=real&state=state-1`)).status).toBe(200);
    expect(await result).toEqual({ code: "real" });
  });

  it("is single use: the first answer wins and the listener goes away", async () => {
    const { callback, result } = await started();
    const [first, second] = await Promise.all([
      fetch(`${callback}?code=first&state=state-1`),
      fetch(`${callback}?code=second&state=state-1`).catch(() => undefined),
    ]);
    expect(first.status).toBe(200);
    expect(second === undefined || second.status === 409).toBe(true);
    expect(await result).toEqual({ code: "first" });
    await expect(fetch(`${callback}?code=late&state=state-1`)).rejects.toThrow();
  });

  it("passes the server's error through", async () => {
    const { callback, result } = await started();
    expect((await fetch(`${callback}?error=access_denied&state=state-1`)).status).toBe(400);
    expect(await result).toEqual({ error: "access_denied" });
  });

  it("gives up after the timeout", async () => {
    const { callback, result } = await started(INPUT, 50);
    expect(await result).toEqual({ error: "timeout" });
    await expect(fetch(`${callback}?code=late&state=state-1`)).rejects.toThrow();
  });

  it("opens nothing for a plaintext server or a malformed request", async () => {
    const opened: string[] = [];
    const deps = { openExternal: async (url: string) => void opened.push(url) };
    expect(await loopbackSignIn({ ...INPUT, serverOrigin: "http://pinomad.si" }, deps)).toEqual({ error: "invalid_request" });
    expect(await loopbackSignIn({ ...INPUT, provider: "../x" }, deps)).toEqual({ error: "invalid_request" });
    expect(await loopbackSignIn({ ...INPUT, codeChallenge: "short" }, deps)).toEqual({ error: "invalid_request" });
    expect(opened).toEqual([]);
  });

  it("allows a loopback dev server", async () => {
    const { url, callback, result } = await started({ ...INPUT, serverOrigin: "http://127.0.0.1:8787" });
    expect(url.origin).toBe("http://127.0.0.1:8787");
    await fetch(`${callback}?code=dev&state=state-1`);
    expect(await result).toEqual({ code: "dev" });
  });

  it("fails when no browser opens", async () => {
    expect(await loopbackSignIn(INPUT, { openExternal: () => Promise.reject(new Error("no browser")) })).toEqual({
      error: "browser_failed",
    });
  });
});
