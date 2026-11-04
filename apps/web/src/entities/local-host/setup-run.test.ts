// Setting up this Mac (#501): install in the background, then join with a
// one-time token minted only once the install is done, so a slow download
// can't outlive the token.
import { describe, expect, it, vi } from "vitest";
import { fakeLocalHost } from "../../test/story-fixtures.tsx";
import { setupRunFor, type MintToken } from "./setup-run.ts";

const ORIGIN = "https://app.pinomad.si";
const minted = (): MintToken => vi.fn(async () => ({ ok: true as const, token: "join-7f3a9c" }));

describe("setup run", () => {
  it("installs, then mints the token and joins with it, then counts the setup finished", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" }, installLines: ["Downloading Node"] });
    const order: string[] = [];
    vi.mocked(bridge.install).mockImplementationOnce(async () => {
      order.push("install");
      return { outcome: "done" };
    });
    const mint = vi.fn<MintToken>(async () => {
      order.push("mint");
      return { ok: true, token: "join-7f3a9c" };
    });
    const run = setupRunFor(bridge);

    await run.start(ORIGIN, mint);
    expect(order).toEqual(["install", "mint"]);
    expect(bridge.join).toHaveBeenCalledWith(ORIGIN, "join-7f3a9c");
    expect(run.snapshot()).toEqual({ phase: { kind: "idle" }, finished: 1 });
  });

  it("shows the installer's lines while it runs", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" }, installLines: ["Downloading Node", "Installing pinomad"], installWaits: true });
    const run = setupRunFor(bridge);
    void run.start(ORIGIN, minted());
    await vi.waitFor(() => expect(run.snapshot().phase).toEqual({ kind: "installing", lines: ["Downloading Node", "Installing pinomad"] }));
  });

  it("cancel goes back to the start and mints no token", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" }, installWaits: true });
    const mint = minted();
    const run = setupRunFor(bridge);
    const done = run.start(ORIGIN, mint);
    await vi.waitFor(() => expect(bridge.install).toHaveBeenCalled());

    run.cancel();
    await done;
    expect(run.snapshot()).toEqual({ phase: { kind: "idle" }, finished: 0 });
    expect(mint).not.toHaveBeenCalled();
  });

  it("a second start while one runs joins it", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" } });
    const run = setupRunFor(bridge);
    await Promise.all([run.start(ORIGIN, minted()), run.start(ORIGIN, minted())]);
    expect(bridge.install).toHaveBeenCalledTimes(1);
    expect(bridge.join).toHaveBeenCalledTimes(1);
  });

  it("a failed install says why and is tried again from the install", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" }, installResult: { outcome: "failed", message: "checksum mismatch" } });
    const run = setupRunFor(bridge);
    await run.start(ORIGIN, minted());
    expect(run.snapshot().phase).toMatchObject({ kind: "failed", step: "install", message: "checksum mismatch" });
    await run.start(ORIGIN, minted());
    expect(bridge.install).toHaveBeenCalledTimes(2);
  });

  it("a failed join is tried again with a fresh token, without installing again", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" }, joinResult: { ok: false, message: "the join token expired" } });
    const run = setupRunFor(bridge);
    const mint = minted();
    await run.start(ORIGIN, mint);
    expect(run.snapshot().phase).toMatchObject({ kind: "failed", step: "join", message: "the join token expired" });

    await run.start(ORIGIN, mint);
    expect(bridge.install).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(bridge.join).toHaveBeenCalledTimes(2);
  });

  it("a token the account can't mint fails the join step with the account's words", async () => {
    const bridge = fakeLocalHost({ state: { kind: "not-installed" } });
    const run = setupRunFor(bridge);
    await run.start(ORIGIN, async () => ({ ok: false, message: "You were signed out. Sign in again." }));
    expect(run.snapshot().phase).toMatchObject({ kind: "failed", step: "join", message: "You were signed out. Sign in again." });
    expect(bridge.join).not.toHaveBeenCalled();
  });

  it("each bridge has its own run", () => {
    const a = fakeLocalHost({ state: { kind: "not-installed" } });
    expect(setupRunFor(a)).toBe(setupRunFor(a));
    expect(setupRunFor(a)).not.toBe(setupRunFor(fakeLocalHost({ state: { kind: "not-installed" } })));
  });
});
