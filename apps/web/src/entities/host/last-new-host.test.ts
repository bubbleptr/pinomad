import { describe, expect, it } from "vitest";
import { LAST_NEW_HOST_KEY, readLastNewHost, selectNewChatHost, writeLastNewHost } from "./last-new-host.ts";

const A = { hostKey: "host-a" };
const B = { hostKey: "host-b" };
const C = { hostKey: "host-c" };
const hosts = [A, B, C];

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("selectNewChatHost", () => {
  it("uses the last new host when it is still paired and connected", () => {
    expect(
      selectNewChatHost({
        hosts,
        lastNewHost: B.hostKey,
        connected: (hostKey) => hostKey === A.hostKey || hostKey === B.hostKey,
      }),
    ).toBe(B.hostKey);
  });

  it("falls back to the first connected host in stored order", () => {
    expect(
      selectNewChatHost({
        hosts,
        lastNewHost: B.hostKey,
        connected: (hostKey) => hostKey === A.hostKey || hostKey === C.hostKey,
      }),
    ).toBe(A.hostKey);
  });

  it("keeps the last new host when nothing is connected and it is still paired", () => {
    expect(selectNewChatHost({ hosts, lastNewHost: C.hostKey, connected: () => false })).toBe(C.hostKey);
  });

  it("falls back to the first paired host when nothing is connected and the last one is gone", () => {
    expect(selectNewChatHost({ hosts, lastNewHost: "forgotten", connected: () => false })).toBe(A.hostKey);
    expect(selectNewChatHost({ hosts, lastNewHost: undefined, connected: () => false })).toBe(A.hostKey);
  });

  it("never picks an unpaired host even if it reports connected", () => {
    expect(
      selectNewChatHost({
        hosts,
        lastNewHost: "forgotten",
        connected: (hostKey) => hostKey === "forgotten" || hostKey === B.hostKey,
      }),
    ).toBe(B.hostKey);
  });

  it("returns undefined without paired hosts", () => {
    expect(selectNewChatHost({ hosts: [], lastNewHost: undefined, connected: () => true })).toBeUndefined();
    expect(selectNewChatHost({ hosts: [], lastNewHost: "host-a", connected: () => true })).toBeUndefined();
  });
});

describe("last new host storage", () => {
  it("round-trips the host key", () => {
    const values = storage();
    expect(readLastNewHost(values)).toBeUndefined();
    writeLastNewHost(values, B.hostKey);
    expect(values.getItem(LAST_NEW_HOST_KEY)).toBe(B.hostKey);
    expect(readLastNewHost(values)).toBe(B.hostKey);
  });

  it("treats an empty stored value as absent", () => {
    expect(readLastNewHost(storage({ [LAST_NEW_HOST_KEY]: "" }))).toBeUndefined();
  });
});
