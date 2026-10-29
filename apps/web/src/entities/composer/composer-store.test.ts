import { describe, expect, it } from "vitest";
import { HostComposerStore } from "./composer-store.ts";

describe("HostComposerStore", () => {
  it("keeps the new draft's text, project, checkout and agent on one host", () => {
    const store = new HostComposerStore();
    const slot = store.slot("new");
    slot.restoreDraft("half-written prompt", ["review"]);
    slot.setHome({ kind: "project", path: "/work/pinomad" });
    slot.setCheckoutMode("local");
    slot.setAgent("tester");

    const same = store.slot("new");
    expect(same.snapshot()).toMatchObject({
      draft: { text: "half-written prompt" },
      home: { kind: "project", path: "/work/pinomad" },
      checkoutMode: "local",
      agent: "tester",
    });
  });

  it("does not leak a draft between hosts", () => {
    const first = new HostComposerStore();
    first.slot("new").restoreDraft("host A draft", []);
    const second = new HostComposerStore();
    expect(second.slot("new").snapshot().draft.text).toBe("");
    expect(second.slot("new").snapshot().home).toEqual({ kind: "chat" });
  });

  it("single-flights a create call on the slot", () => {
    const slot = new HostComposerStore().slot("new");
    expect(slot.beginSubmit()).toBe(true);
    expect(slot.beginSubmit()).toBe(false);
    expect(slot.snapshot().submitting).toBe(true);
    slot.endSubmit();
    expect(slot.snapshot().submitting).toBe(false);
    expect(slot.beginSubmit()).toBe(true);
  });

  it("keeps conversation slots apart", () => {
    const store = new HostComposerStore();
    store.slot("conversation:1").restoreDraft("one", []);
    expect(store.slot("conversation:2").snapshot().draft.text).toBe("");
    expect(store.slot("conversation:1").snapshot().draft.text).toBe("one");
  });
});
