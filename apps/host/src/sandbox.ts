// The Inbox sandbox (ADR-0052 §7). An Inbox run reads outside content
// unattended, so the processes it starts must not reach the user's
// credentials: they get their own HOME, an environment without credential
// variables, and an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that
// hides the credential paths and the host's data dir and confines writes to
// the run's own dirs. The file tools run inside the host process, so the same
// rules are checked there too. Coding conversations never come through here.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, constants, mkdir, readlink, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  err,
  type ExecutionError,
  FileError,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const run = promisify(execFile);

/** Credential files and dirs under the user's HOME that an Inbox run must not read. */
export const CREDENTIAL_PATHS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".password-store",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".gem/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".terraform.d/credentials.tfrc.json",
  ".config/gh",
  ".config/hub",
  ".config/git/credentials",
  ".config/gcloud",
  ".config/op",
  ".config/google-chrome",
  ".config/chromium",
  ".mozilla",
  ".local/share/keyrings",
  // The default host data dir, also when this host runs on another one.
  ".pinomad",
  ".pi",
  ".claude",
  ".codex",
  ".bash_history",
  ".zsh_history",
  ".histfile",
  // Where people export tokens; the sandbox HOME never sources them.
  ".profile",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".config/fish",
  ".env",
  ".gitconfig",
  ".config/git/config",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
];

const CREDENTIAL_NAMES = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GH_CONFIG_DIR",
  "GNUPGHOME",
  "DOCKER_CONFIG",
  "KUBECONFIG",
  "NETRC",
  "DBUS_SESSION_BUS_ADDRESS",
]);
const CREDENTIAL_PREFIXES = ["AWS_", "AZURE_", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_", "PINOMAD_"];
// A word of the name, so TOKENIZERS_PARALLELISM and KEYBOARD stay.
const CREDENTIAL_WORDS = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH)(_|$)/;

/** Whether an environment variable's name says it carries a credential. */
export function credentialEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    CREDENTIAL_NAMES.has(upper) || CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix)) || CREDENTIAL_WORDS.test(upper)
  );
}

/**
 * `env` without credential variables, with HOME, the XDG dirs and the package
 * caches moved to `home`: the real HOME is read-only in the sandbox, so an
 * install that caches there would fail.
 */
export function scrubEnv(env: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !credentialEnv(name) && !name.startsWith("XDG_")) result[name] = value;
  }
  // XDG_RUNTIME_DIR holds the keyring, gpg-agent and ssh-agent sockets; the rest point at the real HOME.
  return {
    ...result,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    BUN_INSTALL_CACHE_DIR: join(home, ".bun", "install", "cache"),
    CARGO_HOME: join(home, ".cargo"),
    GOPATH: join(home, "go"),
    GOMODCACHE: join(home, "go", "pkg", "mod"),
    npm_config_cache: join(home, ".npm"),
  };
}

/**
 * What an Inbox run may touch. Paths are canonical. Reads are allowed except
 * under `hidden`; writes only under `writable` and `own`. Inside `hidden`,
 * `visible` is readable again and `own` readable and writable; `frozen` is
 * read-only even inside `own`.
 */
export type SandboxPolicy = {
  /** The run's HOME. */
  readonly home: string;
  /** Credential paths, agent sockets and the host's data dir. */
  readonly hidden: readonly string[];
  /** Message attachments in the data dir, which the run reads but does not change. */
  readonly visible: readonly string[];
  /** Temp dirs and devices. */
  readonly writable: readonly string[];
  /** The checkout (or project dir), the sandbox HOME and the repository's git dir. */
  readonly own: readonly string[];
  /** Git hooks and config: code planted there would run outside the sandbox. */
  readonly frozen: readonly string[];
  /**
   * Toolchain managers' dirs under the real HOME, which the fresh one would
   * lose; readable, not writable. A variable the environment already sets wins.
   */
  readonly toolchains: Readonly<Record<string, string>>;
};

/** Where toolchain managers find their installs when their variable is unset, relative to HOME. */
const TOOLCHAIN_HOMES: Readonly<Record<string, string>> = {
  MISE_DATA_DIR: ".local/share/mise",
  MISE_CONFIG_DIR: ".config/mise",
  MISE_STATE_DIR: ".local/state/mise",
  ASDF_DATA_DIR: ".asdf",
  RUSTUP_HOME: ".rustup",
  NVM_DIR: ".nvm",
  VOLTA_HOME: ".volta",
  PYENV_ROOT: ".pyenv",
  RBENV_ROOT: ".rbenv",
};

const within = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));

/** Whether `policy` lets a canonical `path` be read or written; the same order as the Seatbelt profile. */
export function permits(policy: SandboxPolicy, path: string, access: "read" | "write"): boolean {
  if (within(path, policy.own)) return access === "read" || !within(path, policy.frozen);
  if (within(path, policy.visible)) return access === "read";
  if (within(path, policy.hidden)) return false;
  return access === "read" || within(path, policy.writable);
}

/**
 * The canonical form of a path that may not exist yet: its nearest existing
 * ancestor resolved, and a dangling symlink followed to where a write through
 * it would land.
 */
async function canonical(path: string, hops = 0): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const target = await readlink(absolute).catch(() => undefined);
    // A link loop fails every open anyway; 40 is Linux's own limit.
    if (target !== undefined && hops < 40) return await canonical(resolve(dirname(absolute), target), hops + 1);
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await canonical(parent, hops), basename(absolute));
  }
}

/** The host process's own environment and open files; the file tools run in the host, so these are never the run's. */
const HOST_PROCESS_PATHS = ["/proc", "/dev"];

const exists = (path: string): Promise<boolean> => access(path, constants.F_OK).then(() => true, () => false);

/**
 * The policy for an Inbox run of `project` in `cwd`. Its HOME is
 * `<dataDir>/inbox-home/<project hash>`, kept between runs so caches survive,
 * with only the user's git identity copied in. `realHome` is for tests.
 */
export async function inboxSandboxPolicy(input: {
  readonly dataDir: string;
  readonly project: string;
  readonly cwd: string;
  readonly realHome?: string;
}): Promise<SandboxPolicy> {
  const realHome = await canonical(input.realHome ?? homedir());
  const home = join(input.dataDir, "inbox-home", createHash("sha256").update(input.project).digest("hex").slice(0, 16));
  await mkdir(home, { recursive: true });
  await seedGitIdentity(input.cwd, home);
  // The whole checkout belongs to the run, not only the project's subdirectory, and so does the
  // repository's git dir: a worktree's index and refs live there.
  const [top, common] = await Promise.all(
    [["--show-toplevel"], ["--path-format=absolute", "--git-common-dir"]].map((args) =>
      run("git", ["rev-parse", ...args], { cwd: input.cwd }).then(({ stdout }) => stdout.trim(), () => undefined),
    ),
  );
  const temps = new Set(await Promise.all([tmpdir(), "/tmp", "/var/tmp", ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])].map(canonical)));
  // The runtime dir holds the keyring's D-Bus socket and the gpg and ssh agents; D-Bus finds it by uid
  // even without the variable. On macOS the profile refuses unix-socket connections instead.
  const sockets =
    process.platform === "linux"
      ? [
          `/run/user/${process.getuid!()}`,
          ...(process.env.XDG_RUNTIME_DIR ? [process.env.XDG_RUNTIME_DIR] : []),
          "/run/docker.sock",
          "/var/run/docker.sock",
        ]
      : [];
  const toolchains: Record<string, string> = {};
  for (const [name, path] of Object.entries(TOOLCHAIN_HOMES)) {
    if (await exists(join(realHome, path))) toolchains[name] = join(realHome, path);
  }
  const canonicalAll = (paths: readonly string[]) => Promise.all(paths.map(canonical));
  const gitDir = common === undefined ? undefined : await canonical(common);
  // bubblewrap can only make an existing path read-only; a missing hooks dir would be the run's to create.
  if (gitDir !== undefined) await mkdir(join(gitDir, "hooks"), { recursive: true });
  return {
    home: await canonical(home),
    hidden: await canonicalAll([...CREDENTIAL_PATHS.map((path) => join(realHome, path)), input.dataDir, ...sockets]),
    visible: [await canonical(join(input.dataDir, "attachments"))],
    writable: [...temps, "/dev"],
    own: await canonicalAll([input.cwd, ...(top === undefined ? [] : [top]), home, ...(gitDir === undefined ? [] : [gitDir])]),
    frozen: gitDir === undefined ? [] : [join(gitDir, "hooks"), join(gitDir, "config")],
    toolchains,
  };
}

/** A fresh HOME has no git identity; commits in the run use the user's name and email, nothing else. */
async function seedGitIdentity(cwd: string, home: string): Promise<void> {
  const read = (key: string) =>
    run("git", ["config", "--get", key], { cwd }).then(({ stdout }) => stdout.trim(), () => "");
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  if (name === "" && email === "") return;
  const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;
  const lines = ["[user]", ...(name === "" ? [] : [`\tname = ${quote(name)}`]), ...(email === "" ? [] : [`\temail = ${quote(email)}`])];
  // The run owns this HOME and may have left a symlink here: write beside it and rename over it,
  // which replaces a link instead of following it.
  const staged = join(home, `.gitconfig.${randomUUID()}`);
  await writeFile(staged, `${lines.join("\n")}\n`, { flag: "wx" });
  await rename(staged, join(home, ".gitconfig"));
}

/** The program that wraps a command in the OS sandbox, or undefined where there is none. */
type Launcher = { readonly kind: "seatbelt"; readonly program: string } | { readonly kind: "bwrap"; readonly program: string };

let launcher: Promise<Launcher | undefined> | undefined;

function probe(program: string, args: readonly string[]): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(program, args, { stdio: "ignore" });
    child.once("error", () => done(false));
    child.once("exit", (code) => done(code === 0));
  });
}

async function findLauncher(): Promise<Launcher | undefined> {
  if (process.platform === "darwin") {
    const program = "/usr/bin/sandbox-exec";
    return (await probe(program, ["-p", "(version 1)(allow default)", "/usr/bin/true"])) ? { kind: "seatbelt", program } : undefined;
  }
  if (process.platform === "linux") {
    const program = await run("sh", ["-c", "command -v bwrap"]).then(({ stdout }) => stdout.trim(), () => "");
    // bwrap may be installed but blocked from user namespaces (Ubuntu's AppArmor default); only a run proves it.
    if (program === "") return undefined;
    return (await probe(program, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "true"]))
      ? { kind: "bwrap", program }
      : undefined;
  }
  return undefined;
}

/**
 * Whether this host can put Inbox runs in an OS sandbox. Without one, Inbox
 * runs still get the scrubbed environment and their own HOME, but the Inbox
 * must not take external event sources (ADR-0052 consequences).
 */
export async function sandboxAvailable(): Promise<boolean> {
  launcher ??= findLauncher();
  return (await launcher) !== undefined;
}

/** A Seatbelt profile for `policy`; paths go in as `-D` parameters, never spliced into the text. */
export function seatbeltArgs(policy: SandboxPolicy): string[] {
  const params: string[] = [];
  const paths = (prefix: string, list: readonly string[]) =>
    list
      .map((path, index) => {
        params.push("-D", `${prefix}${index}=${path}`);
        return `(subpath (param "${prefix}${index}"))`;
      })
      .join(" ");
  const rules = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${paths("HIDDEN", policy.hidden)})`,
    ...(policy.visible.length === 0 ? [] : [`(allow file-read* ${paths("VISIBLE", policy.visible)})`]),
    "(deny file-write*)",
    `(allow file-write* ${paths("WRITABLE", policy.writable)})`,
    `(deny file-write* ${paths("HIDDENW", policy.hidden)})`,
    `(allow file-read* file-write* ${paths("OWN", policy.own)})`,
    ...(policy.frozen.length === 0 ? [] : [`(deny file-write* ${paths("FROZEN", policy.frozen)})`]),
    // The keychain is a service, not a file: `security` and credential helpers reach it over mach.
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))',
    // Unix sockets reach agents and daemons outside the sandbox (ssh-agent, gpg-agent, docker, tmux);
    // the resolver's is the one a build needs.
    "(deny network-outbound (remote unix-socket))",
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    // Other processes' arguments and environment (the host's included).
    "(deny process-info* (target others))",
  ];
  return ["-p", rules.join("\n"), ...params];
}

/**
 * bubblewrap arguments for `policy`: the root read-only, temp dirs private
 * (agents and tmux keep their sockets in /tmp), hidden paths masked, own dirs
 * bound back.
 */
export async function bwrapArgs(policy: SandboxPolicy, cwd: string): Promise<string[]> {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent"];
  for (const path of policy.writable) if (path !== "/dev" && (await exists(path))) args.push("--tmpfs", path);
  for (const path of policy.hidden) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    // Traverse-only, so the own dirs bound back inside the data dir stay reachable but nothing lists.
    if (info.isDirectory()) args.push("--perms", "0111", "--tmpfs", path);
    else args.push("--ro-bind", "/dev/null", path);
  }
  for (const path of policy.visible) if (await exists(path)) args.push("--ro-bind", path, path);
  for (const path of policy.own) if (await exists(path)) args.push("--bind", path, path);
  for (const path of policy.frozen) if (await exists(path)) args.push("--ro-bind", path, path);
  args.push("--chdir", cwd);
  return args;
}

const SHELL = "/bin/bash";

/**
 * A `NodeExecutionEnv` whose commands run in the sandbox and whose file
 * operations obey the same policy. `launch` wraps any other spawn (the
 * background-process pty) the same way.
 */
export class SandboxedExecutionEnv extends NodeExecutionEnv {
  readonly policy: SandboxPolicy;
  readonly #launcher: Launcher | undefined;

  constructor(options: { cwd: string; policy: SandboxPolicy; launcher: Launcher | undefined }) {
    super({ cwd: options.cwd });
    this.policy = options.policy;
    this.#launcher = options.launcher;
  }

  /** `argv` wrapped in the OS sandbox, with `env` scrubbed and HOME moved. */
  async launch(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): Promise<{ argv: string[]; env: Record<string, string> }> {
    const scrubbed = this.#env(env);
    const wrapped =
      this.#launcher === undefined
        ? [...argv]
        : this.#launcher.kind === "seatbelt"
          ? [this.#launcher.program, ...seatbeltArgs(this.policy), ...argv]
          : [this.#launcher.program, ...(await bwrapArgs(this.policy, cwd)), ...argv];
    return { argv: wrapped, env: scrubbed };
  }

  #env(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    return { ...this.policy.toolchains, ...scrubEnv(env, this.policy.home) };
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const base = options?.inheritEnv === false ? { ...options.env } : { ...process.env, ...options?.env };
    // Without a sandbox program a command keeps the base class's shell lookup; only the environment changes.
    const argv = typeof command === "string" && this.#launcher !== undefined ? [SHELL, "-c", command] : command;
    const cwd = options?.cwd === undefined ? this.cwd : resolve(this.cwd, options.cwd);
    const launched = typeof argv === "string" ? { argv, env: this.#env(base) } : await this.launch(argv, base, cwd);
    return await super.exec(launched.argv, { ...options, env: launched.env, inheritEnv: false }, context);
  }

  async #check(path: string, mode: "read" | "write"): Promise<FileError | undefined> {
    const absolute = resolve(this.cwd, path);
    const target = await canonical(absolute);
    if (!within(absolute, HOST_PROCESS_PATHS) && !within(target, HOST_PROCESS_PATHS) && permits(this.policy, target, mode)) return undefined;
    return new FileError("permission_denied", `An Inbox run cannot ${mode} ${path}`, path);
  }

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.readTextFile(path, context) : err(denied);
  }

  override async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.readTextLines(path, options, context) : err(denied);
  }

  override async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.openTextLineReader(path, context) : err(denied);
  }

  override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.readBinaryFile(path, context) : err(denied);
  }

  override async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.openBinaryReader(path, options, context) : err(denied);
  }

  override async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.listDir(path, context) : err(denied);
  }

  override async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const denied = await this.#check(path, "read");
    return denied === undefined ? super.openDirReader(path, context) : err(denied);
  }

  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.#check(path, "write");
    return denied === undefined ? super.writeFile(path, content, context) : err(denied);
  }

  override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.#check(path, "write");
    return denied === undefined ? super.appendFile(path, content, context) : err(denied);
  }

  override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.#check(path, "write");
    return denied === undefined ? super.truncateFile(path, size, context) : err(denied);
  }

  override async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const denied = (await this.#check(sourcePath, "write")) ?? (await this.#check(destinationPath, "write"));
    return denied === undefined ? super.renameFile(sourcePath, destinationPath, context) : err(denied);
  }

  override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.#check(path, "write");
    return denied === undefined ? super.createDir(path, options, context) : err(denied);
  }

  override async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.#check(path, "write");
    return denied === undefined ? super.remove(path, options, context) : err(denied);
  }
}

/** An environment for an Inbox run in `cwd`, sandboxed when this host has a sandbox. */
export async function openSandboxedEnv(cwd: string, policy: SandboxPolicy): Promise<SandboxedExecutionEnv> {
  launcher ??= findLauncher();
  return new SandboxedExecutionEnv({ cwd, policy, launcher: await launcher });
}
