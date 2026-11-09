import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { APPEARANCE_KEY, readAppearance, setAppearance, useAppearance } from "./appearance.ts";

afterEach(() => {
  localStorage.clear();
});

describe("appearance preference", () => {
  it("follows the system until a choice is stored, and for anything it doesn't recognize", () => {
    expect(readAppearance()).toBe("system");
    localStorage.setItem(APPEARANCE_KEY, "sepia");
    expect(readAppearance()).toBe("system");
  });

  it("keeps a choice across reloads and updates the open screen", () => {
    const { result } = renderHook(() => useAppearance());
    expect(result.current).toBe("system");
    act(() => setAppearance("dark"));
    expect(result.current).toBe("dark");
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe("dark");
  });

  it("picks up a choice another tab made", () => {
    const { result } = renderHook(() => useAppearance());
    act(() => {
      localStorage.setItem(APPEARANCE_KEY, "light");
      window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY, newValue: "light" }));
    });
    expect(result.current).toBe("light");
  });

  it("is read by the boot script under the same key, so the first paint matches", () => {
    const boot = readFileSync(join(process.cwd(), "apps/web/public/theme-boot.js"), "utf8");
    expect(boot).toContain(JSON.stringify(APPEARANCE_KEY));
  });
});
