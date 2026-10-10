import { describe, expect, it } from "vitest";
import { navigateAwayAction, windowOpenAction } from "../electron/navigation-policy.ts";

const APP = "app://pinomad/index.html";

describe("windowOpenAction", () => {
  it("opens http(s) in the default browser and denies everything else", () => {
    expect(windowOpenAction("https://example.com/x")).toBe("external");
    expect(windowOpenAction("http://127.0.0.1:7420/")).toBe("external");
    // Even the app's own origin never gets a second window.
    expect(windowOpenAction(APP)).toBe("deny");
    expect(windowOpenAction("pinomad://pair#pair=a.b")).toBe("deny");
    expect(windowOpenAction("javascript:alert(1)")).toBe("deny");
    expect(windowOpenAction("file:///etc/passwd")).toBe("deny");
    expect(windowOpenAction("not a url")).toBe("deny");
  });
});

describe("navigateAwayAction", () => {
  it("allows staying on the app origin, including in-page hash hops", () => {
    expect(navigateAwayAction(APP, "app://pinomad/index.html#pair=a.b")).toBe("allow");
    expect(navigateAwayAction(APP, APP)).toBe("allow");
  });

  it("hands http(s) to the system browser and drops the rest", () => {
    expect(navigateAwayAction(APP, "https://example.com")).toBe("external");
    expect(navigateAwayAction(APP, "file:///etc/passwd")).toBe("deny");
    expect(navigateAwayAction(APP, "javascript:alert(1)")).toBe("deny");
    expect(navigateAwayAction(APP, "pinomad://pair#pair=a.b")).toBe("deny");
    expect(navigateAwayAction(APP, "not a url")).toBe("deny");
  });
});
