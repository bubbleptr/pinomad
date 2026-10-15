// Service definitions for the user-level host service (ADR-0009 §4): the
// service manager hands the host a different environment than the terminal
// that installed it, so node, PATH, and the data dir are all fixed at install.
import { join, resolve } from "node:path";

/** Everything a service definition needs; nothing is read from the service's environment later. */
export interface ServiceSpec {
  /** `process.execPath` at install: nvm/fnm Nodes are not on the service PATH. */
  readonly nodePath: string;
  /** The script node runs: the checkout's `main.ts`, or the package's `dist/pinomad.js` (ADR-0016). */
  readonly mainPath: string;
  /** Arguments between script and host args — `["host"]` on the packaged bundle, empty from source. */
  readonly entryArgs: readonly string[];
  readonly dataDir: string;
  /** Host arguments verbatim, minus `--data-dir` (re-emitted explicitly). */
  readonly hostArgs: readonly string[];
  readonly env: { readonly PATH: string; readonly LANG?: string; readonly LC_ALL?: string };
  readonly home: string;
}

/** The process-ish inputs installSpec needs; injected so the spec is testable. */
export interface ServiceInputs {
  readonly execPath: string;
  readonly env: {
    readonly PATH?: string;
    readonly PINOMAD_DATA_DIR?: string;
    readonly LANG?: string;
    readonly LC_ALL?: string;
  };
  readonly home: string;
  readonly cwd: string;
  readonly mainPath: string;
  readonly entryArgs?: readonly string[];
}

/**
 * `bun run`/`npm run` prepend `node_modules/.bin` and (Bun) a temp `node` shim
 * dir to PATH. The agent's bash inherits the host's environment, so those
 * transient entries must not be baked into the service definition.
 */
export function sanitizePath(path: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of path.split(":")) {
    if (entry === "" || entry.includes("/node_modules/.bin") || entry.includes("/bun-node-")) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    kept.push(entry);
  }
  return kept.join(":");
}

/** Build a spec from CLI argv plus the installing process's environment. */
export function installSpec(argv: readonly string[], inputs: ServiceInputs): ServiceSpec {
  const hostArgs: string[] = [];
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      dataDir = argv[++i];
      if (dataDir === undefined) throw new Error("--data-dir requires a value");
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else {
      hostArgs.push(arg);
    }
  }
  const dir = resolve(inputs.cwd, dataDir ?? inputs.env.PINOMAD_DATA_DIR ?? join(inputs.home, ".pinomad"));
  const { env } = inputs;
  return {
    nodePath: inputs.execPath,
    mainPath: inputs.mainPath,
    entryArgs: inputs.entryArgs ?? [],
    dataDir: dir,
    hostArgs,
    env: {
      // Frozen at install (ADR-0009 §4): re-run `service install` after PATH changes.
      PATH: sanitizePath(env.PATH ?? ""),
      ...(env.LANG === undefined ? {} : { LANG: env.LANG }),
      ...(env.LC_ALL === undefined ? {} : { LC_ALL: env.LC_ALL }),
    },
    home: inputs.home,
  };
}

export const launchdPlistPath = (home: string): string => join(home, "Library", "LaunchAgents", "pinomad.host.plist");
export const systemdUnitPath = (home: string): string => join(home, ".config", "systemd", "user", "pinomad.service");

/** Reads `--flag value` / `--flag=value` out of a host-args list; last occurrence wins. */
export function argValue(args: readonly string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) value = args[i + 1];
    else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
  }
  return value;
}

/** Drops `--relay <value>` and `--relay=<value>` pairs — join/leave rewrite the definition without it. */
export function withoutRelayArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--relay") {
      i += 1; // the flag's value
      continue;
    }
    if (arg.startsWith("--relay=")) continue;
    out.push(arg);
  }
  return out;
}

// The renderers escape in two layers: systemd doubles % and $ (specifiers and
// $VAR expansion) then backslash-escapes inside quotes; launchd XML-escapes.
// The readers below undo them in reverse order.
const unescapeExec = (value: string): string => value.replace(/\\(.)/g, "$1");
const unspecify = (value: string): string => value.replace(/%%/g, "%").replace(/\$\$/g, "$");
const xmlUnescape = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Rebuilds the ServiceSpec from its rendered program array. `--data-dir` is the
 * boundary: before it sit nodePath/mainPath/entryArgs, after it the host args.
 */
function specFromProgram(program: readonly string[], env: Record<string, string>, home: string): ServiceSpec {
  const at = program.indexOf("--data-dir");
  if (program.length < 4 || at < 2 || program[at + 1] === undefined) {
    throw new Error("service definition has no --data-dir argument boundary");
  }
  return {
    nodePath: program[0]!,
    mainPath: program[1]!,
    entryArgs: program.slice(2, at),
    dataDir: program[at + 1]!,
    hostArgs: program.slice(at + 2),
    env: {
      PATH: env.PATH ?? "",
      ...(env.LANG === undefined ? {} : { LANG: env.LANG }),
      ...(env.LC_ALL === undefined ? {} : { LC_ALL: env.LC_ALL }),
    },
    home,
  };
}

/** Parses back a unit written by systemdUnit — join/leave read-then-rewrite the definition. */
export function specFromSystemdUnit(text: string): ServiceSpec {
  const exec = /^ExecStart=(.*)$/m.exec(text)?.[1];
  if (exec === undefined) throw new Error("service unit has no ExecStart");
  const program = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => unspecify(unescapeExec(match[1]!)));
  const env: Record<string, string> = {};
  const envLine = /^Environment=(.*)$/m.exec(text)?.[1] ?? "";
  // Environment values are specifier-escaped but not quote-escaped.
  for (const match of envLine.matchAll(/"([^"]*)"/g)) {
    const pair = unspecify(match[1]!);
    const eq = pair.indexOf("=");
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const workdir = /^WorkingDirectory=(.*)$/m.exec(text)?.[1];
  if (workdir === undefined) throw new Error("service unit has no WorkingDirectory");
  return specFromProgram(program, env, unspecify(workdir));
}

/** Parses back a plist written by launchdPlist. */
export function specFromLaunchdPlist(text: string): ServiceSpec {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (array === undefined) throw new Error("plist has no ProgramArguments");
  const program = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]!));
  const env: Record<string, string> = {};
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
  for (const match of dict.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    env[xmlUnescape(match[1]!)] = xmlUnescape(match[2]!);
  }
  const workdir = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text)?.[1];
  if (workdir === undefined) throw new Error("plist has no WorkingDirectory");
  return specFromProgram(program, env, xmlUnescape(workdir));
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function launchdPlist(spec: ServiceSpec): string {
  const program = [spec.nodePath, spec.mainPath, ...spec.entryArgs, "--data-dir", spec.dataDir, ...spec.hostArgs];
  const log = join(spec.dataDir, "logs", "host.log");
  const env = Object.entries(spec.env).map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>pinomad.host</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env.join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

/** systemd expands `%` specifiers and `$` variables in ExecStart and Environment values. */
const specifier = (value: string): string => value.replace(/[%$]/g, (char) => char + char);
const execQuote = (value: string): string => `"${specifier(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const program = [spec.nodePath, spec.mainPath, ...spec.entryArgs, "--data-dir", spec.dataDir, ...spec.hostArgs];
  const environment = Object.entries(spec.env).map(([key, value]) => `"${key}=${specifier(value)}"`);
  return `[Unit]
Description=PiNomad host

[Service]
ExecStart=${program.map(execQuote).join(" ")}
WorkingDirectory=${specifier(spec.home)}
Environment=${environment.join(" ")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}
