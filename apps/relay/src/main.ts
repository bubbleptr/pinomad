#!/usr/bin/env node
// The self-hosted relay: splices host and device WebSockets, forwards opaque
// Noise-encrypted bytes, stores nothing (ADR-0008 phase 2). Run on Node with
// native TS stripping — same as the host.
//
//   bun run relay -- --public-origin https://relay.example.com --allow-host HOST_ID...
//   pinomad relay --public-origin https://relay.example.com --allow-host HOST_ID...
import { parseArgs } from "node:util";
import { commandHint, webRoot } from "@pinomad/host/src/distribution.ts";
import { startRelay } from "./relay.ts";

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string", default: "7430" },
      listen: { type: "string", default: "127.0.0.1" },
      "public-origin": { type: "string" },
      "allow-host": { type: "string", multiple: true },
    },
  });

  const allowedHosts = values["allow-host"] ?? [];
  if (values["public-origin"] === undefined || allowedHosts.length === 0) {
    console.error(
      `usage: ${commandHint("relay")} --public-origin ORIGIN --allow-host HOST_ID [--allow-host ...] [--port 7430] [--listen 127.0.0.1]`,
    );
    process.exit(1);
  }

  const relay = await startRelay({
    port: Number(values.port),
    listenHost: values.listen,
    publicOrigin: values["public-origin"],
    allowedHosts,
    // The relay serves its own build; version skew with the host is covered by
    // the client's `outdated` state + one reload.
    webRoot,
  });
  console.log(
    JSON.stringify({ event: "ready", url: relay.url, publicOrigin: values["public-origin"], allowedHosts: allowedHosts.length }),
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
