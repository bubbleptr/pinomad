import { afterEach, describe, expect, it, vi } from "vitest";
import { requestNotificationPermission } from "./notification-permission.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestNotificationPermission", () => {
  it("asks only while the answer is undecided", () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);

    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does nothing where the API is missing", () => {
    expect(() => requestNotificationPermission()).not.toThrow();
  });
});
