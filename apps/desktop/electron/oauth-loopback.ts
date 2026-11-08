// Provider sign-in for the desktop app (ADR-0044 §5, RFC 8252): listen on
// 127.0.0.1, open the server's start route in the system browser with the
// renderer's PKCE challenge and state, and wait for the browser to come back
// with a one-time code. The renderer trades the code for a session itself; the
// verifier never leaves it. Linking a provider from settings (#631) uses the
// same listener in two steps: the renderer needs its redirect before it asks
// the server, and the server answers the URL to open. No Electron import, so
// the listener is testable on plain Node; main.ts supplies shell.openExternal.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isSecureServerOrigin, normalizeServerOrigin } from "@pinomad/client/account.ts";

export interface LoopbackSignInInput {
  readonly serverOrigin: string;
  readonly provider: string;
  readonly codeChallenge: string;
  readonly state: string;
}

export type LoopbackSignInResult = { readonly code: string } | { readonly error: string };
export type LoopbackLinkResult = { readonly linked: string } | { readonly error: string };

export interface LoopbackSignInDeps {
  /** Opens the start URL in the system browser. */
  readonly openExternal: (url: string) => Promise<void>;
  /** How long to wait for the browser; five minutes by default. */
  readonly timeoutMs?: number;
  /** Told the port once the listener is up (tests). */
  readonly onListening?: (port: number) => void;
}

export const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

const PROVIDER = /^[a-z]{1,32}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[A-Za-z0-9._~-]{1,256}$/;

const page = (response: ServerResponse, status: number, text: string): Promise<void> =>
  new Promise((resolve) => {
    const escaped = text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>PiNomad</title><body style="font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center">${escaped}</body>`,
      () => resolve(),
    );
  });

type Answer = { readonly code: string } | { readonly linked: string } | { readonly error: string };

/**
 * A 127.0.0.1 listener for one browser answer: only `GET /callback` with
 * `state` counts, the first answer wins and later ones get 409. A sign-in
 * answer is a `code`, a link's a `linked` provider; either may be an `error`.
 */
async function listen(state: string, expect: "code" | "linked"): Promise<{ port: number; answered: Promise<Answer>; close(): void }> {
  let settle: ((answer: Answer) => void) | undefined;
  const answered = new Promise<Answer>((resolve) => {
    settle = resolve;
  });
  const listener = createServer((request, response) => {
    const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
    // A stray tab or another local program: turned away, the wait goes on.
    if (url === null || request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
      void page(response, 404, "Not found.");
      return;
    }
    if (settle === undefined) {
      void page(response, 409, `This ${expect === "code" ? "sign-in" : "link"} was already answered. You can close this tab.`);
      return;
    }
    const deliver = settle;
    settle = undefined;
    const value = url.searchParams.get(expect);
    const error = url.searchParams.get("error");
    const answer: Answer =
      expect === "code" && value !== null && CODE.test(value)
        ? { code: value }
        : expect === "linked" && value !== null && PROVIDER.test(value)
          ? { linked: value }
          : { error: error !== null && STATE.test(error) ? error : "invalid_response" };
    const text =
      "error" in answer
        ? `${expect === "code" ? "Sign-in" : "Linking"} didn't finish. You can close this tab and try again in PiNomad.`
        : expect === "code"
          ? "You're signed in. You can close this tab and return to PiNomad."
          : "Linked. You can close this tab and return to PiNomad.";
    // The tab gets its page before the listener goes away.
    void page(response, "error" in answer ? 400 : 200, text).then(() => deliver(answer));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (listener.address() as AddressInfo).port,
    answered,
    close() {
      settle?.({ error: "superseded" });
      settle = undefined;
      listener.close();
      listener.closeAllConnections();
    },
  };
}

/**
 * One sign-in: the start URL is opened only for a TLS server (or a loopback
 * dev server), and the wait ends after `timeoutMs`.
 */
export async function loopbackSignIn(input: LoopbackSignInInput, deps: LoopbackSignInDeps): Promise<LoopbackSignInResult> {
  if (
    typeof input?.serverOrigin !== "string" ||
    !isSecureServerOrigin(input.serverOrigin) ||
    typeof input.provider !== "string" ||
    !PROVIDER.test(input.provider) ||
    typeof input.codeChallenge !== "string" ||
    !CHALLENGE.test(input.codeChallenge) ||
    typeof input.state !== "string" ||
    !STATE.test(input.state)
  ) {
    return { error: "invalid_request" };
  }
  const listener = await listen(input.state, "code");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    deps.onListening?.(listener.port);
    const start = new URL(`${normalizeServerOrigin(input.serverOrigin)}/api/oauth/${input.provider}/start`);
    start.search = new URLSearchParams({
      client: "native",
      redirect_uri: `http://127.0.0.1:${listener.port}/callback`,
      code_challenge: input.codeChallenge,
      state: input.state,
    }).toString();
    const opened = await deps.openExternal(start.toString()).then(
      () => true,
      () => false,
    );
    if (!opened) return { error: "browser_failed" };
    const timeout = new Promise<Answer>((resolve) => {
      timer = setTimeout(() => resolve({ error: "timeout" }), deps.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
    });
    const answer = await Promise.race([listener.answered, timeout]);
    return "linked" in answer ? { error: "invalid_response" } : answer;
  } finally {
    clearTimeout(timer);
    listener.close();
  }
}

export interface LoopbackLinks {
  /** Starts listening for a link's answer: the redirect to give the server. One link at a time; a new one ends the last. */
  listen(input: { readonly serverOrigin: string; readonly state: string }): Promise<{ readonly redirectUri: string } | { readonly error: string }>;
  /** Opens the server's one-time start URL for the link `state` names and waits for the browser to come back. */
  open(input: { readonly state: string; readonly url: string }): Promise<LoopbackLinkResult>;
}

/**
 * Linking a provider from settings (#631) in two steps around the
 * renderer's own `POST /api/oauth/:provider/link`. The URL to open comes
 * from the server, so only that server's start route is opened; the
 * listener goes away after `timeoutMs` from `listen`, answered or not.
 */
export function loopbackLinks(deps: LoopbackSignInDeps): LoopbackLinks {
  let pending: { state: string; origin: string; listener: Awaited<ReturnType<typeof listen>>; expired: Promise<Answer> } | undefined;
  const end = (): void => {
    pending?.listener.close();
    pending = undefined;
  };
  return {
    async listen({ serverOrigin, state }) {
      if (typeof serverOrigin !== "string" || !isSecureServerOrigin(serverOrigin) || typeof state !== "string" || !STATE.test(state)) {
        return { error: "invalid_request" };
      }
      end();
      const listener = await listen(state, "linked");
      const entry = {
        state,
        origin: normalizeServerOrigin(serverOrigin),
        listener,
        expired: new Promise<Answer>((resolve) => {
          const timer = setTimeout(() => resolve({ error: "timeout" }), deps.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
          void listener.answered.finally(() => clearTimeout(timer));
        }),
      };
      void entry.expired.then(() => {
        if (pending === entry) end();
      });
      pending = entry;
      deps.onListening?.(listener.port);
      return { redirectUri: `http://127.0.0.1:${listener.port}/callback` };
    },
    async open({ state, url }) {
      const entry = pending;
      if (entry === undefined || typeof state !== "string" || entry.state !== state) return { error: "invalid_request" };
      const start = typeof url === "string" ? URL.parse(url) : null;
      if (start === null || start.origin !== entry.origin || !/^\/api\/oauth\/[a-z]{1,32}\/start$/.test(start.pathname)) {
        if (pending === entry) end();
        return { error: "invalid_request" };
      }
      const opened = await deps.openExternal(start.toString()).then(
        () => true,
        () => false,
      );
      if (!opened) {
        if (pending === entry) end();
        return { error: "browser_failed" };
      }
      const answer = await Promise.race([entry.listener.answered, entry.expired]);
      if (pending === entry) end();
      return "code" in answer ? { error: "invalid_response" } : answer;
    },
  };
}
