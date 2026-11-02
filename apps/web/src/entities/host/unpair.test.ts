// Unpairing ends the pairing at both ends when the host can be reached, and
// always drops this device's half — the two halves must not drift apart.
import { describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { DEVBOX_HOST } from "../../test/story-fixtures.tsx";
import { unpairHost } from "./unpair.ts";

describe("unpairHost", () => {
  it("asks the host to unpair this device's key, then forgets the host here", async () => {
    const order: string[] = [];
    const remote = {
      controller: {
        revokeDevice: vi.fn(async (publicKey: string) => {
          order.push(`revoke ${publicKey}`);
        }),
      },
    } as unknown as RemoteDurable;

    await unpairHost({
      host: DEVBOX_HOST,
      remote,
      forget: async (hostKey) => {
        order.push(`forget ${hostKey}`);
      },
    });

    const ownKey = toBase64Url(keyPairFromPrivate(fromBase64Url(DEVBOX_HOST.privateKey)).publicKey);
    expect(order).toEqual([`revoke ${ownKey}`, `forget ${DEVBOX_HOST.hostKey}`]);
  });

  it("forgets an unreachable host here only", async () => {
    const forget = vi.fn(async () => {});

    await unpairHost({ host: DEVBOX_HOST, remote: undefined, forget });

    expect(forget).toHaveBeenCalledWith(DEVBOX_HOST.hostKey);
  });
});
