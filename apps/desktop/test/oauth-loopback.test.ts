// The desktop's provider sign-in listener (ADR-0044 §5): what it opens, which
// requests count, single use, and the timeout; and linking from settings
// (#631) in two steps. Plain Node, no Electron.
import { describe, expect, it } from "vitest";
import { loopbackLinks, loopbackSignIn, type LoopbackSignInInput } from "../electron/oauth-loopback.ts";

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

describe("loopbackLinks", () => {
  const START = "https://pinomad.si/api/oauth/github/start?link=ticket";

  function links(timeoutMs?: number) {
    const opened: string[] = [];
    const deps = { openExternal: async (url: string) => void opened.push(url), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    return { links: loopbackLinks(deps), opened };
  }

  async function redirect(api: ReturnType<typeof loopbackLinks>, state = "link-1"): Promise<URL> {
    const listened = await api.listen({ serverOrigin: "https://pinomad.si/", state });
    if (!("redirectUri" in listened)) throw new Error(listened.error);
    return new URL(listened.redirectUri);
  }

  it("gives the renderer a redirect, opens the server's start URL, and answers the linked provider", async () => {
    const { links: api, opened } = links();
    const callback = await redirect(api);
    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.pathname).toBe("/callback");
    const result = api.open({ state: "link-1", url: START });
    await expect.poll(() => opened).toEqual([START]);
    const reply = await fetch(`${callback}?linked=github&state=link-1`);
    expect(await reply.text()).toContain("Linked. You can close this tab and return to PiNomad.");
    expect(await result).toEqual({ linked: "github" });
    await expect(fetch(`${callback}?linked=github&state=link-1`)).rejects.toThrow();
  });

  it("passes the server's refusal through", async () => {
    const { links: api } = links();
    const callback = await redirect(api);
    const result = api.open({ state: "link-1", url: START });
    expect((await fetch(`${callback}?error=identity_taken&state=link-1`)).status).toBe(400);
    expect(await result).toEqual({ error: "identity_taken" });
  });

  it("opens only the same server's start route, for the state it listens for", async () => {
    const { links: api, opened } = links();
    await redirect(api);
    expect(await api.open({ state: "other", url: START })).toEqual({ error: "invalid_request" });
    for (const url of ["https://evil.example/api/oauth/github/start?link=t", "https://pinomad.si/elsewhere", "javascript:alert(1)"]) {
      await redirect(api);
      expect(await api.open({ state: "link-1", url })).toEqual({ error: "invalid_request" });
    }
    expect(opened).toEqual([]);
    expect(await api.listen({ serverOrigin: "http://pinomad.si", state: "s" })).toEqual({ error: "invalid_request" });
  });

  it("ends the last link when a new one starts", async () => {
    const { links: api } = links();
    const first = await redirect(api, "first");
    const waiting = api.open({ state: "first", url: START });
    await redirect(api, "second");
    expect(await waiting).toEqual({ error: "superseded" });
    await expect(fetch(`${first}?linked=github&state=first`)).rejects.toThrow();
  });

  it("gives up after the timeout, opened or not", async () => {
    const { links: api } = links(50);
    const callback = await redirect(api);
    expect(await api.open({ state: "link-1", url: START })).toEqual({ error: "timeout" });
    await expect(fetch(`${callback}?linked=github&state=link-1`)).rejects.toThrow();
    const unopened = await redirect(api, "late");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fetch(`${unopened}?linked=github&state=late`)).rejects.toThrow();
  });
});
