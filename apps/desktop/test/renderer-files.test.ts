import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentTypeFor, rendererFilePath } from "../electron/renderer-files.ts";

const dir = "/srv/renderer";

describe("rendererFilePath", () => {
  it("maps the app root and files inside the renderer directory", () => {
    expect(rendererFilePath(dir, "app://pinomad/")).toBe(join(dir, "index.html"));
    expect(rendererFilePath(dir, "app://pinomad")).toBe(join(dir, "index.html"));
    expect(rendererFilePath(dir, "app://pinomad/index.html")).toBe(join(dir, "index.html"));
    expect(rendererFilePath(dir, "app://pinomad/assets/app-abc123.js")).toBe(join(dir, "assets", "app-abc123.js"));
    expect(rendererFilePath(dir, "app://pinomad/assets/app.css?v=1#x")).toBe(join(dir, "assets", "app.css"));
  });

  it("rejects anything resolving outside the renderer dir", () => {
    // %2f survives URL parsing and decodes here into real separators, so a
    // post-decode `..` or a leading `//` can still aim outside the dir.
    expect(rendererFilePath(dir, "app://pinomad/%2e%2e%2f%2e%2e%2fetc%2fpasswd")).toBeUndefined();
    expect(rendererFilePath(dir, "app://pinomad/assets/..%2f..%2fpackage.json")).toBeUndefined();
    expect(rendererFilePath(dir, "app://pinomad//etc/passwd")).toBeUndefined();
    expect(rendererFilePath(dir, "app://pinomad/%2f%2fetc%2fpasswd")).toBeUndefined();
    expect(rendererFilePath(dir, "app://pinomad/%")).toBeUndefined();
  });

  it("rejects anything that is not an app: URL", () => {
    expect(rendererFilePath(dir, "https://pinomad.example.com/")).toBeUndefined();
    expect(rendererFilePath(dir, "file:///etc/passwd")).toBeUndefined();
    expect(rendererFilePath(dir, "not a url")).toBeUndefined();
  });

  it("keeps URL-normalized dots inside the dir", () => {
    // The URL parser collapses literal `..` and plain `%2e%2e` before we see
    // them; the result is a path inside the renderer dir, which a missing
    // file turns into a 404.
    expect(rendererFilePath(dir, "app://pinomad/../secret")).toBe(join(dir, "secret"));
    expect(rendererFilePath(dir, "app://pinomad/%2e%2e/secret")).toBe(join(dir, "secret"));
  });
});

describe("contentTypeFor", () => {
  it("types the bundled asset kinds", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("app.js")).toContain("javascript");
    expect(contentTypeFor("app.css")).toContain("text/css");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("icon.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });
});
