// Provider sign-in for the desktop app (ADR-0044 §5, RFC 8252): listen on
// 127.0.0.1, open the server's start route in the system browser with the
// renderer's PKCE challenge and state, and wait for the browser to come back
// with a one-time code. The renderer trades the code for a session itself; the
// verifier never leaves it. No Electron import, so the listener is testable
// on plain Node; main.ts supplies shell.openExternal.
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

/**
 * One sign-in: the start URL is opened only for a TLS server (or a loopback
 * dev server), only `GET /callback` with this state counts, the first answer
 * wins and later ones get 409, and the wait ends after `timeoutMs`.
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
  let settle: ((result: LoopbackSignInResult) => void) | undefined;
  const answered = new Promise<LoopbackSignInResult>((resolve) => {
    settle = resolve;
  });
  const listener = createServer((request, response) => {
    const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
    // A stray tab or another local program: turned away, the wait goes on.
    if (url === null || request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== input.state) {
      void page(response, 404, "Not found.");
      return;
    }
    if (settle === undefined) {
      void page(response, 409, "This sign-in was already answered. You can close this tab.");
      return;
    }
    const deliver = settle;
    settle = undefined;
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const result: LoopbackSignInResult =
      code !== null && CODE.test(code) ? { code } : { error: error !== null && STATE.test(error) ? error : "invalid_response" };
    const text =
      "code" in result
        ? "You're signed in. You can close this tab and return to PiNomad."
        : "Sign-in didn't finish. You can close this tab and try again in PiNomad.";
    // The tab gets its page before the listener goes away.
    void page(response, "code" in result ? 200 : 400, text).then(() => deliver(result));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { port } = listener.address() as AddressInfo;
    deps.onListening?.(port);
    const start = new URL(`${normalizeServerOrigin(input.serverOrigin)}/api/oauth/${input.provider}/start`);
    start.search = new URLSearchParams({
      client: "native",
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      code_challenge: input.codeChallenge,
      state: input.state,
    }).toString();
    const opened = await deps.openExternal(start.toString()).then(
      () => true,
      () => false,
    );
    if (!opened) return { error: "browser_failed" };
    const timeout = new Promise<LoopbackSignInResult>((resolve) => {
      timer = setTimeout(() => resolve({ error: "timeout" }), deps.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
    });
    return await Promise.race([answered, timeout]);
  } finally {
    clearTimeout(timer);
    settle = undefined;
    listener.close();
    listener.closeAllConnections();
  }
}
