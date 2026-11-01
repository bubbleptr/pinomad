// The host half of a host link (#495): `pinomad join <origin>` without a token
// asks the server for a short code (RFC 8628 device authorization), shows it,
// and polls until a signed-in user confirms it in the browser. The answer is
// an ordinary join token, bound to this host, which join spends as usual
// (ADR-0022 §3).
import { spawn } from "node:child_process";
import { arch, platform } from "node:os";
import { isSecureServerOrigin } from "@pinomad/client/account.ts";

export interface HostLinkDeps {
  readonly fetch?: typeof fetch;
  /** Waits between polls; tests make time pass instead. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Opens the confirm page; false when it couldn't. */
  readonly openBrowser?: (url: string) => boolean | Promise<boolean>;
  /** Where the instructions go; stdout by default. */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** How long one request may take, body included; default 15 s. */
  readonly requestTimeoutMs?: number;
}

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

/**
 * Starts a host link for `hostId`, prints where to confirm it, and resolves
 * with the join token once someone has. Throws on denial, expiry, or a
 * server that can't do host links.
 */
export async function requestJoinToken(
  args: { readonly origin: string; readonly hostId: string; readonly name: string; readonly os?: string },
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

  const started = await post("/api/host-link/start", { hostId: args.hostId, name: args.name, os: args.os ?? hostOsLabel() });
  if (started === undefined) throw new Error(`cannot reach ${origin} — check the address and that the server is up`);
  const { body } = started;
  if (started.status !== 200) {
    const code = errorCode(body);
    if (started.status === 404) {
      throw new Error(
        `${origin} can't confirm hosts in the browser yet — create a join token under "Add a host" and run the join command with it`,
      );
    }
    if (code === "rate_limited") throw new Error("too many join requests from this address — wait a few minutes and try again");
    if (code === "busy") throw new Error(`${origin} has too many hosts waiting to join right now — try again in a few minutes`);
    throw new Error(`${origin} refused to start the join: ${code ?? `HTTP ${started.status}`}`);
  }
  if (
    !isRecord(body) ||
    typeof body.deviceCode !== "string" ||
    typeof body.userCode !== "string" ||
    typeof body.verifyUrl !== "string" ||
    typeof body.interval !== "number" ||
    typeof body.expiresAt !== "number" ||
    !isSecureServerOrigin(body.verifyUrl)
  ) {
    throw new Error(`${origin} answered the join request with something unexpected`);
  }
  const { deviceCode, userCode, verifyUrl, expiresAt } = body;
  let intervalMs = Math.max(1, body.interval) * 1000;

  const minutes = Math.max(1, Math.round((expiresAt - now()) / 60_000));
  log(`To add this host to your account on ${origin}:`);
  log(`  1. Open ${verifyUrl} and sign in.`);
  log(`  2. Enter this code: ${userCode}`);
  log("");
  log(`Only confirm it if you started this on ${args.name} (host id ${args.hostId}).`);
  const opened = await Promise.resolve((deps?.openBrowser ?? openInBrowser)(verifyUrl)).catch(() => false);
  log(`${opened ? "Opened the page in your browser. " : ""}Waiting for confirmation (the code expires in ${minutes} min)…`);

  for (;;) {
    await sleep(intervalMs);
    const response = await post("/api/host-link/poll", { deviceCode });
    // A dropped connection, a stalled answer or a restarting server (5xx):
    // keep asking, until the host's own clock says the code is long dead.
    if (response === undefined || response.status >= 500) {
      if (now() > expiresAt + EXPIRY_GRACE_MS) {
        throw new Error(`the code expired before anyone confirmed it — run the command again for a new one`);
      }
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
    if (code === "expired_token") throw new Error(`the code expired before anyone confirmed it — run the command again for a new one`);
    if (code === "slow_down") {
      const asked = isRecord(answer) && typeof answer.interval === "number" ? answer.interval * 1000 : 0;
      intervalMs = Math.max(intervalMs + SLOW_DOWN_STEP_MS, asked);
    } else if (code !== "authorization_pending") {
      throw new Error(`${origin} refused the join: ${code ?? `HTTP ${response.status}`}`);
    }
  }
}
