import { describe, expect, it } from "vitest";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { agentOf, queuedInput, queueItems, statusText, taskRows, usageRows } from "../src/chat.ts";
import {
  AGENT_CASES,
  IS_BUSY_CASES,
  QUEUED_INPUT_CASES,
  QUEUE_CASES,
  STATUS_CASES,
  TASK_GRAPH_CASES,
  USAGE_CASES,
  chatView,
} from "./chat-cases.ts";

describe("agentOf", () => {
  it("returns an empty agent when no pi.agent doc exists", () => {
    expect(agentOf(AGENT_CASES.find((c) => c.name === "empty")!.input)).toEqual({});
  });

  it("returns the pi.agent doc verbatim", () => {
    expect(agentOf(AGENT_CASES.find((c) => c.name === "set")!.input)).toEqual({
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "high",
      cwd: "/w/project",
    });
  });
});

describe("statusText", () => {
  it("names what the conversation is doing, most specific first", () => {
    expect(statusText(STATUS_CASES.find((c) => c.name === "idle")!.input)).toBe("");
    expect(statusText(STATUS_CASES.find((c) => c.name === "run")!.input)).toBe("");
    expect(statusText(STATUS_CASES.find((c) => c.name === "tools")!.input)).toBe("");
    expect(statusText(STATUS_CASES.find((c) => c.name === "retry")!.input)).toBe("Retrying (attempt 2): overloaded");
    expect(statusText(STATUS_CASES.find((c) => c.name === "compaction")!.input)).toBe("Compacting (manual)...");
  });

  it("shows a deferred generation", () => {
    expect(statusText(STATUS_CASES.find((c) => c.name === "deferred")!.input)).toBe("Waiting for deferred response...");
  });

  it("shows a compaction retry", () => {
    expect(statusText(STATUS_CASES.find((c) => c.name === "compaction-retry")!.input)).toBe(
      "Retrying manual compaction (attempt 3)...",
    );
  });
});

describe("queueItems", () => {
  it("lists queued inputs with their mode", () => {
    expect(queueItems(QUEUE_CASES.find((c) => c.name === "steer-followup")!.input)).toEqual([
      { id: 1, mode: "steer", text: "focus", imageCount: 0, attachmentCount: 0 },
      { id: 2, mode: "followUp", text: "then this", imageCount: 0, attachmentCount: 0 },
    ]);
  });

  it("counts the image blocks a queued input carries", () => {
    expect(queueItems(QUEUE_CASES.find((c) => c.name === "images")!.input)).toEqual([
      { id: 1, mode: "followUp", text: "look", imageCount: 2, attachmentCount: 0 },
      { id: 2, mode: "write", text: "<pi.note>", imageCount: 0, attachmentCount: 0 },
    ]);
  });

  it("counts ref images too", () => {
    expect(queueItems(QUEUE_CASES.find((c) => c.name === "images-ref")!.input)).toEqual([
      { id: 1, mode: "steer", text: "look", imageCount: 2, attachmentCount: 0 },
    ]);
  });

  it("previews what the user typed, not the skill blocks the host prepended", () => {
    expect(queueItems(QUEUE_CASES.find((c) => c.name === "skill-blocks")!.input)).toEqual([
      { id: 1, mode: "steer", text: "$review now", imageCount: 0, attachmentCount: 0 },
      { id: 2, mode: "followUp", text: "look $review", imageCount: 1, attachmentCount: 0 },
    ]);
  });

  it("counts attachments and leaves their block out of the preview", () => {
    expect(queueItems(QUEUE_CASES.find((c) => c.name === "attachments")!.input)).toEqual([
      { id: 1, mode: "steer", text: "look", imageCount: 1, attachmentCount: 1 },
      { id: 2, mode: "followUp", text: "", imageCount: 0, attachmentCount: 1 },
    ]);
  });
});

describe("queuedInput", () => {
  it("returns the original text and images of a queued steer or follow-up", () => {
    const steer = QUEUED_INPUT_CASES.find((c) => c.name === "steer")!.input;
    expect(queuedInput(steer.view, steer.id)).toEqual({ text: "focus", images: [], skills: [], attachments: [] });

    const images = QUEUED_INPUT_CASES.find((c) => c.name === "images")!.input;
    expect(queuedInput(images.view, images.id)).toEqual({
      text: "look",
      images: [
        { data: "aGk=", mimeType: "image/png" },
        { data: "aGk=", mimeType: "image/png" },
      ],
      skills: [],
      attachments: [],
    });

    const refs = QUEUED_INPUT_CASES.find((c) => c.name === "images-ref")!.input;
    expect(queuedInput(refs.view, refs.id)).toEqual({
      text: "look",
      images: [
        { data: "aGk=", mimeType: "image/png" },
        { ref: "5f2a", mimeType: "image/jpeg" },
      ],
      skills: [],
      attachments: [],
    });
  });

  it("refills the composer with what the user typed, without the skill blocks", () => {
    const skill = QUEUED_INPUT_CASES.find((c) => c.name === "skill-blocks")!.input;
    // `skills` lets the composer restore the picked chips.
    expect(queuedInput(skill.view, skill.id)).toEqual({
      text: "$review then x",
      images: [{ data: "aGk=", mimeType: "image/png" }],
      skills: ["review"],
      attachments: [],
    });
  });

  it("restores the attachment ids an edit sends back", () => {
    const attachments = QUEUED_INPUT_CASES.find((c) => c.name === "attachments")!.input;
    expect(queuedInput(attachments.view, attachments.id)).toEqual({
      text: "look",
      images: [{ data: "aGk=", mimeType: "image/png" }],
      skills: [],
      attachments: [{ id: "A".repeat(22), name: "notes.txt", size: 5 }],
    });
  });

  it("has nothing for a write, an unknown id, or no inbox", () => {
    const write = QUEUED_INPUT_CASES.find((c) => c.name === "write")!.input;
    expect(queuedInput(write.view, write.id)).toBeUndefined();
    const future = QUEUED_INPUT_CASES.find((c) => c.name === "future-mode")!.input;
    expect(queuedInput(future.view, future.id)).toBeUndefined();
    const missing = QUEUED_INPUT_CASES.find((c) => c.name === "missing")!.input;
    expect(queuedInput(missing.view, missing.id)).toBeUndefined();
    expect(queuedInput(chatView(), 1)).toBeUndefined();
  });
});

describe("taskRows", () => {
  it("nests owned tasks and conversation-owned tasks under their owner", () => {
    expect(taskRows(TASK_GRAPH_CASES.find((c) => c.name === "tree")!.input)).toEqual([
      { id: 1, depth: 0, label: "pi.generation #1: waiting on 2" },
      { id: 2, depth: 1, label: "pi.tool #2: running run owns conversation 5" },
      { id: 3, depth: 2, label: "pi.generation #3: running request [aborting]" },
    ]);
  });
});

describe("usageRows", () => {
  it("sums usage per model and tool", () => {
    expect(usageRows(USAGE_CASES.find((c) => c.name === "model-and-tool")!.input)).toEqual([
      { key: "faux/faux-1", input: 120, output: 30, cost: 0.002 },
      { key: "search_logs", input: 0, output: 0, cost: 0 },
    ]);
    expect(usageRows(USAGE_CASES.find((c) => c.name === "empty")!.input)).toEqual([]);
    expect(usageRows(chatView())).toEqual([]);
  });
});

describe("isBusy", () => {
  it("is busy exactly while pi.live.run is present", () => {
    expect(isBusy(IS_BUSY_CASES.find((c) => c.name === "idle")!.input)).toBe(false);
    expect(isBusy(IS_BUSY_CASES.find((c) => c.name === "run")!.input)).toBe(true);
    expect(isBusy(IS_BUSY_CASES.find((c) => c.name === "run-null")!.input)).toBe(true);
    expect(isBusy(IS_BUSY_CASES.find((c) => c.name === "no-live")!.input)).toBe(false);
  });
});
