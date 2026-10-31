import { describe, expect, it } from "vitest";
import { createDeviceIdSource, DEVICE_ID_KEY } from "./device-id.ts";

const memory = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};

// The server refuses anything else at login with a 400 (ADR-0037 §1).
const SERVER_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

describe("account device id", () => {
  it("generates a 128-bit base64url id once and keeps returning it", () => {
    const storage = memory();
    const first = createDeviceIdSource(() => storage)();
    expect(first).toMatch(SERVER_PATTERN);
    expect(first).toHaveLength(22);
    expect(storage.items.get(DEVICE_ID_KEY)).toBe(first);
    // A reload builds a new source over the same storage.
    expect(createDeviceIdSource(() => storage)()).toBe(first);
  });

  it("replaces a stored value the server would refuse", () => {
    const storage = memory();
    storage.setItem(DEVICE_ID_KEY, "not an id!");
    const id = createDeviceIdSource(() => storage)();
    expect(id).toMatch(SERVER_PATTERN);
    expect(storage.items.get(DEVICE_ID_KEY)).toBe(id);
  });

  it("falls back to one id per page when storage is unavailable", () => {
    const next = createDeviceIdSource(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const id = next();
    expect(id).toMatch(SERVER_PATTERN);
    expect(next()).toBe(id);

    const readOnly = createDeviceIdSource(() => ({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    }));
    expect(readOnly()).toBe(readOnly());
  });
});
