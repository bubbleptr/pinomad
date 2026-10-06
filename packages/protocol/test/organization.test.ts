import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { homeOf, type HostIndex, organize, type Project } from "../src/organization.ts";
import type { ConversationSummary } from "../src/view.ts";

const project = (path: string, addedAt = 1): Project => ({ path, name: path.split("/").at(-1)!, addedAt });
const summary = (id: number, parent?: number, title?: string): ConversationSummary => ({
  id: id as ConversationId,
  kind: parent === undefined ? "conversation" : "fork",
  ...(parent === undefined ? {} : { parent: parent as ConversationId }),
  ...(title === undefined ? {} : { title }),
});
const chat = (id: number, createdAt: number) => ({ id: id as ConversationId, home: { kind: "chat" } as const, createdAt });
const inProject = (id: number, path: string, createdAt: number) => ({
  id: id as ConversationId,
  home: { kind: "project", path } as const,
  createdAt,
});

describe("organize", () => {
  it("groups chats and project conversations, newest first", () => {
    const index: HostIndex = {
      projects: [project("/work/a", 1), project("/work/b", 2)],
      conversations: [chat(10, 100), inProject(11, "/work/a", 200), chat(12, 300), inProject(13, "/work/a", 50)],
    };
    const organized = organize(index, [summary(10), summary(11), summary(12), summary(13)]);
    expect(organized.chats.map((node) => node.summary.id)).toEqual([12, 10]);
    expect(organized.projects.map((entry) => entry.project.path)).toEqual(["/work/b", "/work/a"]);
    const a = organized.projects.find((entry) => entry.project.path === "/work/a")!;
    expect(a.conversations.map((node) => node.summary.id)).toEqual([11, 13]);
    expect(organized.projects.find((entry) => entry.project.path === "/work/b")!.conversations).toEqual([]);
  });

  it("drops archived entries and conversations of unregistered projects, which return on re-adding", () => {
    const index: HostIndex = {
      projects: [project("/work/a")],
      conversations: [chat(10, 1), { ...chat(11, 2), archived: true }, inProject(12, "/work/gone", 3)],
    };
    const summaries = [summary(10), summary(11), summary(12)];
    const first = organize(index, summaries);
    expect(first.chats.map((node) => node.summary.id)).toEqual([10]);
    expect(first.projects[0]!.conversations).toEqual([]);

    const readded = organize({ ...index, projects: [...index.projects, project("/work/gone")] }, summaries);
    const gone = readded.projects.find((entry) => entry.project.path === "/work/gone")!;
    expect(gone.conversations.map((node) => node.summary.id)).toEqual([12]);
  });

  it("nests forks of forks and subagents under their ancestor, and drops orphans", () => {
    const index: HostIndex = { projects: [], conversations: [chat(10, 1), chat(11, 2)] };
    const summaries = [
      summary(10),
      summary(11),
      summary(20, 10), // fork of 10
      summary(21, 20), // fork of the fork
      { ...summary(30, 10), kind: "subagent" as const },
      summary(40, 99), // parent chain never reaches an index entry
    ];
    const organized = organize(index, summaries);
    const [first, second] = organized.chats;
    expect(first!.summary.id).toBe(11);
    expect(first!.children).toEqual([]);
    expect(second!.children.map((node) => node.summary.id)).toEqual([20, 30]);
    expect(second!.children[0]!.children.map((node) => node.summary.id)).toEqual([21]);
    expect(organized.chats.flatMap((node) => node.summary.id)).not.toContain(40);
  });

  it("orders nested children by creation", () => {
    const index: HostIndex = { projects: [], conversations: [chat(10, 1)] };
    const organized = organize(index, [summary(10), summary(9, 10), summary(8, 10)]);
    expect(organized.chats[0]!.children.map((node) => node.summary.id)).toEqual([8, 9]);
  });
});

describe("homeOf", () => {
  const index: HostIndex = {
    projects: [project("/work/a")],
    conversations: [chat(10, 1), inProject(11, "/work/a", 2)],
  };

  it("returns the entry's home for top-level conversations", () => {
    expect(homeOf(index, [summary(10)], 10 as ConversationId)).toEqual({ kind: "chat" });
    expect(homeOf(index, [summary(11)], 11 as ConversationId)).toEqual({ kind: "project", path: "/work/a" });
  });

  it("inherits the top-level ancestor's home for nested children", () => {
    const summaries = [summary(11), summary(20, 11), summary(21, 20)];
    expect(homeOf(index, summaries, 21 as ConversationId)).toEqual({ kind: "project", path: "/work/a" });
    expect(homeOf(index, summaries, 42 as ConversationId)).toBeUndefined();
    expect(homeOf(index, summaries, 20 as ConversationId)).toEqual({ kind: "project", path: "/work/a" });
  });
});
