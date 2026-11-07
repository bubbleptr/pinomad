#!/usr/bin/env node
// The server (ADR-0022): still does the ADR-0015 relay splice, persists
// accounts, admits hosts bound to them, and serves /api/*. Run on Node with
// native TS stripping — same as the host.
//
//   PINOMAD_SERVER_USER=EMAIL PINOMAD_SERVER_PASSWORD=… bun run server -- --public-origin ORIGIN   # first start
//   bun run server -- --public-origin ORIGIN --data-dir DIR
//   bun run server -- passwd [--data-dir DIR] [--user EMAIL|NAME]      # reset a password; new one on stdin
//   bun run server -- user add EMAIL [--data-dir DIR]                  # add an account; its password on stdin
//   bun run server -- user set-email NAME EMAIL [--data-dir DIR]       # give a legacy account its email
//
// Mail (ADR-0044 §2): PINOMAD_SERVER_SMTP_URL and PINOMAD_SERVER_MAIL_FROM
// turn on email sign-up, password reset and adding an email; without them
// accounts sign in with their passwords as before. PINOMAD_SERVER_REGISTRATION
// is `open` or `closed` (default): closed, only `user add` creates accounts.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandHint, webRoot } from "@pinomad/host/src/distribution.ts";
import { addUser, openAccounts, resetPassword, setUserEmail } from "./accounts.ts";
import { loadApnsConfig, openApns } from "./apns.ts";
import { loadMailer } from "./mail.ts";
import { startRelay } from "./relay.ts";
import { DEFAULT_RELAY_LIMITS, readRelayLimits, RELAY_LIMIT_OPTIONS, type RelayLimits } from "./relay-limits.ts";

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

/** A password piped on stdin, never typed as an argument where `ps` and shell history would keep it. */
async function passwordFromStdin(command: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(`pipe the password on stdin, e.g. \`printenv NEW_PINOMAD_SERVER_PASSWORD | ${commandHint("server")} ${command}\``);
  }
  return (await readStdin(16 * 1024)).replace(/[\r\n]+$/, "");
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
  const dataDir = resolveDataDir(values["data-dir"]);
  const password = await passwordFromStdin("passwd");
  await resetPassword({ dataDir, user: values.user, password });
  console.log(JSON.stringify({ event: "passwd", dataDir }));
}

/** `user add EMAIL` and `user set-email NAME EMAIL` (ADR-0044 §7, §8). */
async function userMain(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "data-dir": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const dataDir = resolveDataDir(values["data-dir"]);
  const [command, ...rest] = positionals;
  if (command === "add" && rest.length === 1) {
    await addUser({ dataDir, email: rest[0]!, password: await passwordFromStdin(`user add ${rest[0]}`) });
    console.log(JSON.stringify({ event: "user-added", dataDir }));
    return;
  }
  if (command === "set-email" && rest.length === 2) {
    await setUserEmail({ dataDir, user: rest[0]!, email: rest[1]! });
    console.log(JSON.stringify({ event: "email-set", dataDir }));
    return;
  }
  throw new Error(`usage: ${commandHint("server")} user add EMAIL | user set-email NAME EMAIL [--data-dir DIR]`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const subcommand = argv[0] === "passwd" ? passwdMain : argv[0] === "user" ? userMain : undefined;
  if (subcommand !== undefined) {
    await subcommand(argv.slice(1)).catch((error: unknown) => {
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
      ...Object.fromEntries(RELAY_LIMIT_OPTIONS.map((option) => [option.flag, { type: "string" as const }])),
    },
  });

  if (values["public-origin"] === undefined) {
    console.error(
      `usage: ${commandHint("server")} --public-origin ORIGIN [--data-dir DIR] [--trust-proxy] [--port 7430] [--listen 127.0.0.1]\n` +
        `       ${commandHint("server")} passwd [--data-dir DIR] [--user EMAIL|NAME]   (reset a password, server running or not; new password on stdin)\n` +
        `       ${commandHint("server")} user add EMAIL [--data-dir DIR]   (add an account; its password on stdin)\n` +
        `       ${commandHint("server")} user set-email NAME EMAIL [--data-dir DIR]   (give an account its email, taken as verified)\n` +
        "       env: PINOMAD_SERVER_USER, PINOMAD_SERVER_PASSWORD, PINOMAD_SERVER_DATA_DIR,\n" +
        "            PINOMAD_SERVER_REGISTRATION (open|closed), PINOMAD_SERVER_SMTP_URL, PINOMAD_SERVER_MAIL_FROM\n" +
        "       relay limits (flag or env, 0 = off): " +
        RELAY_LIMIT_OPTIONS.map((option) => `--${option.flag} / ${option.env}`).join(", "),
    );
    process.exit(1);
  }

  // Splice caps and the per-account byte budget (issue #453): checked before
  // anything opens, so a typo fails the start instead of running unlimited.
  let limits: Partial<RelayLimits>;
  try {
    limits = readRelayLimits(values, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Checked before anything opens, like the limits: a typo must fail the
  // start, not quietly close sign-up or drop mail.
  const registration = process.env.PINOMAD_SERVER_REGISTRATION ?? "closed";
  let mailer: ReturnType<typeof loadMailer>;
  try {
    if (registration !== "open" && registration !== "closed") {
      throw new Error(`PINOMAD_SERVER_REGISTRATION must be open or closed, not ${registration}`);
    }
    mailer = loadMailer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // The data dir is always opened (default included): bootstrapped accounts
  // must be found again after the env vars that created them are gone
  // (ADR-0022 §2).
  const accounts = await openAccounts({
    dataDir: resolveDataDir(values["data-dir"]),
    bootstrapUser: process.env.PINOMAD_SERVER_USER,
    bootstrapPassword: process.env.PINOMAD_SERVER_PASSWORD,
    registration,
    ...(mailer === undefined ? {} : { mailer }),
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
    limits,
  });
  console.log(
    JSON.stringify({
      event: "ready",
      url: relay.url,
      publicOrigin: values["public-origin"],
      push: apns?.environments ?? [],
      registration: accounts.registrationOpen ? "open" : "closed",
      mail: accounts.emailEnabled,
      relayLimits: { ...DEFAULT_RELAY_LIMITS, ...limits },
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
