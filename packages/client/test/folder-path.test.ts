import { describe, expect, it } from "vitest";
import { folderCrumbs, parentFolder } from "../src/folder-path.ts";
import { CRUMB_CASES, PARENT_FOLDER_CASES } from "./misc-cases.ts";

const C = <T extends readonly { name: string }[]>(cases: T, name: string): T[number] =>
  cases.find((c) => c.name === name) as T[number];

describe("folderCrumbs", () => {
  it("starts at ~ under home", () => {
    const c = C(CRUMB_CASES, "under-home");
    expect(folderCrumbs(c.path, c.home)).toEqual([
      { label: "~", path: "/Users/v" },
      { label: "code", path: "/Users/v/code" },
      { label: "x", path: "/Users/v/code/x" },
    ]);
  });

  it("is just ~ at home itself", () => {
    const c = C(CRUMB_CASES, "at-home");
    expect(folderCrumbs(c.path, c.home)).toEqual([{ label: "~", path: "/Users/v" }]);
  });

  it("starts at / outside home", () => {
    const app = C(CRUMB_CASES, "outside-home");
    expect(folderCrumbs(app.path, app.home)).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "app", path: "/srv/app" },
    ]);
    const root = C(CRUMB_CASES, "root");
    expect(folderCrumbs(root.path, root.home)).toEqual([{ label: "/", path: "/" }]);
  });

  it("does not treat a shared prefix as under home", () => {
    const c = C(CRUMB_CASES, "shared-prefix");
    expect(folderCrumbs(c.path, c.home)).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "vx", path: "/Users/vx" },
    ]);
  });

  it("uses the / form when home is /", () => {
    const c = C(CRUMB_CASES, "home-is-root");
    expect(folderCrumbs(c.path, c.home)).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
    ]);
  });
});

describe("parentFolder", () => {
  it("climbs one level and stops at /", () => {
    expect(parentFolder(C(PARENT_FOLDER_CASES, "nested").path)).toBe("/a");
    expect(parentFolder(C(PARENT_FOLDER_CASES, "top").path)).toBe("/");
    expect(parentFolder(C(PARENT_FOLDER_CASES, "root").path)).toBeUndefined();
  });
});
