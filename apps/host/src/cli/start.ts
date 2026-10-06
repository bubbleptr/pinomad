// `bun run start` — the one-command bring-up: build the web client, run the
// host, run vite, then print the computer's browser link and the phone's
// pairing QR. The host's routine logs never carry credentials; printing them
// is an explicit operator action, and this launcher is that action.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { printPairing } from "./pair.ts";
import { webLink } from "./web-link.ts";

const webDir = fileURLToPath(new URL("../../../web", import.meta.url));
const mainTs = fileURLToPath(new URL("../main.ts", import.meta.url));

const args = process.argv.slice(2);
// The launcher's purpose is phone pairing, so the secure channel is on unless
// the operator picked a port themselves (or turned it off some other way).
if (!args.some((arg) => arg === "--remote-port" || arg.startsWith("--remote-port="))) {
  args.push("--remote-port", "7422");
}

/** Forward a child's output lines to our stdout, with an optional prefix. */
function forward(child: ChildProcess, prefix = ""): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    let rest = "";
    stream.on("data", (chunk: Buffer) => {
      rest += chunk.toString();
      for (;;) {
        const at = rest.indexOf("\n");
        if (at < 0) break;
        process.stdout.write(`${prefix}${rest.slice(0, at)}\n`);
        rest = rest.slice(at + 1);
      }
    });
  }
}

/** Wait until `child` exits; resolves with its exit code. */
const exited = (child: ChildProcess): Promise<number> =>
  new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));

const terminate = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

// Build first so the remote listener serves today's web client, not a stale one.
const build = spawn("bun", ["run", "build"], { cwd: webDir, stdio: "inherit" });
const buildCode = await exited(build);
if (buildCode !== 0) process.exit(buildCode);

const host = spawn(process.execPath, [mainTs, ...args], { stdio: ["ignore", "pipe", "inherit"] });
forward(host);

let stopping = false;
let vite: ChildProcess | undefined;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void Promise.all([terminate(host), ...(vite === undefined ? [] : [terminate(vite)])]).then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// A dead child takes the launcher down with its exit code, sibling included.
const onChildExit = (child: ChildProcess, sibling: () => ChildProcess | undefined): void => {
  child.once("exit", (code) => {
    if (stopping) return;
    stopping = true;
    const other = sibling();
    void (other === undefined ? Promise.resolve() : terminate(other)).then(() => process.exit(code ?? 1));
  });
};

// Parse the first ready line out of the forwarded host output.
const ready = await new Promise<{ url: string; tokenFile: string }>((resolve, reject) => {
  const onData = (chunk: Buffer): void => {
    for (const line of chunk.toString().split("\n")) {
      try {
        const event = JSON.parse(line) as { event?: string; url?: string; tokenFile?: string };
        if (event.event === "ready" && event.url !== undefined && event.tokenFile !== undefined) {
          resolve({ url: event.url, tokenFile: event.tokenFile });
        }
      } catch {
        // Non-JSON host log lines pass through untouched.
      }
    }
  };
  host.stdout!.on("data", onData);
  host.once("exit", (code) => reject(Object.assign(new Error("Host exited before ready"), { code: code ?? 1 })));
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  // The host's own exit code propagates (a locked data dir is not our failure).
  process.exit(typeof error === "object" && error !== null && "code" in error ? (error as { code: number }).code : 1);
});

vite = spawn("bun", ["run", "dev"], { cwd: webDir, stdio: ["ignore", "pipe", "pipe"] });
forward(vite, "[web] ");
onChildExit(host, () => vite);
onChildExit(vite, () => host);

const token = (await readFile(ready.tokenFile, "utf8")).trim();
console.log(`\nThis computer:  ${webLink(ready.url, token)}\n`);
try {
  await printPairing({ url: ready.url, token });
  console.log("\nThe QR expires in 5 minutes — run `bun run pair` for a fresh one.\n");
} catch (error) {
  // A pairing-print failure must not take the running host down with it.
  console.error(error instanceof Error ? error.message : String(error));
}
