#!/usr/bin/env node
// `pinomad status` / `bun run status` — what `pinomad up` set up (#498): the
// server and account this host joined, whether the LAN listener is on, the
// service, and whether the host answers. `service status` keeps the narrower view.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandHint } from "../distribution.ts";
import { readServerConfig, type ServerConfig } from "../server-config.ts";
import { argValue } from "../service/definition.ts";
import { serviceManager, type ServiceManager, type ServiceState } from "../service/manager.ts";
import { DEFAULT_DATA_DIR } from "./host-address.ts";
import { reachabilityLine, versionLine } from "./service.ts";

export interface StatusReport {
  readonly server?: ServerConfig;
  /** The service's LAN port; undefined when the LAN listener is off or there is no service. */
  readonly lanPort?: string;
  readonly service: ServiceState;
  /** The service's loopback port, when it isn't the default. */
  readonly port?: string;
  /** Set when the installed service runs another data dir, whose args say nothing about this one. */
  readonly otherDataDir?: string;
}

export async function statusReport(
  args: { readonly dataDir: string },
  deps?: { readonly manager?: ServiceManager },
): Promise<StatusReport> {
  const dataDir = resolve(args.dataDir);
  const manager = deps?.manager ?? serviceManager();
  const server = await readServerConfig(dataDir);
  const service = await manager.state();
  const spec = service.installed ? await manager.read() : undefined;
  const own = spec !== undefined && resolve(spec.dataDir) === dataDir;
  const lanPort = own ? argValue(spec.hostArgs, "--remote-port") : undefined;
  const port = own ? argValue(spec.hostArgs, "--port") : undefined;
  return {
    ...(server === undefined ? {} : { server }),
    ...(lanPort === undefined ? {} : { lanPort }),
    service,
    ...(port === undefined ? {} : { port }),
    ...(spec === undefined || own ? {} : { otherDataDir: spec.dataDir }),
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { "data-dir": { type: "string" } } });
  const dataDir = resolve(values["data-dir"] ?? DEFAULT_DATA_DIR);
  try {
    const report = await statusReport({ dataDir });
    const { server } = report;
    console.log(
      server === undefined
        ? `server: not joined (\`${commandHint("up")}\` to join)`
        : `server: ${server.username === undefined ? "joined" : server.username} at ${server.origin}`,
    );
    console.log(`LAN and tailnet: ${report.lanPort === undefined ? "off" : `port ${report.lanPort}`}`);
    console.log(`service: ${report.service.installed ? report.service.detail : "not installed"}`);
    if (report.otherDataDir !== undefined) console.log(`note: the installed service runs ${report.otherDataDir}, not ${dataDir}`);
    console.log(await versionLine());
    console.log(
      await reachabilityLine([
        "--data-dir",
        dataDir,
        ...(report.port === undefined ? [] : ["--url", `ws://127.0.0.1:${report.port}`]),
      ]),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
