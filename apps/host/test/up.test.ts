// `pinomad up` / `pinomad status` (#498): one command that asks how other
// devices reach this host, joins the account and/or opens the LAN listener,
// and writes the service once. Real in-process server, fake service manager.
import { describe, expect, it, vi } from "vitest";
import { joinServer } from "../src/cli/join.ts";
import { statusReport } from "../src/cli/status.ts";
import { main as up, resolveReach, upHost } from "../src/cli/up.ts";
import { readServerConfig, writeServerConfig } from "../src/server-config.ts";
import { asUser, codeIn, fakeManager, joinToken, seededSpec, startServer, type Started } from "./server-support.ts";
import { tempDir, useCleanups } from "./support.ts";

const defer = useCleanups();

/**
 * Deps that play the person at the browser: the first poll's sleep confirms
 * the printed code as the signed-in admin. `requests` records every path asked.
 */
function confirmingDeps(started: Started, manager = fakeManager().manager) {
  const lines: string[] = [];
  const requests: string[] = [];
  let confirmed = false;
  return {
    lines,
    requests,
    deps: {
      manager,
      hostname: "omarchy",
      log: (line: string) => lines.push(line),
      openBrowser: () => false,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        requests.push(new URL(String(input)).pathname);
        return fetch(input, init);
      }) as typeof fetch,
      sleep: async () => {
        if (confirmed) return;
        confirmed = true;
        expect((await asUser(started, "/api/host-link/confirm", codeIn(lines))).status).toBe(204);
      },
    },
  };
}

async function dataDir(): Promise<string> {
  const dir = await tempDir();
  defer(dir.remove);
  return dir.path;
}

describe("resolveReach", () => {
  it("asks when no choice was given", () => {
    expect(resolveReach({}, undefined)).toBeUndefined();
    expect(resolveReach({}, { server: true, lan: true })).toBeUndefined();
  });

  it("on a fresh host, one flag decides both: --lan is LAN only, --no-lan is the server only", () => {
    expect(resolveReach({ lan: true }, undefined)).toEqual({ server: false, lan: true });
    expect(resolveReach({ server: true }, undefined)).toEqual({ server: true, lan: false });
    expect(resolveReach({ server: false }, undefined)).toEqual({ server: false, lan: true });
    expect(resolveReach({ lan: false }, undefined)).toEqual({ server: true, lan: false });
    expect(resolveReach({ server: true, lan: true }, undefined)).toEqual({ server: true, lan: true });
  });

  it("on a set-up host, a flag changes only its own path", () => {
    expect(resolveReach({ lan: true }, { server: true, lan: false })).toEqual({ server: true, lan: true });
    expect(resolveReach({ server: true }, { server: false, lan: true })).toEqual({ server: true, lan: true });
    expect(resolveReach({ lan: false }, { server: true, lan: true })).toEqual({ server: true, lan: false });
  });
});

describe("upHost", () => {
  it("LAN only: installs the service with --remote-port 7422 and joins nothing", async () => {
    const dir = await dataDir();
    const fake = fakeManager();
    const outcome = await upHost({ dataDir: dir, reach: { server: false, lan: true } }, { manager: fake.manager });
    expect(outcome.service).toBe("installed");
    expect(outcome.lanPort).toBe("7422");
    expect(fake.installs).toHaveLength(1);
    expect(fake.installs[0]!.hostArgs).toEqual(["--remote-port", "7422"]);
    expect(await readServerConfig(dir)).toBeUndefined();
  });

  it("keeps the installed service's other args and its own LAN port", async () => {
    const dir = await dataDir();
    const fake = fakeManager(seededSpec(dir, ["--port", "7500", "--remote-port", "7000", "--project", "/p"]));
    const outcome = await upHost({ dataDir: dir, reach: { server: false, lan: true } }, { manager: fake.manager });
    expect(outcome.lanPort).toBe("7000");
    // Same args as before: nothing to rewrite, nothing to restart.
    expect(outcome.service).toBe("unchanged");
    expect(fake.installs).toHaveLength(0);
    expect(fake.restarts()).toBe(0);
  });

  it("turning LAN off drops --remote-port and --public-url and keeps the rest", async () => {
    const dir = await dataDir();
    const started = await startServer();
    const fake = fakeManager(seededSpec(dir, ["--port", "7500", "--remote-port", "7000", "--public-url", "https://h.example"]));
    await joinServer({ origin: started.origin, token: await joinToken(started), dataDir: dir }, { manager: fake.manager });
    const installs = fake.installs.length;

    const outcome = await upHost(
      { dataDir: dir, origin: started.origin, reach: { server: true, lan: false } },
      { manager: fake.manager },
    );
    expect(outcome.service).toBe("updated");
    expect(fake.installs.slice(installs).map((spec) => spec.hostArgs)).toEqual([["--port", "7500"]]);
  });

  it("server: joins through a confirmed code and installs the service once, without --remote-port", async () => {
    const dir = await dataDir();
    const started = await startServer();
    const fake = fakeManager();
    const flow = confirmingDeps(started, fake.manager);
    const outcome = await upHost({ dataDir: dir, origin: started.origin, reach: { server: true, lan: false } }, flow.deps);
    expect(outcome.joined).toMatchObject({ username: "admin", origin: started.origin, fresh: true });
    expect(outcome.service).toBe("installed");
    expect(fake.installs.map((spec) => spec.hostArgs)).toEqual([[]]);
    expect(await readServerConfig(dir)).toMatchObject({ origin: started.origin, username: "admin" });
  });

  it("both: one install carries --remote-port and the join", async () => {
    const dir = await dataDir();
    const started = await startServer();
    const fake = fakeManager();
    const flow = confirmingDeps(started, fake.manager);
    const outcome = await upHost({ dataDir: dir, origin: started.origin, reach: { server: true, lan: true } }, flow.deps);
    expect(outcome.joined?.fresh).toBe(true);
    expect(fake.installs.map((spec) => spec.hostArgs)).toEqual([["--remote-port", "7422"]]);
  });

  it("re-running on a host already joined to that server asks nobody to confirm again", async () => {
    const dir = await dataDir();
    const started = await startServer();
    const fake = fakeManager();
    await joinServer({ origin: started.origin, token: await joinToken(started), dataDir: dir }, { manager: fake.manager });
    const flow = confirmingDeps(started, fake.manager);
    const outcome = await upHost({ dataDir: dir, origin: started.origin, reach: { server: true, lan: true } }, flow.deps);
    expect(flow.requests).not.toContain("/api/host-link/start");
    expect(outcome.joined).toMatchObject({ username: "admin", fresh: false });
    expect(outcome.service).toBe("updated");
    expect(fake.installs.at(-1)!.hostArgs).toEqual(["--remote-port", "7422"]);
  });

  it("refuses to switch servers: leave the old one first", async () => {
    const dir = await dataDir();
    await writeServerConfig(dir, { origin: "https://other.example" });
    const fake = fakeManager();
    await expect(
      upHost({ dataDir: dir, origin: "https://app.pinomad.si", reach: { server: true, lan: false } }, { manager: fake.manager }),
    ).rejects.toThrow(/joined to https:\/\/other\.example.*leave/s);
    expect(fake.installs).toHaveLength(0);
  });

  it("refuses a service slot that belongs to another data dir, before anything else", async () => {
    const dir = await dataDir();
    const fake = fakeManager(seededSpec("/somewhere/else", []));
    await expect(upHost({ dataDir: dir, reach: { server: false, lan: true } }, { manager: fake.manager })).rejects.toThrow(
      /different data dir/,
    );
    expect(fake.installs).toHaveLength(0);
  });

  it("leaving the server out of the choice keeps an existing join and says how to leave", async () => {
    const dir = await dataDir();
    await writeServerConfig(dir, { origin: "https://other.example", username: "kieran" });
    const outcome = await upHost({ dataDir: dir, reach: { server: false, lan: true } }, { manager: fakeManager().manager });
    expect(outcome.notes.join("\n")).toMatch(/still joined.*other\.example.*leave/s);
    expect(await readServerConfig(dir)).toMatchObject({ origin: "https://other.example" });
  });
});

describe("pinomad up", () => {
  const capture = () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
    defer(() => {
      vi.restoreAllMocks();
    });
    defer(() => {
      process.exitCode = undefined;
    });
    return errors;
  };

  it("without a terminal or a choice, fails and lists the flags", async () => {
    const errors = capture();
    const fake = fakeManager();
    await up(["--data-dir", await dataDir()], { manager: fake.manager, interactive: false, log: () => {} });
    expect(process.exitCode).toBe(2);
    expect(errors.join("\n")).toMatch(/--server.*--lan.*--yes/s);
    expect(fake.installs).toHaveLength(0);
  });

  it("refuses --no-server --no-lan", async () => {
    const errors = capture();
    const fake = fakeManager();
    await up(["--data-dir", await dataDir(), "--no-server", "--no-lan"], { manager: fake.manager, interactive: false, log: () => {} });
    expect(process.exitCode).toBe(2);
    expect(errors.join("\n")).toMatch(/service install/);
    expect(fake.installs).toHaveLength(0);
  });

  it("asks, naming the server it would join, and follows the answer", async () => {
    capture();
    const fake = fakeManager();
    const questions: string[] = [];
    const lines: string[] = [];
    await up(["--data-dir", await dataDir(), "--origin", "https://self.example"], {
      manager: fake.manager,
      interactive: true,
      ask: async (question) => {
        questions.push(question);
        return "2";
      },
      log: (line) => lines.push(line),
    });
    expect(questions.join("\n")).toContain("https://self.example");
    expect(process.exitCode).toBeUndefined();
    expect(fake.installs.map((spec) => spec.hostArgs)).toEqual([["--remote-port", "7422"]]);
    expect(lines.join("\n")).toContain("pair");
  });

  it("--yes takes the server path by default and says which server before the code", async () => {
    capture();
    const started = await startServer();
    const flow = confirmingDeps(started);
    await up(["--data-dir", await dataDir(), "--origin", started.origin, "--yes"], { ...flow.deps, interactive: false });
    expect(process.exitCode).toBeUndefined();
    const printed = flow.lines.join("\n");
    expect(printed.indexOf(started.origin)).toBeLessThan(printed.indexOf(codeIn(flow.lines)));
    expect(printed).toMatch(/joined admin/);
  });
});

describe("pinomad up on a local-only host", () => {
  // A plain `service install`: no join, no --remote-port. "Neither path on"
  // is no default to keep, so the server is.
  it("--yes and an empty answer both take the server path", async () => {
    defer(() => {
      process.exitCode = undefined;
    });
    for (const mode of ["yes", "ask"] as const) {
      const dir = await dataDir();
      const started = await startServer();
      const fake = fakeManager(seededSpec(dir, ["--port", "7500"]));
      const flow = confirmingDeps(started, fake.manager);
      const questions: string[] = [];
      await up(["--data-dir", dir, "--origin", started.origin, ...(mode === "yes" ? ["--yes"] : [])], {
        ...flow.deps,
        interactive: true,
        ask: async (question) => {
          questions.push(question);
          return "";
        },
      });
      expect(process.exitCode).toBeUndefined();
      if (mode === "ask") expect(questions[0]).toContain("[1]");
      expect(await readServerConfig(dir)).toMatchObject({ origin: started.origin, username: "admin" });
    }
  });
});

describe("statusReport", () => {
  it("a fresh host: not joined, LAN off, no service", async () => {
    const report = await statusReport({ dataDir: await dataDir() }, { manager: fakeManager().manager });
    expect(report.server).toBeUndefined();
    expect(report.lanPort).toBeUndefined();
    expect(report.service.installed).toBe(false);
  });

  it("a joined host with LAN on: the server, the account, the port and the service", async () => {
    const dir = await dataDir();
    const started = await startServer();
    const fake = fakeManager(seededSpec(dir, ["--remote-port", "7422"]));
    await joinServer({ origin: started.origin, token: await joinToken(started), dataDir: dir }, { manager: fake.manager });
    const report = await statusReport({ dataDir: dir }, { manager: fake.manager });
    expect(report).toMatchObject({
      server: { origin: started.origin, username: "admin" },
      lanPort: "7422",
      service: { installed: true, running: true },
    });
  });
});
