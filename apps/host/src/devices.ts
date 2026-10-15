// The paired-device registry and pairing offers for the secure channel, plus
// the host's long-term X25519 identity. Session-scoped like IndexDoc.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { ed25519 } from "@noble/curves/ed25519.js";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { DeviceEntry, DeviceSource, HostDevices } from "@pinomad/protocol/devices.ts";
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

/**
 * Public keys the user revoked (ADR-0022 §6). A separate session doc, not a
 * field of DevicesDoc: the `devices` stream republishes that whole document to
 * every client, and revocation is host bookkeeping — the same reason push
 * tokens live in `pinomad.push`.
 */
export const RevocationsDoc = defineDoc<{ revoked: string[] }>({
  kind: "pinomad.revocations",
  version: 1,
  scope: "session",
  initial: () => ({ revoked: [] }),
});

export type DeviceAdmission =
  /** The public key is already paired; a `pair` payload on it spends no offer. */
  | { readonly outcome: "registered" }
  /** A new device landed; `entry` is the committed record. */
  | { readonly outcome: "admitted"; readonly entry: DeviceEntry }
  | { readonly outcome: "refused" };

/**
 * Admission of a secure-channel device in ONE commit (ADR-0022 §6): the offer
 * check and the account-policy checks must observe the state that decides them
 * at the moment the device lands — a revocation, a flipped switch, or a
 * rewritten server.json between a separate check and the write would sneak a
 * device past all three. `acceptAccountDevices` and `serverBinding` are read
 * inside the commit for exactly that reason.
 */
export async function admitDevice(
  harness: Harness,
  input: {
    readonly publicKey: string;
    /** The pair payload from the client hello; absent → only a registered key passes. */
    readonly pair?: { readonly secret: string; readonly name: string };
    readonly offers: PairingOffers;
    /** Live read of the setting, called inside the commit. */
    readonly acceptAccountDevices: () => boolean;
    /** The current server.json binding, read inside the commit; undefined when absent or unreadable. */
    readonly serverBinding: () => Promise<string | undefined>;
  },
  context: Context,
): Promise<DeviceAdmission> {
  return await harness.commit(async (tx) => {
    const devices = await tx.doc(DevicesDoc);
    if (devices.devices.some((entry) => entry.publicKey === input.publicKey)) {
      return { outcome: "registered" };
    }
    if (input.pair === undefined) return { outcome: "refused" };
    const offer = input.offers.consume(input.pair.secret);
    if (offer === undefined) return { outcome: "refused" };
    const revocations = await tx.doc(RevocationsDoc);
    if (offer.source === "account") {
      const binding = await input.serverBinding();
      // Every condition is re-read here, not at offer mint: join/leave rewrites
      // server.json before the host restarts, and only this instant counts.
      // The binding is per file incarnation, so a re-join to the same origin
      // still retires offers minted before it.
      if (
        revocations.revoked.includes(input.publicKey)
        || binding === undefined
        || offer.binding !== binding
        || !input.acceptAccountDevices()
      ) {
        return { outcome: "refused" };
      }
    }
    const name = input.pair.name.trim().slice(0, 64) || "Unknown device";
    const entry: DeviceEntry = { publicKey: input.publicKey, name, pairedAt: Date.now(), source: offer.source };
    devices.devices.push(entry);
    // Pairing again was a deliberate local act (a fresh scan, a loopback
    // link): forgive the revocation. Account offers never get this far for a
    // revoked key — the check above already refused them.
    if (revocations.revoked.includes(input.publicKey)) {
      revocations.revoked = revocations.revoked.filter((key) => key !== input.publicKey);
    }
    return { outcome: "admitted", entry };
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
    // `wx` like loadRelayKey: `pinomad join` beside a starting host must not
    // see two processes write different identities over the same file.
    try {
      await writeFile(path, `${toBase64Url(pair.privateKey)}\n`, { flag: "wx", mode: 0o600 });
    } catch (race) {
      if ((race as { code?: string }).code !== "EEXIST") throw race;
      return loadHostKey(dataDir);
    }
    return pair;
  }
}

/**
 * The host's relay identity at `<dataDir>/relay-key` (base64url Ed25519 secret,
 * mode 0600). Deliberately a separate key from the X25519 `host-key` — no
 * cross-protocol key reuse: this one only signs relay challenges (proving the
 * right to a hostId); end-to-end security still rests on the Noise host key.
 * `wx` + EEXIST re-read keeps `relay-id` beside a live host single-writer safe.
 */
export async function loadRelayKey(dataDir: string): Promise<{ secretKey: Uint8Array; publicKey: Uint8Array }> {
  const path = join(dataDir, "relay-key");
  try {
    const secretKey = fromBase64Url((await readFile(path, "utf8")).trim());
    if (secretKey.length !== 32) throw new Error(`bad relay key in ${path}`);
    return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    const { secretKey, publicKey } = ed25519.keygen();
    try {
      await writeFile(path, `${toBase64Url(secretKey)}\n`, { flag: "wx", mode: 0o600 });
    } catch (race) {
      if ((race as { code?: string }).code !== "EEXIST") throw race;
      return loadRelayKey(dataDir);
    }
    return { secretKey, publicKey };
  }
}

/** What a spent offer was issued for — the source a registration inherits (ADR-0022 §6). */
export interface PairingOffer {
  readonly source: DeviceSource;
  /** The server binding an account offer was minted under; absent otherwise. */
  readonly binding?: string;
}

/**
 * One-time pairing offers. In-memory only: an offer that survives a restart
 * would let someone pair without ever seeing the QR again, and the QR itself
 * dies with the process anyway. The host alone decides an offer's source — the
 * client's handshake never gets a say (ADR-0022 §6).
 */
export interface PairingOffers {
  /** A fresh 128-bit offer, single-use; `source` is how it reaches the device. */
  create(source: Exclude<DeviceSource, "account">): { secret: string; expiresAt: number };
  /** A fresh offer bound to `binding` — the joined server hands it to a device it vouches for. */
  createAccount(binding: string): { secret: string; expiresAt: number };
  /** Spends `secret` once; expired, used, or revoked secrets yield undefined. */
  consume(secret: string): PairingOffer | undefined;
  /**
   * Forget every account-source offer: the setting or the server binding that
   * justified them is gone, and waiting out the TTL would leave a window.
   */
  revokeAccount(): void;
}

export function pairingOffers(ttlMs = 5 * 60 * 1000): PairingOffers {
  const live = new Map<string, { expiresAt: number; source: DeviceSource; binding?: string }>();
  const prune = (): void => {
    const now = Date.now();
    for (const [secret, offer] of live) if (offer.expiresAt <= now) live.delete(secret);
  };
  const mint = (offer: PairingOffer): { secret: string; expiresAt: number } => {
    prune();
    const secret = toBase64Url(randomBytes(16));
    const expiresAt = Date.now() + ttlMs;
    live.set(secret, { expiresAt, ...offer });
    return { secret, expiresAt };
  };
  return {
    create: (source) => mint({ source }),
    createAccount: (binding) => mint({ source: "account", binding }),
    consume(secret) {
      prune();
      const candidate = Buffer.from(secret);
      for (const [key, offer] of live) {
        const offerBytes = Buffer.from(key);
        // Length mismatch is a fast reject; equal lengths compare in constant time.
        if (offerBytes.length !== candidate.length) continue;
        if (timingSafeEqual(offerBytes, candidate)) {
          live.delete(key);
          return offer;
        }
      }
      return undefined;
    },
    revokeAccount() {
      for (const [key, offer] of live) if (offer.source === "account") live.delete(key);
    },
  };
}
