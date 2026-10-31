#!/usr/bin/env node
// The server (ADR-0022): still does the ADR-0015 relay splice, persists
// accounts, admits hosts bound to them, and serves /api/*. Run on Node with
// native TS stripping — same as the host.
//
//   PINOMAD_SERVER_USER=… PINOMAD_SERVER_PASSWORD=… bun run server -- --public-origin ORIGIN   # first start
//   bun run server -- --public-origin ORIGIN --data-dir DIR
//   bun run server -- passwd [--data-dir DIR] [--user NAME]            # reset a password; new one on stdin
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandHint, webRoot } from "@pinomad/host/src/distribution.ts";
import { openAccounts, resetPassword } from "./accounts.ts";
import { loadApnsConfig, openApns } from "./apns.ts";
import { startRelay } from "./relay.ts";

/** Newest arg wins: flag, then PINOMAD_SERVER_DATA_DIR, then the default. */
function resolveDataDir(flag: string | undefined): string {
  return resolve(flag ?? process.env.PINOMAD_SERVER_DATA_DIR ?? join(homedir(), ".pinomad-server"));
}

async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error("stdin exceeds the password size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function passwdMain(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "data-dir": { type: "string" },
      user: { type: "string" },
    },
    strict: true,
  });
  if (process.stdin.isTTY) {
    console.error("pipe the new password on stdin, e.g. `printenv NEW_PINOMAD_SERVER_PASSWORD | " + commandHint("server") + " passwd`");
    process.exit(1);
  }
  const dataDir = resolveDataDir(values["data-dir"]);
  const password = (await readStdin(16 * 1024)).replace(/[\r\n]+$/, "");
  await resetPassword({ dataDir, user: values.user, password });
  console.log(JSON.stringify({ event: "passwd", dataDir }));
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "passwd") {
    await passwdMain(argv.slice(1)).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    return;
  }

  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string", default: "7430" },
      listen: { type: "string", default: "127.0.0.1" },
      "public-origin": { type: "string" },
      "data-dir": { type: "string" },
      "trust-proxy": { type: "boolean", default: false },
    },
  });

  if (values["public-origin"] === undefined) {
    console.error(
      `usage: ${commandHint("server")} --public-origin ORIGIN [--data-dir DIR] [--trust-proxy] [--port 7430] [--listen 127.0.0.1]\n` +
        `       ${commandHint("server")} passwd [--data-dir DIR] [--user NAME]   (reset a password, server running or not; new password on stdin)\n` +
        "       env: PINOMAD_SERVER_USER, PINOMAD_SERVER_PASSWORD, PINOMAD_SERVER_DATA_DIR",
    );
    process.exit(1);
  }

  // The data dir is always opened (default included): bootstrapped accounts
  // must be found again after the env vars that created them are gone
  // (ADR-0022 §2).
  const accounts = await openAccounts({
    dataDir: resolveDataDir(values["data-dir"]),
    bootstrapUser: process.env.PINOMAD_SERVER_USER,
    bootstrapPassword: process.env.PINOMAD_SERVER_PASSWORD,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  // APNs credentials live only here (ADR-0025 §1): whichever environments
  // fully configure get declared to hosts on `registered`.
  const apnsConfig = loadApnsConfig();
  const apns = apnsConfig === undefined ? undefined : openApns(apnsConfig);

  const relay = await startRelay({
    port: Number(values.port),
    listenHost: values.listen,
    publicOrigin: values["public-origin"],
    // The relay serves its own build; version skew with the host is covered by
    // the client's `outdated` state + one reload.
    webRoot,
    accounts,
    trustProxy: values["trust-proxy"],
    ...(apns === undefined ? {} : { push: apns }),
  });
  console.log(
    JSON.stringify({
      event: "ready",
      url: relay.url,
      publicOrigin: values["public-origin"],
      push: apns?.environments ?? [],
    }),
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void relay.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) await main(process.argv.slice(2));
