import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import {
  FOCUS_KEY,
  LEGACY_ACTIVE_HOST_KEY,
  focusPairedHost,
  readFocus,
  rememberedHostFocus,
  seedRememberedFocus,
  writeFocus,
} from "./focus.ts";

const host = (): StoredHost => ({
  url: "wss://example/secure",
  hostKey: toBase64Url(generateKeyPair().publicKey),
  privateKey: toBase64Url(generateKeyPair().privateKey),
});

beforeEach(() => localStorage.clear());

describe("focus storage", () => {
  it("remembers a conversation ref and restores it", () => {
    const a = host();
    const b = host();
    writeFocus(localStorage, { hostKey: b.hostKey, conversationId: 7 as ConversationId });
    expect(readFocus(localStorage, [a, b])).toEqual({ hostKey: b.hostKey, conversationId: 7 });
    expect(JSON.parse(localStorage.getItem(FOCUS_KEY)!)).toEqual({ hostKey: b.hostKey, conversationId: 7 });
  });

  it("migrates the legacy activeHost key once", () => {
    const a = host();
    const b = host();
    localStorage.setItem(LEGACY_ACTIVE_HOST_KEY, b.hostKey);
    expect(readFocus(localStorage, [a, b])).toEqual({ hostKey: b.hostKey });
    expect(localStorage.getItem(LEGACY_ACTIVE_HOST_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(FOCUS_KEY)!)).toEqual({ hostKey: b.hostKey });
  });

  it("falls back to the first host when the remembered one is gone or malformed", () => {
    const a = host();
    localStorage.setItem(FOCUS_KEY, JSON.stringify({ hostKey: "gone", conversationId: 3 }));
    expect(readFocus(localStorage, [a])).toEqual({ hostKey: a.hostKey });
    localStorage.setItem(FOCUS_KEY, "not json");
    expect(readFocus(localStorage, [a])).toEqual({ hostKey: a.hostKey });
    expect(readFocus(localStorage, [])).toBeUndefined();
  });

  it("keeps the outgoing host's conversation when focusing a newly paired host", () => {
    const last = new Map<string, ConversationId>([["host-a", 1 as ConversationId]]);
    expect(focusPairedHost(last, { hostKey: "host-a", conversationId: 1 as ConversationId }, "host-b")).toEqual({
      hostKey: "host-b",
    });
    expect(last.get("host-a")).toBe(1);
  });

  it("keeps the persisted conversation when a refresh re-pairs the same host", () => {
    // A reload starts the in-memory map empty; the persisted focus is the
    // only record of A's conversation. Initialization seeds it, and pairing A
    // again must not drop the conversation.
    const last = new Map<string, ConversationId>();
    const persisted = { hostKey: "host-a", conversationId: 5 as ConversationId };
    seedRememberedFocus(last, persisted);
    const afterRepair = focusPairedHost(last, persisted, "host-a");
    expect(afterRepair).toEqual(persisted);

    // Pairing B moves focus and snapshots A for the menu.
    expect(focusPairedHost(last, afterRepair, "host-b")).toEqual({ hostKey: "host-b" });
    expect(rememberedHostFocus(last, "host-a")).toEqual(persisted);
  });

  it("captures the live conversation before a new pairing moves focus", () => {
    const last = new Map<string, ConversationId>();
    focusPairedHost(last, { hostKey: "host-a", conversationId: 2 as ConversationId }, "host-b");
    expect(last.get("host-a")).toBe(2);
  });

  it("drops an invalid conversation id instead of restoring half a ref", () => {
    const a = host();
    localStorage.setItem(FOCUS_KEY, JSON.stringify({ hostKey: a.hostKey, conversationId: "nope" }));
    expect(readFocus(localStorage, [a])).toEqual({ hostKey: a.hostKey });
  });
});
