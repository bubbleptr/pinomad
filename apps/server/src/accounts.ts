// Server accounts (ADR-0022 §2): the server persists users, sessions, join
// tokens, host bindings, the APNs tokens each account's devices registered
// (ADR-0036), and sign-up invites (#449) in <dataDir>/server.sqlite, guarded
// by the same one-process-per-directory lock the host uses. Secrets never
// reach the DB in the clear — passwords are scrypt hashes, session, join and
// invite tokens are SHA-256.
//
// `node:sqlite` needs Node: the server runs on Node like the host, not Bun.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { ApnsEnvironment } from "@pinomad/protocol/relay.ts";
import { normalizeHostName } from "@pinomad/protocol/settings.ts";
import { isDataDirInUse, lockDataDir } from "./lock.ts";

const DB_FILE = "server.sqlite";
const SCHEMA_VERSION = 3;

// Sessions die 30 days after issue and are never renewed — a stolen token has a
// hard ceiling, and re-logging-in is the only way forward.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Join tokens are short-lived and single-use (ADR-0022 §3): a leaked one is
// only useful for minutes and only once.
const JOIN_TOKEN_TTL_MS = 10 * 60 * 1000;

// Invites go out over chat or mail and wait for the recipient, so they live a
// week; each one creates at most one account (#449).
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Signed-up names are lowercase so two accounts can't differ only in case.
// The bootstrap account predates this rule and keeps whatever it was given.
const SIGN_UP_USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

// Push registrations (ADR-0036 §2, §5): the app refreshes its token on every
// connect and foreground, so one untouched for 90 days belongs to a device
// that is gone; an account keeps its 32 most recently refreshed.
const PUSH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PUSH_TOKENS_PER_USER = 32;

// Same bounds the host applies to `setPushToken` (apps/host/src/push.ts):
// Apple does not fix the length, so hex up to 256 characters.
const APNS_TOKEN_PATTERN = /^(?:[0-9a-f]{2})+$/;
const APNS_TOKEN_MAX_CHARS = 256;

/** The lowercase token when `raw` is a plausible APNs device token, else undefined. */
export function normalizeApnsToken(raw: string): string | undefined {
  const token = raw.toLowerCase();
  return token.length <= APNS_TOKEN_MAX_CHARS && APNS_TOKEN_PATTERN.test(token) ? token : undefined;
}

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
  | { readonly status: "ok"; readonly token: string; readonly expiresAt: number; readonly admin: boolean }
  | { readonly status: "invalid" }
  | { readonly status: "limited" };

export type ChangePasswordResult =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly reason: "wrong_password" | "weak_password" }
  | { readonly status: "limited" };

export type DeleteAccountResult =
  /** The account's hosts, whose control connections lost their authorization. */
  | { readonly status: "ok"; readonly hostIds: readonly string[] }
  | { readonly status: "refused"; readonly reason: "wrong_password" | "admin_account" }
  | { readonly status: "limited" };

export type RegisterResult =
  | { readonly status: "ok"; readonly token: string; readonly expiresAt: number }
  | {
      readonly status: "refused";
      readonly reason: "invalid_invite" | "invite_expired" | "invalid_username" | "weak_password" | "username_taken";
    }
  | { readonly status: "limited" };

/** An invite as the admin lists it; the code itself is never stored. */
export interface InviteRow {
  readonly id: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt?: number;
  readonly usedBy?: string;
}

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
  /**
   * Creates an account from an unspent invite and signs it in (#449). Counts
   * against the same per-address limit as login.
   */
  register(args: {
    readonly invite: string;
    readonly username: string;
    readonly password: string;
    readonly ip: string;
  }): Promise<RegisterResult>;
  /** Resolves a session token to its user, or undefined when unknown/expired. */
  authenticate(
    token: string,
  ): { readonly userId: number; readonly username: string; readonly admin: boolean } | undefined;
  /** Mints a single-use sign-up invite; only its SHA-256 is stored. Callers check admin. */
  createInvite(userId: number): { readonly code: string; readonly expiresAt: number };
  listInvites(): InviteRow[];
  /** Deletes an unspent invite; false when it doesn't exist or was already used. */
  revokeInvite(id: number): boolean;
  logout(token: string): void;
  revokeAllSessions(userId: number): void;
  /**
   * Self-service password change (#450): checks the current password under
   * the same username lockout as login, then swaps the hash and signs out
   * every other session, so a leaked password leaves no live credential
   * behind except the caller's.
   */
  changePassword(args: {
    readonly userId: number;
    readonly username: string;
    /** The caller's session token, which survives the change. */
    readonly keepToken: string;
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<ChangePasswordResult>;
  /**
   * Deletes the account after checking its password (#451). Sessions, join
   * tokens, host bindings and push registrations go with it; invites it used
   * stay used. Devices the hosts registered stay registered: revoking them
   * is the host's call (ADR-0022 §6). The admin account is kept, since it
   * alone mints invites.
   */
  deleteAccount(args: { readonly userId: number; readonly username: string; readonly password: string }): Promise<DeleteAccountResult>;
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
  /** The account a host is bound to, or undefined for an unbound hostId. */
  hostOwner(hostId: string): number | undefined;
  /**
   * Registers or refreshes a device's APNs token under `userId` (ADR-0036 §1-2).
   * A token belongs to one account at a time: registering it moves it here.
   */
  registerPushToken(userId: number, token: string, environment: ApnsEnvironment): void;
  /** Drops the registration only when `userId` owns it. */
  removePushToken(userId: number, token: string, environment: ApnsEnvironment): void;
  /** The account a live (refreshed within 90 days) registration belongs to. */
  pushTokenOwner(token: string, environment: ApnsEnvironment): number | undefined;
  /**
   * APNs reported the token invalid at `unregisteredAt`: drop the registration
   * only when it is older, so a late 410 never removes a fresh one (ADR-0025 §5).
   */
  forgetPushToken(token: string, environment: ApnsEnvironment, unregisteredAt: number): void;
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
  /**
   * Writes the bound host's current display name, cleaned by the same
   * `normalizeHostName` the host applies (issue #212); a no-op for unbound
   * hostIds. Register reports it and the `name` frame keeps it current.
   */
  renameHost(hostId: string, name: string): void;
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

// `server passwd` writes beside a running server (#450): both connections
// wait out the other's write instead of failing with SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000;

function openDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

const schemaVersion = (db: DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;

function migrate(db: DatabaseSync): void {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(`server database schema ${version} is newer than this build (${SCHEMA_VERSION})`);
  }
  if (version === SCHEMA_VERSION) return;
  // Each step is one transaction so a crash can't leave a half-made schema.
  // Schema 1 defined join_tokens and hosts up front even though their writers
  // arrived in later steps (roadmap M3).
  if (version < 1) migrateTo1(db);
  if (version < 2) {
    db.exec(`
      BEGIN;
      CREATE TABLE push_tokens (
        token TEXT NOT NULL,
        environment TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (token, environment)
      );
      CREATE INDEX push_tokens_user ON push_tokens (user_id, updated_at);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (version < 3) {
    // The first account is the operator's (the bootstrap one); it alone
    // mints invites.
    db.exec(`
      BEGIN;
      ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET admin = 1 WHERE id = (SELECT MIN(id) FROM users);
      -- AUTOINCREMENT: minting sweeps expired invites, and a reused id would
      -- let a revoke from a stale list hit a code already sent to someone.
      CREATE TABLE invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
}

function migrateTo1(db: DatabaseSync): void {
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
    PRAGMA user_version = 1;
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
    db = openDatabase(options.dataDir);
    migrate(db);
    const userCount = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    if (userCount === 0) {
      if (options.bootstrapUser === undefined || options.bootstrapPassword === undefined) {
        throw new Error("PINOMAD_SERVER_USER and PINOMAD_SERVER_PASSWORD are required to create the first account");
      }
      assertUsernamePolicy(options.bootstrapUser);
      assertPasswordPolicy(options.bootstrapPassword);
      const hash = await hashPassword(options.bootstrapPassword);
      db.prepare("INSERT INTO users (username, password_hash, created_at, admin) VALUES (?, ?, ?, 1)").run(
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

  const issueSession = (userId: number): { readonly token: string; readonly expiresAt: number } => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + SESSION_TTL_MS;
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      sha256Hex(token),
      userId,
      now(),
      expiresAt,
    );
    return { token, expiresAt };
  };

  const currentHash = (userId: number): string | undefined =>
    (db.prepare("SELECT password_hash AS passwordHash FROM users WHERE id = ?").get(userId) as { passwordHash: string } | undefined)
      ?.passwordHash;

  /**
   * Re-authentication for account changes: the password must match under the
   * same username lockout as login, with the same in-task re-check and bump
   * so queued guesses see each other. Hands back the hash it verified, which
   * the caller's write must still find.
   */
  const checkPassword = async (
    userId: number,
    username: string,
    password: string,
  ): Promise<"limited" | "wrong_password" | { readonly verifiedHash: string }> => {
    if (userFailures.isOver(username, limits.userMaxFailures)) return "limited";
    const stored = currentHash(userId);
    const outcome = await gate.run(async (): Promise<"limited" | "wrong_password" | "ok"> => {
      if (userFailures.isOver(username, limits.userMaxFailures)) return "limited";
      if (!(await verifyPassword(password, stored ?? DUMMY_HASH)) || stored === undefined) {
        userFailures.bump(username, limits.userWindowMs);
        return "wrong_password";
      }
      return "ok";
    });
    if (outcome === undefined || outcome === "limited") return "limited";
    if (outcome === "wrong_password") return "wrong_password";
    userFailures.reset(username);
    return { verifiedHash: stored! };
  };

  const inviteState = (codeHash: string): "ok" | "invalid_invite" | "invite_expired" => {
    const row = db.prepare("SELECT expires_at AS expiresAt, used_at AS usedAt FROM invites WHERE code_hash = ?").get(codeHash) as
      | { expiresAt: number; usedAt: number | null }
      | undefined;
    if (row === undefined || row.usedAt !== null) return "invalid_invite";
    return row.expiresAt <= now() ? "invite_expired" : "ok";
  };

  const usernameTaken = (username: string): boolean =>
    db.prepare("SELECT 1 AS x FROM users WHERE lower(username) = ?").get(username) !== undefined;

  return {
    dbPath: join(options.dataDir, DB_FILE),

    async login(username, password, ip) {
      if (ipAttempts.hit(ip, limits.ipMaxAttempts, limits.ipWindowMs)) return { status: "limited" };
      // Username lockout applies to existing and non-existing names alike —
      // checking existence first would leak which usernames are real.
      if (userFailures.isOver(username, limits.userMaxFailures)) return { status: "limited" };
      const user = db
        .prepare("SELECT id, username, password_hash AS passwordHash, admin FROM users WHERE username = ?")
        .get(username) as { id: number; username: string; passwordHash: string; admin: number } | undefined;
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
      // The hash was read before scrypt yielded; a password change or reset
      // that committed meanwhile must not be crossed by a session minted from
      // the old password.
      db.exec("BEGIN IMMEDIATE");
      let session: { readonly token: string; readonly expiresAt: number } | undefined;
      try {
        if (currentHash(outcome) === user?.passwordHash) session = issueSession(outcome);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (session === undefined) return { status: "invalid" };
      userFailures.reset(username);
      return { status: "ok", ...session, admin: user?.admin === 1 };
    },

    async register({ invite, username, password, ip }) {
      if (ipAttempts.hit(ip, limits.ipMaxAttempts, limits.ipWindowMs)) return { status: "limited" };
      const codeHash = sha256Hex(invite);
      // The invite goes first: only someone holding one learns whether a
      // username is taken.
      const invited = inviteState(codeHash);
      if (invited !== "ok") return { status: "refused", reason: invited };
      if (!SIGN_UP_USERNAME.test(username)) return { status: "refused", reason: "invalid_username" };
      const length = [...password].length;
      if (length < MIN_PASSWORD_CODEPOINTS || length > MAX_PASSWORD_CODEPOINTS) {
        return { status: "refused", reason: "weak_password" };
      }
      if (usernameTaken(username)) return { status: "refused", reason: "username_taken" };
      const hash = await gate.run(() => hashPassword(password));
      if (hash === undefined) return { status: "limited" };
      // Hashing yielded, so another sign-up may have spent the invite or taken
      // the name meanwhile: check both again and claim them in one transaction.
      db.exec("BEGIN");
      try {
        const again = inviteState(codeHash);
        const failure = again !== "ok" ? again : usernameTaken(username) ? "username_taken" : undefined;
        if (failure !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: failure };
        }
        const userId = Number(
          db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(username, hash, now())
            .lastInsertRowid,
        );
        // Conditional like joinHost's claim, so both single-use paths read the same.
        const claimed = db
          .prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL")
          .run(now(), userId, codeHash);
        if (Number(claimed.changes) !== 1) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: "invalid_invite" };
        }
        const session = issueSession(userId);
        db.exec("COMMIT");
        return { status: "ok", ...session };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    createInvite(userId) {
      // Expired invites nobody used are dead weight in the admin's list.
      db.prepare("DELETE FROM invites WHERE used_at IS NULL AND expires_at <= ?").run(now());
      const code = randomBytes(16).toString("base64url");
      const expiresAt = now() + INVITE_TTL_MS;
      db.prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
        sha256Hex(code),
        userId,
        now(),
        expiresAt,
      );
      return { code, expiresAt };
    },

    listInvites() {
      const rows = db
        .prepare(
          `SELECT i.id AS id, i.created_at AS createdAt, i.expires_at AS expiresAt, i.used_at AS usedAt, u.username AS usedBy
           FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC, i.id DESC`,
        )
        .all() as unknown as {
        id: number;
        createdAt: number;
        expiresAt: number;
        usedAt: number | null;
        usedBy: string | null;
      }[];
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ...(row.usedAt === null ? {} : { usedAt: row.usedAt }),
        ...(row.usedBy === null ? {} : { usedBy: row.usedBy }),
      }));
    },

    revokeInvite(id) {
      return Number(db.prepare("DELETE FROM invites WHERE id = ? AND used_at IS NULL").run(id).changes) > 0;
    },

    authenticate(token) {
      const row = db
        .prepare(
          `SELECT s.user_id AS userId, u.username AS username, u.admin AS admin, s.expires_at AS expiresAt
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        )
        .get(sha256Hex(token)) as { userId: number; username: string; admin: number; expiresAt: number } | undefined;
      if (row === undefined || row.expiresAt <= now()) return undefined;
      return { userId: row.userId, username: row.username, admin: row.admin === 1 };
    },

    logout(token) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
    },

    async changePassword({ userId, username, keepToken, currentPassword, newPassword }) {
      const length = [...newPassword].length;
      if (length < MIN_PASSWORD_CODEPOINTS || length > MAX_PASSWORD_CODEPOINTS) {
        return { status: "refused", reason: "weak_password" };
      }
      const checked = await checkPassword(userId, username, currentPassword);
      if (checked === "limited") return { status: "limited" };
      if (checked === "wrong_password") return { status: "refused", reason: "wrong_password" };
      const hash = await gate.run(() => hashPassword(newPassword));
      if (hash === undefined) return { status: "limited" };
      // Swap only the hash that was verified: a reset or another change that
      // committed while scrypt ran wins, and the old password no longer does.
      db.exec("BEGIN IMMEDIATE");
      try {
        const swapped = db
          .prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?")
          .run(hash, userId, checked.verifiedHash);
        if (Number(swapped.changes) !== 1) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: "wrong_password" };
        }
        dropCredentials(db, userId, sha256Hex(keepToken));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { status: "ok" };
    },

    async deleteAccount({ userId, username, password }) {
      const user = db.prepare("SELECT admin FROM users WHERE id = ?").get(userId) as { admin: number } | undefined;
      if (user?.admin === 1) return { status: "refused", reason: "admin_account" };
      const checked = await checkPassword(userId, username, password);
      if (checked === "limited") return { status: "limited" };
      if (checked === "wrong_password") return { status: "refused", reason: "wrong_password" };
      // Same compare-and-swap as a password change: a reset that committed
      // while scrypt ran means the password typed here no longer holds.
      db.exec("BEGIN IMMEDIATE");
      try {
        const hostIds = (db.prepare("SELECT host_id AS hostId FROM hosts WHERE user_id = ?").all(userId) as { hostId: string }[]).map(
          (row) => row.hostId,
        );
        // ON DELETE CASCADE takes sessions, join tokens, hosts and push
        // registrations; invites it used keep their row with used_by NULL.
        const deleted = db.prepare("DELETE FROM users WHERE id = ? AND password_hash = ?").run(userId, checked.verifiedHash);
        if (Number(deleted.changes) !== 1) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: "wrong_password" };
        }
        db.exec("COMMIT");
        return { status: "ok", hostIds };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    revokeAllSessions(userId) {
      // Signing out everywhere also stops every device of the account from
      // receiving pushes until it logs in and registers again (ADR-0036 §5).
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM push_tokens WHERE user_id = ?").run(userId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    hasHost(hostId) {
      return db.prepare("SELECT 1 AS x FROM hosts WHERE host_id = ?").get(hostId) !== undefined;
    },

    hostOwner(hostId) {
      const row = db.prepare("SELECT user_id AS userId FROM hosts WHERE host_id = ?").get(hostId) as
        | { userId: number }
        | undefined;
      return row?.userId;
    },

    registerPushToken(userId, token, environment) {
      const at = now();
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM push_tokens WHERE updated_at < ?").run(at - PUSH_TOKEN_TTL_MS);
        db.prepare(
          `INSERT INTO push_tokens (token, environment, user_id, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (token, environment) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at`,
        ).run(token.toLowerCase(), environment, userId, at);
        db.prepare(
          `DELETE FROM push_tokens WHERE user_id = ? AND rowid NOT IN (
             SELECT rowid FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
           )`,
        ).run(userId, userId, MAX_PUSH_TOKENS_PER_USER);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    removePushToken(userId, token, environment) {
      db.prepare("DELETE FROM push_tokens WHERE token = ? AND environment = ? AND user_id = ?").run(
        token.toLowerCase(),
        environment,
        userId,
      );
    },

    pushTokenOwner(token, environment) {
      const row = db
        .prepare("SELECT user_id AS userId FROM push_tokens WHERE token = ? AND environment = ? AND updated_at >= ?")
        .get(token.toLowerCase(), environment, now() - PUSH_TOKEN_TTL_MS) as { userId: number } | undefined;
      return row?.userId;
    },

    forgetPushToken(token, environment, unregisteredAt) {
      db.prepare("DELETE FROM push_tokens WHERE token = ? AND environment = ? AND updated_at < ?").run(
        token.toLowerCase(),
        environment,
        unregisteredAt,
      );
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
        // A join that reports no name at all stays "Unknown host"; a
        // reported one goes through the shared cleaning like every write.
        const hostName = name === undefined ? "Unknown host" : normalizeHostName(name);
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

    renameHost(hostId, name) {
      db.prepare("UPDATE hosts SET name = ? WHERE host_id = ?").run(normalizeHostName(name), hostId);
    },

    async close() {
      db.close();
      await release();
    },
  };
}

/**
 * Everything a password change must not leave live (#450): sessions (all but
 * `keepTokenHash`), unused join tokens, and push registrations, which a
 * signed-out device would otherwise keep receiving (ADR-0036 §5). Runs inside
 * the caller's transaction.
 */
function dropCredentials(db: DatabaseSync, userId: number, keepTokenHash?: string): void {
  if (keepTokenHash === undefined) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  else db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, keepTokenHash);
  db.prepare("DELETE FROM join_tokens WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare("DELETE FROM push_tokens WHERE user_id = ?").run(userId);
}

/**
 * `pinomad server passwd`: the operator resets an account's password, the
 * way a user who forgot theirs gets back in (#450). Works whether or not the
 * server is running: a stopped server's directory is locked and migrated as
 * usual; beside a running one it writes through SQLite's own locking, and
 * only when the database is on this build's schema, so an upgraded package
 * never migrates the tables under an older running server. One transaction
 * swaps the hash and drops the account's credentials, and the running server
 * reads sessions from the database on every request, so the account is
 * signed out at once.
 */
export async function resetPassword(options: {
  readonly dataDir: string;
  readonly user?: string;
  readonly password: string;
}): Promise<void> {
  assertPasswordPolicy(options.password);
  await mkdir(options.dataDir, { recursive: true });
  // retries: 0 answers "is a server running" at once; the default stale value
  // must match what servers use or a live lock looks abandoned.
  const release = await lockDataDir(options.dataDir, { retries: 0 }).catch((error: unknown) => {
    if (isDataDirInUse(error)) return undefined;
    throw error;
  });
  const db = openDatabase(options.dataDir);
  try {
    if (release !== undefined) {
      migrate(db);
    } else if (schemaVersion(db) !== SCHEMA_VERSION) {
      throw new Error(
        `the running server's database schema (${schemaVersion(db)}) differs from this build's (${SCHEMA_VERSION}); restart the server on this version first`,
      );
    }
    const users = (
      options.user === undefined
        ? db.prepare("SELECT id FROM users").all()
        : db.prepare("SELECT id FROM users WHERE username = ?").all(options.user)
    ) as { id: number }[];
    if (users.length === 0) throw new Error(options.user === undefined ? "no account exists yet" : `no such account: ${options.user}`);
    if (users.length > 1) throw new Error("more than one account exists — pass --user");
    const userId = users[0]!.id;
    const hash = await hashPassword(options.password);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      dropCredentials(db, userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
    await release?.();
  }
}
