// Server accounts (ADR-0022 §2): the server persists users, sessions, join
// tokens, and host bindings in <dataDir>/server.sqlite, guarded by the same
// one-process-per-directory lock the host uses. Secrets never reach the DB in
// the clear — passwords are scrypt hashes, session and join tokens are SHA-256.
//
// `node:sqlite` needs Node: the server runs on Node like the host, not Bun.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { lockDataDir } from "./lock.ts";

const DB_FILE = "server.sqlite";
const SCHEMA_VERSION = 1;

// Sessions die 30 days after issue and are never renewed — a stolen token has a
// hard ceiling, and re-logging-in is the only way forward.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Join tokens are short-lived and single-use (ADR-0022 §3): a leaked one is
// only useful for minutes and only once.
const JOIN_TOKEN_TTL_MS = 10 * 60 * 1000;

// scrypt parameters are embedded in the stored string, so they can be raised
// later without a flag day for existing hashes.
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

// Shared with the login endpoint (api.ts): credentials outside these bounds
// are refused there, so creating one here would mint an account nobody can
// log into.
export const MIN_PASSWORD_CODEPOINTS = 12;
export const MAX_PASSWORD_CODEPOINTS = 1024;
export const MAX_USERNAME_CODEPOINTS = 254;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { readonly N: number; readonly r: number; readonly p: number },
) => Promise<Buffer>;

/** A valid-format hash whose verify always fails — unknown users still pay the scrypt cost. */
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${"A".repeat(22)}$${"A".repeat(43)}`;

export interface LoginLimits {
  /** scrypt computations at once; default 4. */
  readonly scryptConcurrency?: number;
  /** Pending scrypt work beyond the running set; default 64. Full → 429. */
  readonly scryptQueue?: number;
  /** Login attempts per source IP per window; default 30 per 5 min. */
  readonly ipMaxAttempts?: number;
  readonly ipWindowMs?: number;
  /** Failed logins per username before lockout; default 5 per 15 min. */
  readonly userMaxFailures?: number;
  readonly userWindowMs?: number;
  /** Cap on both counter maps — a sprayed key space can't grow them without bound. */
  readonly counterMaxEntries?: number;
}

export interface AccountsOptions {
  readonly dataDir: string;
  /** Bootstrap credentials (PINOMAD_SERVER_USER/PASSWORD); required only while the users table is empty. */
  readonly bootstrapUser?: string;
  readonly bootstrapPassword?: string;
  readonly now?: () => number;
  readonly lockStaleMs?: number;
  readonly limits?: LoginLimits;
}

export type LoginResult =
  | { readonly status: "ok"; readonly token: string; readonly expiresAt: number }
  | { readonly status: "invalid" }
  | { readonly status: "limited" };

export type JoinHostResult =
  | { readonly status: "joined"; readonly username: string }
  | { readonly status: "refused"; readonly reason: "invalid_token" | "expired_token" };

/** A bound host row as the API lists and looks it up. */
export interface HostRow {
  readonly hostId: string;
  readonly userId: number;
  readonly noisePublicKey: string;
  readonly name: string;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
}

export interface Accounts {
  /** Server database path — tests write join_tokens rows directly. */
  readonly dbPath: string;
  login(username: string, password: string, ip: string): Promise<LoginResult>;
  /** Resolves a session token to its user, or undefined when unknown/expired. */
  authenticate(token: string): { readonly userId: number; readonly username: string } | undefined;
  logout(token: string): void;
  revokeAllSessions(userId: number): void;
  /** True when hostId is bound to an account — the only way a host registers. */
  hasHost(hostId: string): boolean;
  /** Mints a single-use join token for a logged-in user; only its SHA-256 is stored. */
  createJoinToken(userId: number): { readonly token: string; readonly expiresAt: number };
  /**
   * Spends a join token and writes or rebinds the hosts row in one transaction —
   * the token must never be consumed without a binding landing beside it.
   */
  joinHost(args: {
    readonly token: string;
    readonly hostId: string;
    readonly noisePublicKey: string;
    readonly name?: string;
  }): JoinHostResult;
  /** Drops a host's account binding; false when the hostId was never bound. */
  leaveHost(hostId: string): boolean;
  /** Every host bound to a user — GET /api/hosts. */
  listHosts(userId: number): HostRow[];
  /**
   * The host row scoped to its owner. Callers must never probe by hostId
   * alone: a host that belongs to someone else looks exactly like "not found".
   */
  hostFor(userId: number, hostId: string): HostRow | undefined;
  /** Bumps last_seen_at on each successful register; a no-op for unbound hostIds. */
  markHostSeen(hostId: string): void;
  close(): Promise<void>;
}

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // "scrypt$N$r$p$salt$hash" — params come from the stored string so hash
  // strength can be raised for new passwords while old ones still verify.
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Params come out of the database, so bound them anyway: a corrupt row must
  // not be able to request a memory-bomb scrypt.
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0 || expected.length > 256) return false;
  const derived = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(derived, expected);
}

function assertPasswordPolicy(password: string): void {
  const length = [...password].length;
  if (length < MIN_PASSWORD_CODEPOINTS || length > MAX_PASSWORD_CODEPOINTS) {
    throw new Error(`password must be ${MIN_PASSWORD_CODEPOINTS}–${MAX_PASSWORD_CODEPOINTS} characters`);
  }
}

function assertUsernamePolicy(username: string): void {
  const length = [...username].length;
  if (length === 0 || length > MAX_USERNAME_CODEPOINTS) {
    throw new Error(`username must be 1–${MAX_USERNAME_CODEPOINTS} characters`);
  }
}

function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`server database schema ${version} is newer than this build (${SCHEMA_VERSION})`);
  }
  if (version === SCHEMA_VERSION) return;
  // Schema is defined once up front — join_tokens and hosts exist from day one
  // even though their writers arrive in later steps (roadmap M3). The whole
  // migration is one transaction so a crash can't leave a half-made schema.
  db.exec(`
    BEGIN;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE join_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE hosts (
      host_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      noise_public_key TEXT NOT NULL,
      name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

/** Fixed-window counters with a hard cap: full maps evict the oldest entries instead of growing. */
class WindowedCounter {
  private readonly map = new Map<string, { count: number; resetAt: number }>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(maxEntries: number, now: () => number) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  /** Counts one hit for `key`; returns true when the key is already at `max` inside its window. */
  hit(key: string, max: number, windowMs: number): boolean {
    if (this.isOver(key, max)) return true;
    this.bump(key, windowMs);
    return false;
  }

  isOver(key: string, max: number): boolean {
    const entry = this.map.get(key);
    return entry !== undefined && entry.resetAt > this.now() && entry.count >= max;
  }

  bump(key: string, windowMs: number): void {
    const now = this.now();
    let entry = this.map.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      // Re-set keeps insertion order fresh; on a full map the oldest entry loses its slot.
      this.map.delete(key);
      if (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next();
        if (!oldest.done) this.map.delete(oldest.value);
      }
      this.map.set(key, entry);
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.map.delete(key);
  }
}

/** Bounded concurrency for scrypt: CPU-heavy hashing can't be allowed to queue unboundedly. */
class ScryptGate {
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly maxQueue: number;
  constructor(concurrency: number, maxQueue: number) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
  }

  /** Runs `task` within the concurrency budget; undefined means the queue is full. */
  run<T>(task: () => Promise<T>): Promise<T> | undefined {
    if (this.running < this.concurrency) {
      this.running += 1;
      return this.finish(task());
    }
    if (this.waiters.length >= this.maxQueue) return undefined;
    return new Promise<T>((resolve, reject) => {
      this.waiters.push(() => {
        this.running += 1;
        void this.finish(task()).then(resolve, reject);
      });
    });
  }

  private async finish<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } finally {
      this.running -= 1;
      this.waiters.shift()?.();
    }
  }
}

export async function openAccounts(options: AccountsOptions): Promise<Accounts> {
  const now = options.now ?? Date.now;
  await mkdir(options.dataDir, { recursive: true });
  const release = await lockDataDir(options.dataDir, { staleMs: options.lockStaleMs });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(options.dataDir, DB_FILE));
    migrate(db);
    const userCount = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    if (userCount === 0) {
      if (options.bootstrapUser === undefined || options.bootstrapPassword === undefined) {
        throw new Error("PINOMAD_SERVER_USER and PINOMAD_SERVER_PASSWORD are required to create the first account");
      }
      assertUsernamePolicy(options.bootstrapUser);
      assertPasswordPolicy(options.bootstrapPassword);
      const hash = await hashPassword(options.bootstrapPassword);
      db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(
        options.bootstrapUser,
        hash,
        now(),
      );
    }
  } catch (error) {
    db?.close();
    await release();
    throw error;
  }

  const limits = {
    scryptConcurrency: options.limits?.scryptConcurrency ?? 4,
    scryptQueue: options.limits?.scryptQueue ?? 64,
    ipMaxAttempts: options.limits?.ipMaxAttempts ?? 30,
    ipWindowMs: options.limits?.ipWindowMs ?? 5 * 60_000,
    userMaxFailures: options.limits?.userMaxFailures ?? 5,
    userWindowMs: options.limits?.userWindowMs ?? 15 * 60_000,
    counterMaxEntries: options.limits?.counterMaxEntries ?? 4096,
  };
  const gate = new ScryptGate(limits.scryptConcurrency, limits.scryptQueue);
  const ipAttempts = new WindowedCounter(limits.counterMaxEntries, now);
  const userFailures = new WindowedCounter(limits.counterMaxEntries, now);

  return {
    dbPath: join(options.dataDir, DB_FILE),

    async login(username, password, ip) {
      if (ipAttempts.hit(ip, limits.ipMaxAttempts, limits.ipWindowMs)) return { status: "limited" };
      // Username lockout applies to existing and non-existing names alike —
      // checking existence first would leak which usernames are real.
      if (userFailures.isOver(username, limits.userMaxFailures)) return { status: "limited" };
      const user = db
        .prepare("SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ?")
        .get(username) as { id: number; username: string; passwordHash: string } | undefined;
      // Re-check inside the task: a burst queues requests that all pass the
      // first check; once earlier failures lock the name, queued work must
      // refuse instead of still verifying (and possibly issuing a session).
      // The failure count is bumped in the task too, so the next queued task's
      // re-check sees it — recording after the await would lag one behind.
      const outcome = await gate.run(async (): Promise<"limited" | "invalid" | number> => {
        if (userFailures.isOver(username, limits.userMaxFailures)) return "limited";
        const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
        if (!ok || user === undefined) {
          userFailures.bump(username, limits.userWindowMs);
          return "invalid";
        }
        return user.id;
      });
      if (outcome === undefined || outcome === "limited") return { status: "limited" };
      if (outcome === "invalid") return { status: "invalid" };
      userFailures.reset(username);
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + SESSION_TTL_MS;
      db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
        sha256Hex(token),
        outcome,
        now(),
        expiresAt,
      );
      return { status: "ok", token, expiresAt };
    },

    authenticate(token) {
      const row = db
        .prepare(
          `SELECT s.user_id AS userId, u.username AS username, s.expires_at AS expiresAt
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        )
        .get(sha256Hex(token)) as { userId: number; username: string; expiresAt: number } | undefined;
      if (row === undefined || row.expiresAt <= now()) return undefined;
      return { userId: row.userId, username: row.username };
    },

    logout(token) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
    },

    revokeAllSessions(userId) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    },

    hasHost(hostId) {
      return db.prepare("SELECT 1 AS x FROM hosts WHERE host_id = ?").get(hostId) !== undefined;
    },

    createJoinToken(userId) {
      // Sweep dead rows opportunistically, the same convention as expired
      // sessions on login.
      db.prepare("DELETE FROM join_tokens WHERE expires_at <= ?").run(now());
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + JOIN_TOKEN_TTL_MS;
      db.prepare("INSERT INTO join_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
        sha256Hex(token),
        userId,
        now(),
        expiresAt,
      );
      return { token, expiresAt };
    },

    joinHost({ token, hostId, noisePublicKey, name }) {
      const tokenHash = sha256Hex(token);
      const at = now();
      db.exec("BEGIN");
      try {
        const row = db
          .prepare("SELECT user_id AS userId, expires_at AS expiresAt, used_at AS usedAt FROM join_tokens WHERE token_hash = ?")
          .get(tokenHash) as { userId: number; expiresAt: number; usedAt: number | null } | undefined;
        let failure: "invalid_token" | "expired_token" | undefined;
        if (row === undefined || row.usedAt !== null) failure = "invalid_token";
        else if (row.expiresAt <= at) failure = "expired_token";
        else {
          // The conditional UPDATE is what makes the token single-use: it
          // claims the row atomically, so a concurrent re-spend sees zero
          // changes and is refused instead of binding twice.
          const consumed = db
            .prepare("UPDATE join_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
            .run(at, tokenHash);
          if (Number(consumed.changes) !== 1) failure = "invalid_token";
        }
        if (failure !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: failure };
        }
        const hostName = name === undefined || name.trim() === "" ? "Unknown host" : name.trim().slice(0, 64);
        // Re-joining an already-bound hostId rebinds it (a new account gets it);
        // the upsert is what makes a lost join response safe to retry.
        db.prepare(
          `INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(host_id) DO UPDATE SET
             user_id = excluded.user_id,
             noise_public_key = excluded.noise_public_key,
             name = excluded.name,
             joined_at = excluded.joined_at,
             last_seen_at = excluded.last_seen_at`,
        ).run(hostId, row!.userId, noisePublicKey, hostName, at, at);
        const user = db.prepare("SELECT username FROM users WHERE id = ?").get(row!.userId) as
          | { username: string }
          | undefined;
        db.exec("COMMIT");
        return { status: "joined", username: user?.username ?? "unknown" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    leaveHost(hostId) {
      return Number(db.prepare("DELETE FROM hosts WHERE host_id = ?").run(hostId).changes) > 0;
    },

    listHosts(userId) {
      return db
        .prepare(
          `SELECT host_id AS hostId, user_id AS userId, noise_public_key AS noisePublicKey,
                  name, joined_at AS joinedAt, last_seen_at AS lastSeenAt
           FROM hosts WHERE user_id = ? ORDER BY joined_at`,
        )
        .all(userId) as unknown as HostRow[];
    },

    hostFor(userId, hostId) {
      return db
        .prepare(
          `SELECT host_id AS hostId, user_id AS userId, noise_public_key AS noisePublicKey,
                  name, joined_at AS joinedAt, last_seen_at AS lastSeenAt
           FROM hosts WHERE user_id = ? AND host_id = ?`,
        )
        .get(userId, hostId) as HostRow | undefined;
    },

    markHostSeen(hostId) {
      db.prepare("UPDATE hosts SET last_seen_at = ? WHERE host_id = ?").run(now(), hostId);
    },

    async close() {
      db.close();
      await release();
    },
  };
}

/**
 * `pinomad server passwd`: changes the password while the server is stopped —
 * the directory lock doubles as the "is it running" check. One transaction
 * swaps the hash and drops every session and unused join token, so a leaked
 * password can't leave live credentials behind.
 */
export async function changePassword(options: {
  readonly dataDir: string;
  readonly user?: string;
  readonly password: string;
}): Promise<void> {
  assertPasswordPolicy(options.password);
  await mkdir(options.dataDir, { recursive: true });
  // retries: 0 fails fast against a running server's fresh lock; the default
  // stale value must match what servers use or a live lock looks abandoned.
  const release = await lockDataDir(options.dataDir, { retries: 0 });
  const db = new DatabaseSync(join(options.dataDir, DB_FILE));
  try {
    migrate(db);
    const users = (
      options.user === undefined
        ? db.prepare("SELECT id FROM users").all()
        : db.prepare("SELECT id FROM users WHERE username = ?").all(options.user)
    ) as { id: number }[];
    if (users.length === 0) throw new Error(options.user === undefined ? "no account exists yet" : `no such account: ${options.user}`);
    if (users.length > 1) throw new Error("more than one account exists — pass --user");
    const userId = users[0]!.id;
    const hash = await hashPassword(options.password);
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM join_tokens WHERE user_id = ? AND used_at IS NULL").run(userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
    await release();
  }
}
