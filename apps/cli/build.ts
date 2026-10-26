#!/usr/bin/env bun
// `bun run package -- --version 1.2.3` — build the publishable npm package in
// apps/cli/out (ADR-0016): one bundle of our code (host + relay + protocol +
// cli), third-party deps external, the built web client beside it.
import { parseArgs } from "node:util";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Just enough of the Bun API this script uses; it never runs under Node and
// bun-types is not a dependency.
declare const Bun: {
  build(options: {
    entrypoints: string[];
    outdir: string;
    target: string;
    format: string;
    splitting: boolean;
    naming: { entry: string; chunk: string; asset: string };
    external: string[];
    define: Record<string, string>;
  }): Promise<{ success: boolean; logs: readonly { level: string; message: string }[]; outputs: readonly { path: string }[] }>;
};

const fail = (message: string): never => {
  console.error(`package: ${message}`);
  process.exit(1);
};

const { values } = parseArgs({
  options: { version: { type: "string" } },
});
const rawVersion = values.version ?? fail("--version is required");
const version = rawVersion.replace(/^v/, "");
// Semver incl. prerelease/build metadata.
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  fail(`not a semver version: ${rawVersion}`);
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, "apps/cli/out");
const distDir = join(out, "dist");

if (!existsSync(join(root, "apps/web/dist/index.html"))) fail("apps/web/dist is missing — run bun run build first");

// Third-party deps stay external and get installed by npm. workspace:* deps
// (our own packages) are bundled instead. A name with two versions is a bug.
// Optional dependencies are kept separately: the native RTC platform prebuilds
// must reach the published manifest as optional, or npm cannot choose one by
// os/cpu (and --omit=optional cannot drop them cleanly).
const dependencies: Record<string, string> = {};
const optionalDependencies: Record<string, string> = {};
for (const dir of ["apps/host", "apps/server", "packages/protocol"]) {
  const manifest = JSON.parse(await readFile(join(root, dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range === "workspace:*") continue;
    const existing = dependencies[name];
    if (existing !== undefined && existing !== range) fail(`conflicting versions for ${name}: ${existing} vs ${range}`);
    dependencies[name] = range;
  }
  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (range === "workspace:*") continue;
    if (dependencies[name] !== undefined) fail(`${name} is both a required and an optional dependency`);
    const existing = optionalDependencies[name];
    if (existing !== undefined && existing !== range) fail(`conflicting optional versions for ${name}: ${existing} vs ${range}`);
    optionalDependencies[name] = range;
  }
}

// Spike #345 0a only. PR1 declares the regular dependency in apps/host and the
// platform prebuilds in apps/host's optionalDependencies; they are injected
// here so this experiment does not touch host product code. The main package
// must stay required so --omit=optional still installs it and its loader can
// report the missing prebuild instead of a bare MODULE_NOT_FOUND.
const SPIKE_NATIVE_RTC_DEPENDENCIES: Record<string, string> = {
  "node-datachannel": "0.33.4",
};
const SPIKE_NATIVE_RTC_OPTIONAL_DEPENDENCIES: Record<string, string> = {
  "@node-datachannel/android-arm64": "0.33.4",
  "@node-datachannel/darwin-arm64": "0.33.4",
  "@node-datachannel/darwin-x64": "0.33.4",
  "@node-datachannel/linux-arm64-gnu": "0.33.4",
  "@node-datachannel/linux-arm64-musl": "0.33.4",
  "@node-datachannel/linux-x64-gnu": "0.33.4",
  "@node-datachannel/linux-x64-musl": "0.33.4",
  "@node-datachannel/win32-arm64-msvc": "0.33.4",
  "@node-datachannel/win32-x64-msvc": "0.33.4",
};
for (const [name, range] of Object.entries(SPIKE_NATIVE_RTC_DEPENDENCIES)) {
  const existing = dependencies[name];
  if (existing !== undefined && existing !== range) fail(`conflicting versions for ${name}: ${existing} vs ${range}`);
  dependencies[name] = range;
}
for (const [name, range] of Object.entries(SPIKE_NATIVE_RTC_OPTIONAL_DEPENDENCIES)) {
  const existing = optionalDependencies[name];
  if (existing !== undefined && existing !== range) fail(`conflicting optional versions for ${name}: ${existing} vs ${range}`);
  optionalDependencies[name] = range;
}

await rm(out, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "apps/cli/src/pinomad.ts")],
  outdir: distDir,
  target: "node",
  format: "esm",
  splitting: true,
  // Flat output — distribution.ts resolves ../web and ./pinomad.js next to chunks.
  naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "asset-[hash].[ext]" },
  external: [...Object.keys(dependencies), ...Object.keys(optionalDependencies)].flatMap((name) => [name, `${name}/*`]),
  define: { PINOMAD_VERSION: JSON.stringify(version) },
});
if (!result.success || result.logs.some((log) => log.level === "error")) {
  for (const log of result.logs) console.error(log.message);
  fail("Bun.build failed");
}
for (const entry of await readdir(distDir, { withFileTypes: true })) {
  if (entry.isDirectory()) fail(`bundle output landed in a subdirectory: dist/${entry.name}`);
}

const entryFile = join(distDir, "pinomad.js");
const bundle = await readFile(entryFile, "utf8");
if (!bundle.startsWith("#!")) await writeFile(entryFile, `#!/usr/bin/env node\n${bundle}`);
await chmod(entryFile, 0o755);

await cp(join(root, "apps/web/dist"), join(out, "web"), { recursive: true });
await cp(join(root, "LICENSE"), join(out, "LICENSE"));
await cp(join(root, "README.md"), join(out, "README.md"));

await writeFile(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "pinomad",
      version,
      description: "PiNomad — self-hosted coding agent: host, relay, and web client in one package",
      license: "Apache-2.0",
      type: "module",
      bin: { pinomad: "dist/pinomad.js" },
      files: ["dist", "web"],
      engines: { node: ">=25" },
      repository: { type: "git", url: "git+https://github.com/bubbleptr/pinomad.git" },
      homepage: "https://github.com/bubbleptr/pinomad",
      dependencies,
      ...(Object.keys(optionalDependencies).length === 0 ? {} : { optionalDependencies }),
    },
    null,
    2,
  )}\n`,
);

console.log(`packaged pinomad@${version} in ${out}`);
