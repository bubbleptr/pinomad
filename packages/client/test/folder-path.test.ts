import { describe, expect, it } from "vitest";
import { folderCrumbs, parentFolder } from "../src/folder-path.ts";

describe("folderCrumbs", () => {
  it("starts at ~ under home", () => {
    expect(folderCrumbs("/Users/v/code/x", "/Users/v")).toEqual([
      { label: "~", path: "/Users/v" },
      { label: "code", path: "/Users/v/code" },
      { label: "x", path: "/Users/v/code/x" },
    ]);
  });

  it("is just ~ at home itself", () => {
    expect(folderCrumbs("/Users/v", "/Users/v")).toEqual([{ label: "~", path: "/Users/v" }]);
  });

  it("starts at / outside home", () => {
    expect(folderCrumbs("/srv/app", "/Users/v")).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "app", path: "/srv/app" },
    ]);
    expect(folderCrumbs("/", "/Users/v")).toEqual([{ label: "/", path: "/" }]);
  });

  it("does not treat a shared prefix as under home", () => {
    expect(folderCrumbs("/Users/vx", "/Users/v")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "vx", path: "/Users/vx" },
    ]);
  });

  it("uses the / form when home is /", () => {
    expect(folderCrumbs("/srv", "/")).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
    ]);
  });
});

describe("parentFolder", () => {
  it("climbs one level and stops at /", () => {
    expect(parentFolder("/a/b")).toBe("/a");
    expect(parentFolder("/a")).toBe("/");
    expect(parentFolder("/")).toBeUndefined();
  });
});
