import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, readAppearance, setAppearance, useAppearance, useDarkClass } from "./appearance.ts";

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

/** A system color scheme the test can flip, as the OS would. */
function stubSystemScheme(initial: "light" | "dark") {
  let dark = initial === "dark";
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return dark;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next: "light" | "dark") => {
    dark = next === "dark";
    for (const listener of listeners) listener();
  };
}

const isDark = () => document.documentElement.classList.contains("dark");

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

describe("the dark class that `dark:` styles follow", () => {
  it("follows the system while the appearance is the system's", () => {
    const setSystem = stubSystemScheme("dark");
    renderHook(() => useDarkClass());
    expect(isDark()).toBe(true);
    act(() => setSystem("light"));
    expect(isDark()).toBe(false);
  });

  it("follows a stored choice over the system", () => {
    stubSystemScheme("dark");
    renderHook(() => useDarkClass());
    act(() => setAppearance("light"));
    expect(isDark()).toBe(false);
    act(() => setAppearance("dark"));
    expect(isDark()).toBe(true);
  });

  it("is set by the boot script too, so `dark:` styles don't flash on first paint", () => {
    stubSystemScheme("dark");
    const boot = readFileSync(join(process.cwd(), "apps/web/public/theme-boot.js"), "utf8");
    new Function(boot)();
    expect(isDark()).toBe(true);
    localStorage.setItem(APPEARANCE_KEY, "light");
    new Function(boot)();
    expect(isDark()).toBe(false);
  });
});
