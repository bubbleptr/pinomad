import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Mailer } from "../src/accounts.ts";

/** Remove a test temp dir and the data-dir lock proper-lockfile puts beside it. */
export async function removeTempDir(path: string): Promise<void> {
  await Promise.all([
    rm(path, { recursive: true, force: true }),
    rm(`${path}.lock`, { recursive: true, force: true }),
  ]);
}

/** A fresh temp data dir, tracked in `dirs` for afterEach cleanup. */
export async function tempDir(dirs: string[], prefix = "pinomad-server-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A message the fake mailer was asked to send. */
export interface SentMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** A mailer that keeps what it was asked to send; `codeFor` digs the 6-digit code out of the last mail to an address. */
export function fakeMailer(): Mailer & { readonly sent: SentMail[]; codeFor(to: string): string | undefined } {
  const sent: SentMail[] = [];
  return {
    sent,
    send(to, subject, { text, html }) {
      sent.push({ to, subject, text, html });
      return Promise.resolve();
    },
    codeFor(to) {
      const mail = sent.findLast((message) => message.to === to);
      return mail === undefined ? undefined : /\b(\d{6})\b/.exec(mail.text)?.[1];
    },
  };
}

/**
 * Rewrites a current database back to schema 9: no sign-in flows, pending
 * provider sign-ins, one-time codes or re-auth grants, and identities without
 * a name or Apple refresh token (#620).
 */
/** Rewrites a current database back to schema 10: accounts without an account id (#640). */
export function downgradeToSchema10(dataDir: string): void {
  const db = new DatabaseSync(join(dataDir, "server.sqlite"), { enableForeignKeyConstraints: false });
  db.exec(`
    DROP TRIGGER users_account_id_fill;
    DROP INDEX users_account_id;
    ALTER TABLE users DROP COLUMN account_id;
    PRAGMA user_version = 10;
  `);
  db.close();
}

export function downgradeToSchema9(dataDir: string): void {
  downgradeToSchema10(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"), { enableForeignKeyConstraints: false });
  db.exec(`
    DROP TABLE reauth_grants;
    DROP TABLE oauth_codes;
    DROP TABLE oauth_pending;
    DROP TABLE oauth_flows;
    ALTER TABLE user_identities DROP COLUMN name;
    ALTER TABLE user_identities DROP COLUMN refresh_token;
    ALTER TABLE user_identities DROP COLUMN refresh_client_id;
    PRAGMA user_version = 9;
  `);
  db.close();
}

/**
 * Rewrites a current database back to schema 8: usernames only, every
 * account with a password, invites and the admin flag (ADR-0044). The users
 * table is rebuilt (SQLite can't drop a UNIQUE column) with foreign keys
 * off, so dropping the old one doesn't cascade. Every account must still
 * have a username.
 */
export function downgradeToSchema8(dataDir: string): void {
  downgradeToSchema9(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"), { enableForeignKeyConstraints: false });
  db.exec(`
    DROP TABLE email_codes;
    DROP TABLE user_identities;
    CREATE TABLE users_v8 (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users_v8 (id, username, password_hash, created_at) SELECT id, username, password_hash, created_at FROM users;
    UPDATE users_v8 SET admin = 1 WHERE id = (SELECT MIN(id) FROM users_v8);
    DROP TABLE users;
    ALTER TABLE users_v8 RENAME TO users;
    CREATE TABLE invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    PRAGMA user_version = 8;
  `);
  db.close();
}

/** Rewrites a current database back to schema 7: host links without the loopback columns (#513). */
export function downgradeToSchema7(dataDir: string): void {
  downgradeToSchema8(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"));
  db.exec(`
    DROP INDEX host_link_requests_request_id;
    DROP INDEX host_link_requests_auth_code;
    ALTER TABLE host_link_requests DROP COLUMN request_id_hash;
    ALTER TABLE host_link_requests DROP COLUMN redirect_uri;
    ALTER TABLE host_link_requests DROP COLUMN code_challenge;
    ALTER TABLE host_link_requests DROP COLUMN client_state;
    ALTER TABLE host_link_requests DROP COLUMN auth_code_hash;
    ALTER TABLE host_link_requests DROP COLUMN auth_code_expires_at;
    PRAGMA user_version = 7;
  `);
  db.close();
}

/** Rewrites a current database back to schema 6: no record of removed hosts (#512). */
export function downgradeToSchema6(dataDir: string): void {
  downgradeToSchema7(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"));
  db.exec("DROP TABLE removed_hosts; PRAGMA user_version = 6;");
  db.close();
}

/**
 * Rewrites a current database back to schema 5: no host-link requests, join
 * tokens bound to no host (#495).
 */
export function downgradeToSchema5(dataDir: string): void {
  downgradeToSchema6(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"));
  db.exec(`
    DROP TABLE host_link_requests;
    ALTER TABLE join_tokens DROP COLUMN host_id;
    PRAGMA user_version = 5;
  `);
  db.close();
}

/**
 * Rewrites a current database back to schema 4: push registrations without
 * the account device that made them. SQLite can't drop a column that is in
 * an index or a foreign key, so the table is rebuilt.
 */
export function downgradeToSchema4(dataDir: string): void {
  downgradeToSchema5(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"));
  db.exec(`
    CREATE TABLE push_tokens_v4 (
      token TEXT NOT NULL,
      environment TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (token, environment)
    );
    INSERT INTO push_tokens_v4 SELECT token, environment, user_id, updated_at FROM push_tokens;
    DROP TABLE push_tokens;
    ALTER TABLE push_tokens_v4 RENAME TO push_tokens;
    CREATE INDEX push_tokens_user ON push_tokens (user_id, updated_at);
    PRAGMA user_version = 4;
  `);
  db.close();
}

/**
 * Rewrites a current database back to schema 3: no account devices or
 * device reports, sessions without a device column (ADR-0037). Foreign keys
 * are off on this raw connection, so the rebuild doesn't cascade.
 */
export function downgradeToSchema3(dataDir: string): void {
  downgradeToSchema4(dataDir);
  const db = new DatabaseSync(join(dataDir, "server.sqlite"));
  db.exec(`
    DROP TABLE pending_revocations;
    DROP TABLE vouchings;
    CREATE TABLE sessions_v3 (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    INSERT INTO sessions_v3 SELECT token_hash, user_id, created_at, expires_at FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_v3 RENAME TO sessions;
    DROP TABLE account_devices;
    ALTER TABLE hosts DROP COLUMN device_reports;
    PRAGMA user_version = 3;
  `);
  db.close();
}
