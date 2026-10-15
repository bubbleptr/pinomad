#!/usr/bin/env node
// The server (ADR-0022): still does the ADR-0015 relay splice, and in account
// mode also persists accounts and serves /api/*. Run on Node with native TS
// stripping — same as the host.
//
//   bun run relay -- --public-origin ORIGIN --allow-host HOST_ID...   # legacy allowlist only
//   bun run relay -- --public-origin ORIGIN --data-dir DIR            # account mode
//   PINOMAD_SERVER_USER=… PINOMAD_SERVER_PASSWORD=… bun run relay -- --public-origin ORIGIN
//   bun run relay -- passwd [--data-dir DIR]                          # new password on stdin
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandHint, webRoot } from "@pinomad/host/src/distribution.ts";
import { changePassword, openAccounts } from "./accounts.ts";
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
    console.error("pipe the new password on stdin, e.g. `printenv NEW_PINOMAD_SERVER_PASSWORD | " + commandHint("relay") + " passwd`");
    process.exit(1);
  }
  const dataDir = resolveDataDir(values["data-dir"]);
  const password = (await readStdin(16 * 1024)).replace(/[\r\n]+$/, "");
  await changePassword({ dataDir, user: values.user, password });
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
      "allow-host": { type: "string", multiple: true },
      "data-dir": { type: "string" },
      "trust-proxy": { type: "boolean", default: false },
    },
  });

  const allowedHosts = values["allow-host"] ?? [];
  const bootstrapUser = process.env.PINOMAD_SERVER_USER;
  const bootstrapPassword = process.env.PINOMAD_SERVER_PASSWORD;
  // Account mode is on once any of its inputs is present: an explicit data dir
  // or either bootstrap variable. A bare --allow-host run keeps the old
  // stateless relay so existing deployments keep working (ADR-0022 §2).
  const accountMode = values["data-dir"] !== undefined || process.env.PINOMAD_SERVER_DATA_DIR !== undefined || bootstrapUser !== undefined || bootstrapPassword !== undefined;

  if (values["public-origin"] === undefined || (!accountMode && allowedHosts.length === 0)) {
    console.error(
      `usage: ${commandHint("relay")} --public-origin ORIGIN [--allow-host HOST_ID ...] [--data-dir DIR] [--trust-proxy] [--port 7430] [--listen 127.0.0.1]\n` +
        `       ${commandHint("relay")} passwd [--data-dir DIR] [--user NAME]   (server stopped; new password on stdin)\n` +
        "       env: PINOMAD_SERVER_USER, PINOMAD_SERVER_PASSWORD, PINOMAD_SERVER_DATA_DIR",
    );
    process.exit(1);
  }

  const accounts = accountMode
    ? await openAccounts({
        dataDir: resolveDataDir(values["data-dir"]),
        bootstrapUser,
        bootstrapPassword,
      }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      })
    : undefined;

  const relay = await startRelay({
    port: Number(values.port),
    listenHost: values.listen,
    publicOrigin: values["public-origin"],
    allowedHosts,
    // The relay serves its own build; version skew with the host is covered by
    // the client's `outdated` state + one reload.
    webRoot,
    accounts,
    trustProxy: values["trust-proxy"],
  });
  console.log(
    JSON.stringify({
      event: "ready",
      url: relay.url,
      publicOrigin: values["public-origin"],
      allowedHosts: allowedHosts.length,
      accounts: accounts !== undefined,
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
