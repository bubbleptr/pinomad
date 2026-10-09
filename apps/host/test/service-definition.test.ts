import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installSpec,
  launchdPlist,
  sanitizePath,
  type ServiceInputs,
  type ServiceSpec,
  systemdUnit,
} from "../src/service/definition.ts";

const inputs = (env: ServiceInputs["env"] = {}): ServiceInputs => ({
  execPath: "/opt/node/bin/node",
  env: { PATH: "/usr/bin:/bin", ...env },
  home: "/home/u",
  cwd: "/home/u/code/pinomad",
  mainPath: "/home/u/code/pinomad/apps/host/src/main.ts",
});

describe("installSpec", () => {
  it("emits the data dir as one explicit absolute --data-dir", () => {
    const spec = installSpec(["--data-dir", "relative/dir", "--port", "7431"], inputs());
    expect(spec.dataDir).toBe("/home/u/code/pinomad/relative/dir");
    const argv = [spec.mainPath, "--data-dir", spec.dataDir, ...spec.hostArgs];
    expect(argv).toEqual([spec.mainPath, "--data-dir", "/home/u/code/pinomad/relative/dir", "--port", "7431"]);
    expect(spec.hostArgs.filter((arg) => arg === "--data-dir" || arg.startsWith("--data-dir="))).toEqual([]);
  });

  it("takes PINOMAD_DATA_DIR when argv has no --data-dir, else the default", () => {
    expect(installSpec([], inputs({ PINOMAD_DATA_DIR: "env-dir" })).dataDir).toBe("/home/u/code/pinomad/env-dir");
    expect(installSpec(["--data-dir=/abs/d"], inputs({ PINOMAD_DATA_DIR: "/other" })).dataDir).toBe("/abs/d");
    expect(installSpec([], inputs()).dataDir).toBe("/home/u/.pinomad");
  });
});

describe("sanitizePath", () => {
  it("drops bun and node_modules shims, dedupes, and keeps order", () => {
    const path = [
      "/repo/node_modules/.bin",
      "/usr/local/bin",
      "/tmp/bun-node-abc123",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].join(":");
    expect(sanitizePath(path)).toBe("/usr/local/bin:/opt/homebrew/bin");
  });
});

describe("entry args", () => {
  // Packaged installs run `node <bundle> host <args>`: the subcommand goes
  // right after the script and before host args, in both renderers.
  it("emits entryArgs between the script and host args in launchd and systemd", () => {
    const spec: ServiceSpec = {
      nodePath: "/opt/node/bin/node",
      mainPath: "/pkg/dist/pinomad.js",
      entryArgs: ["host"],
      dataDir: "/data/d",
      hostArgs: ["--port", "7431"],
      env: { PATH: "/usr/bin" },
      home: "/home/u",
    };
    const plist = launchdPlist(spec);
    const array = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)![1]!;
    const plistArgs = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(plistArgs).toEqual([
      "/opt/node/bin/node",
      "/pkg/dist/pinomad.js",
      "host",
      "--data-dir",
      "/data/d",
      "--port",
      "7431",
    ]);

    const exec = systemdUnit(spec).match(/^ExecStart=(.+)$/m)![1]!;
    expect(exec).toBe('"/opt/node/bin/node" "/pkg/dist/pinomad.js" "host" "--data-dir" "/data/d" "--port" "7431"');
  });
});

describe("launchdPlist", () => {
  it("xml-escapes arguments and paths", () => {
    const spec: ServiceSpec = {
      nodePath: "/opt/node/bin/node",
      mainPath: "/repo/apps/host/src/main.ts",
      entryArgs: [],
      dataDir: "/data/a&b",
      hostArgs: ["--faux", 'say "hi" <there>'],
      env: { PATH: "/usr/bin" },
      home: "/home/u",
    };
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>/data/a&amp;b</string>");
    expect(plist).toContain("<string>say &quot;hi&quot; &lt;there&gt;</string>");
    expect(plist).toContain("<key>StandardOutPath</key>\n  <string>/data/a&amp;b/logs/host.log</string>");
    expect(plist).not.toContain("a&b<");
  });
});

describe("systemdUnit", () => {
  it("quotes and escapes ExecStart args and Environment values", () => {
    const spec: ServiceSpec = {
      nodePath: "/opt/node dir/bin/node",
      mainPath: "/repo/main.ts",
      entryArgs: [],
      dataDir: "/data/100%\\sure",
      hostArgs: ['say "hi"', "$HOME"],
      env: { PATH: "/usr/bin:/opt/x$bin", LANG: "en_US.UTF-8" },
      home: "/home/u",
    };
    const unit = systemdUnit(spec);
    const exec = unit.match(/^ExecStart=(.+)$/m)![1]!;
    // Each argument is one quoted string; `\` and `"` are escaped inside, and
    // `%`/`$` doubled so systemd's specifier and variable expansion pass them through.
    expect(exec).toContain('"/opt/node dir/bin/node"');
    expect(exec).toContain('"/data/100%%\\\\sure"');
    expect(exec).toContain('"say \\"hi\\""');
    expect(exec).toContain('"$$HOME"');
    expect(unit).toContain('Environment="PATH=/usr/bin:/opt/x$$bin" "LANG=en_US.UTF-8"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});
