// The host half of a host link: `pinomad join <origin>` without a token gets
// one by asking a signed-in user to confirm this host in the browser. The
// answer is an ordinary join token, bound to this host, which join spends as
// usual (ADR-0022 §3).
//
// When a browser can open on this machine (#513), the host listens on
// 127.0.0.1, opens the confirm page, and takes the browser's redirect back
// (RFC 8252) with a one-time code it trades for the token under PKCE (RFC
// 7636): nothing to type. Otherwise, or with --code, it shows a short code
// and polls until someone confirms it (RFC 8628 device authorization, #495),
// which also works from another device.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, platform } from "node:os";
import { isSecureServerOrigin } from "@pinomad/client/account.ts";

export interface HostLinkDeps {
  readonly fetch?: typeof fetch;
  /** Waits between polls; tests make time pass instead. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Opens the confirm page; false when it couldn't. */
  readonly openBrowser?: (url: string) => boolean | Promise<boolean>;
  /**
   * Whether to try the browser redirect before a code (#513); by default,
   * when a browser can open on this screen (`browserCommand`).
   */
  readonly loopback?: boolean;
  /** Where the instructions go; stdout by default. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** How long one request may take, body included; default 15 s. */
  readonly requestTimeoutMs?: number;
}

const CODE_EXPIRED = "the code expired before anyone confirmed it — run the command again for a new one";

// RFC 8628 §3.5: slow_down adds 5 s to the interval for every later poll.
const SLOW_DOWN_STEP_MS = 5000;
// A stalled connection, or a proxy that sends headers and then trickles the
// body, must not hang join: each request gets this long, body read included.
const REQUEST_TIMEOUT_MS = 15_000;
// Only when the server stays unreachable does the host give up on its own
// clock; otherwise the server's expired_token ends the wait. The grace covers
// a host clock that runs a little ahead of the server's.
const EXPIRY_GRACE_MS = 2 * 60_000;

/**
 * The command that opens a URL in the user's browser, or undefined when
 * there is no browser on this screen to open: over SSH the page would open
 * on the remote machine, and a Linux session without a display has none.
 */
export function browserCommand(os: NodeJS.Platform, env: NodeJS.ProcessEnv): "open" | "xdg-open" | undefined {
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) return undefined;
  if (os === "darwin") return "open";
  if (os === "linux" && (env.DISPLAY !== undefined || env.WAYLAND_DISPLAY !== undefined)) return "xdg-open";
  return undefined;
}

/** Best effort: a browser that won't open is not an error, the printed URL still works. */
export function openInBrowser(url: string): boolean {
  const command = browserCommand(process.platform, process.env);
  if (command === undefined) return false;
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** What the confirm page shows as this machine's system. */
export function hostOsLabel(): string {
  const os = platform();
  const name = os === "darwin" ? "macOS" : os === "linux" ? "Linux" : os === "win32" ? "Windows" : os;
  return `${name} (${arch()})`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const errorCode = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.error === "string" ? body.error : undefined;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The page the browser lands on after the redirect: plain, no outside
 * resources. Settles once the page is out, so the listener's teardown
 * can't cut it short.
 */
function answerPage(response: ServerResponse, status: number, text: string): Promise<void> {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
    connection: "close",
  });
  const sent = new Promise<void>((resolve) => response.once("close", () => resolve()));
  response.end(`<!doctype html><meta charset="utf-8"><title>PiNomad</title><p>${escapeHtml(text)}</p>\n`);
  return sent;
}

/** RFC 7636 S256: a 43-character verifier and its SHA-256, both base64url. */
function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

interface CodeStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verifyUrl: string;
  readonly expiresAt: number;
  readonly interval: number;
}

const codeStart = (body: unknown): CodeStart | undefined =>
  isRecord(body) &&
  typeof body.deviceCode === "string" &&
  typeof body.userCode === "string" &&
  typeof body.verifyUrl === "string" &&
  typeof body.interval === "number" &&
  typeof body.expiresAt === "number" &&
  isSecureServerOrigin(body.verifyUrl)
    ? {
        deviceCode: body.deviceCode,
        userCode: body.userCode,
        verifyUrl: body.verifyUrl,
        expiresAt: body.expiresAt,
        interval: body.interval,
      }
    : undefined;

/**
 * Starts a host link for `hostId`, has someone confirm it in the browser, and
 * resolves with the join token once they have. `code` skips the browser
 * redirect for the printed code. Throws on denial, expiry, or a server that
 * can't do host links.
 */
export async function requestJoinToken(
  args: {
    readonly origin: string;
    readonly hostId: string;
    readonly name: string;
    readonly os?: string;
    readonly code?: boolean;
  },
  deps?: HostLinkDeps,
): Promise<string> {
  const fetchImpl = deps?.fetch ?? fetch;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps?.log ?? ((line: string) => console.log(line));
  const now = deps?.now ?? Date.now;
  const { origin } = args;

  const timeoutMs = deps?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  /**
   * One request and its whole body within the time limit. Undefined is "no
   * usable answer": the fetch failed or the time ran out. A body that isn't
   * JSON reads as `body: undefined` but still counts as an answer.
   */
  const post = async (path: string, payload: unknown): Promise<{ status: number; body: unknown } | undefined> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race covers a fetch or body stream that ignores the abort signal.
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
    });
    const attempt = (async () => {
      const response = await fetchImpl(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        // A redirect could replay the device code somewhere else, as on the account API.
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    })().catch(() => undefined);
    try {
      return await Promise.race([attempt, expired]);
    } finally {
      clearTimeout(timer);
    }
  };

  const startBody = { hostId: args.hostId, name: args.name, os: args.os ?? hostOsLabel() };
  const openBrowser = async (url: string): Promise<boolean> =>
    Promise.resolve((deps?.openBrowser ?? openInBrowser)(url)).catch(() => false);

  /** A start's answer, or the error it should end the join with. */
  const start = async (payload: unknown): Promise<unknown> => {
    const started = await post("/api/host-link/start", payload);
    if (started === undefined) throw new Error(`cannot reach ${origin} — check the address and that the server is up`);
    if (started.status === 200) return started.body;
    const code = errorCode(started.body);
    if (started.status === 404) {
      throw new Error(
        `${origin} can't confirm hosts in the browser yet — create a join token under "Add a host" and run the join command with it`,
      );
    }
    if (code === "rate_limited") throw new Error("too many join requests from this address — wait a few minutes and try again");
    if (code === "busy") throw new Error(`${origin} has too many hosts waiting to join right now — try again in a few minutes`);
    throw new Error(`${origin} refused to start the join: ${code ?? `HTTP ${started.status}`}`);
  };
  const unexpected = () => new Error(`${origin} answered the join request with something unexpected`);

  /**
   * The browser redirect (#513), or a fallback to the code when it can't go
   * on: a server from before it answers the start with a code, and when no
   * browser opens there is none yet.
   */
  const viaLoopback = async (): Promise<{ readonly token: string } | { readonly fallback: CodeStart | undefined }> => {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    let settle: ((params: URLSearchParams, response: ServerResponse) => void) | undefined;
    const callback = new Promise<{ params: URLSearchParams; response: ServerResponse }>((resolve) => {
      settle = (params, response) => resolve({ params, response });
    });
    const listener = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      // Only the answer to this request counts: anything else on this port,
      // a stray tab or another local program, is turned away and the wait goes on.
      if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        void answerPage(response, 404, "Not found.");
        return;
      }
      if (settle === undefined) {
        void answerPage(response, 409, "This join was already answered. You can close this page.");
        return;
      }
      const deliver = settle;
      settle = undefined;
      deliver(url.searchParams, response);
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const { port } = listener.address() as AddressInfo;
      const body = await start({
        ...startBody,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        codeChallenge: challenge,
        state,
      });
      // A server from before #513 ignores the redirect and hands out a code.
      if (!isRecord(body) || typeof body.requestId !== "string") {
        const fallback = codeStart(body);
        if (fallback === undefined) throw unexpected();
        return { fallback };
      }
      if (typeof body.verifyUrl !== "string" || typeof body.expiresAt !== "number" || !isSecureServerOrigin(body.verifyUrl)) {
        throw unexpected();
      }
      const { verifyUrl, expiresAt } = body;
      if (!(await openBrowser(verifyUrl))) {
        browserOpens = false;
        return { fallback: undefined };
      }

      const minutes = Math.max(1, Math.round((expiresAt - now()) / 60_000));
      log(`Opened ${verifyUrl} in your browser to add this host to your account on ${origin}.`);
      log(`Sign in there and confirm it on this computer — only if you started this on ${args.name} (host id ${args.hostId}).`);
      log(`To confirm from another device instead, press Ctrl-C and run the command again with --code.`);
      log(`Waiting for confirmation (the request expires in ${minutes} min)…`);

      // The timer is unref'd: once the listener closes it must not hold the
      // process open; the listener itself keeps it alive while waiting.
      const wait =
        deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
      const answer = await Promise.race([
        callback,
        wait(Math.max(0, expiresAt + EXPIRY_GRACE_MS - now())).then(() => undefined),
      ]);
      if (answer === undefined) throw new Error("the request expired before anyone confirmed it — run the command again");
      const { params, response } = answer;
      if (params.get("error") === "access_denied") {
        await answerPage(response, 200, `Denied: ${args.name} was not added. You can close this page.`);
        throw new Error(`the join was denied on ${origin}`);
      }
      const code = params.get("code");
      const exchanged =
        code === null ? undefined : await post("/api/host-link/token", { code, codeVerifier: verifier });
      const token = exchanged?.status === 200 && isRecord(exchanged.body) ? exchanged.body.token : undefined;
      if (typeof token !== "string") {
        await answerPage(response, 502, "The join did not finish. Go back to the terminal and run the command again.");
        throw new Error(
          `${origin} did not hand over the join token: ${errorCode(exchanged?.body) ?? (exchanged === undefined ? "no answer" : `HTTP ${exchanged.status}`)} — run the command again`,
        );
      }
      await answerPage(response, 200, `Confirmed: ${args.name} is joining your account. You can close this page.`);
      log("Confirmed.");
      return { token };
    } finally {
      listener.close();
      listener.closeAllConnections();
    }
  };

  // --code is for confirming on another device: no browser here, then.
  let browserOpens = args.code !== true;
  let started: CodeStart | undefined;
  if (args.code !== true && (deps?.loopback ?? browserCommand(process.platform, process.env) !== undefined)) {
    const loopback = await viaLoopback();
    if ("token" in loopback) return loopback.token;
    started = loopback.fallback;
  }
  started ??= codeStart(await start(startBody));
  if (started === undefined) throw unexpected();
  const { deviceCode, userCode, verifyUrl, expiresAt } = started;
  let intervalMs = Math.max(1, started.interval) * 1000;

  const minutes = Math.max(1, Math.round((expiresAt - now()) / 60_000));
  log(`To add this host to your account on ${origin}:`);
  log(`  1. Open ${verifyUrl} and sign in.`);
  log(`  2. Enter this code: ${userCode}`);
  log("");
  log(`Only confirm it if you started this on ${args.name} (host id ${args.hostId}).`);
  const opened = browserOpens && (await openBrowser(verifyUrl));
  log(`${opened ? "Opened the page in your browser. " : ""}Waiting for confirmation (the code expires in ${minutes} min)…`);

  for (;;) {
    await sleep(intervalMs);
    const response = await post("/api/host-link/poll", { deviceCode });
    // A dropped connection, a stalled answer or a restarting server (5xx):
    // keep asking, until the host's own clock says the code is long dead.
    if (response === undefined || response.status >= 500) {
      if (now() > expiresAt + EXPIRY_GRACE_MS) throw new Error(CODE_EXPIRED);
      continue;
    }
    const answer = response.body;
    if (response.status === 200 && isRecord(answer) && typeof answer.token === "string") {
      log("Confirmed.");
      return answer.token;
    }
    // While the server answers, only its expired_token ends the wait.
    const code = response.status === 400 ? errorCode(answer) : undefined;
    if (code === "access_denied") throw new Error(`the join was denied on ${origin}`);
    if (code === "expired_token") throw new Error(CODE_EXPIRED);
    if (code === "slow_down") {
      const asked = isRecord(answer) && typeof answer.interval === "number" ? answer.interval * 1000 : 0;
      intervalMs = Math.max(intervalMs + SLOW_DOWN_STEP_MS, asked);
    } else if (code !== "authorization_pending") {
      throw new Error(`${origin} refused the join: ${code ?? `HTTP ${response.status}`}`);
    }
  }
}
