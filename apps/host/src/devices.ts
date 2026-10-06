// The paired-device registry and pairing offers for the secure channel, plus
// the host's long-term X25519 identity. Session-scoped like IndexDoc.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { DeviceEntry, HostDevices } from "@pinomad/protocol/devices.ts";
import { generateKeyPair, type KeyPair, keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";

export const DevicesDoc = defineDoc<HostDevices>({
  kind: "pinomad.devices",
  version: 1,
  scope: "session",
  initial: () => ({ devices: [] }),
});

export async function ensureDevices(harness: Harness, context: Context): Promise<void> {
  await harness.commit(async (tx) => void (await tx.doc(DevicesDoc)), context);
}

export async function isRegistered(harness: Harness, publicKey: string, context: Context): Promise<boolean> {
  return await harness.commit(async (tx) => (await tx.doc(DevicesDoc)).devices.some((entry) => entry.publicKey === publicKey), context);
}

export async function registerDevice(
  harness: Harness,
  device: { readonly publicKey: string; readonly name: string },
  context: Context,
): Promise<DeviceEntry> {
  return await harness.commit(async (tx) => {
    const doc = await tx.doc(DevicesDoc);
    const existing = doc.devices.find((entry) => entry.publicKey === device.publicKey);
    if (existing !== undefined) return { ...existing };
    const name = device.name.trim().slice(0, 64) || "Unknown device";
    const entry: DeviceEntry = { publicKey: device.publicKey, name, pairedAt: Date.now() };
    doc.devices.push(entry);
    return entry;
  }, context);
}

export async function revokeDevice(harness: Harness, publicKey: string, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(DevicesDoc);
    doc.devices = doc.devices.filter((entry) => entry.publicKey !== publicKey);
  }, context);
}

/**
 * The host's long-term X25519 identity at `<dataDir>/host-key` (base64url,
 * mode 0600 — the same sensitivity as the token file). Created on first
 * remote-access enable, stable across restarts.
 */
export async function loadHostKey(dataDir: string): Promise<KeyPair> {
  const path = join(dataDir, "host-key");
  try {
    const text = (await readFile(path, "utf8")).trim();
    return keyPairFromPrivate(fromBase64Url(text));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    const pair = generateKeyPair();
    await writeFile(path, `${toBase64Url(pair.privateKey)}\n`, { mode: 0o600 });
    return pair;
  }
}

/**
 * One-time pairing offers. In-memory only: an offer that survives a restart
 * would let someone pair without ever seeing the QR again, and the QR itself
 * dies with the process anyway.
 */
export interface PairingOffers {
  /** A fresh 128-bit offer, single-use. */
  create(): { secret: string; expiresAt: number };
  /** True only once per live offer; expired or already-used secrets return false. */
  consume(secret: string): boolean;
}

export function pairingOffers(ttlMs = 5 * 60 * 1000): PairingOffers {
  const live = new Map<string, number>();
  const prune = (): void => {
    const now = Date.now();
    for (const [secret, expiresAt] of live) if (expiresAt <= now) live.delete(secret);
  };
  return {
    create() {
      prune();
      const secret = toBase64Url(randomBytes(16));
      const expiresAt = Date.now() + ttlMs;
      live.set(secret, expiresAt);
      return { secret, expiresAt };
    },
    consume(secret) {
      prune();
      const candidate = Buffer.from(secret);
      for (const offer of live.keys()) {
        const offerBytes = Buffer.from(offer);
        // Length mismatch is a fast reject; equal lengths compare in constant time.
        if (offerBytes.length !== candidate.length) continue;
        if (timingSafeEqual(offerBytes, candidate)) {
          live.delete(offer);
          return true;
        }
      }
      return false;
    },
  };
}
