import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { generateKeyPair } from "@pinomad/protocol/noise.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { FOCUS_KEY, LEGACY_ACTIVE_HOST_KEY, focusPairedHost, readFocus, writeFocus } from "./focus.ts";

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

  it("keeps a host's conversation when the same host is paired again", () => {
    const last = new Map<string, ConversationId>([["host-a", 1 as ConversationId]]);
    expect(focusPairedHost(last, { hostKey: "host-a", conversationId: 1 as ConversationId }, "host-a")).toEqual({
      hostKey: "host-a",
    });
    expect(last.get("host-a")).toBe(1);
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
