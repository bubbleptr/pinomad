// Invariants of the migrated schema, read from the database itself rather
// than from the migration source (old steps are history and never change).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openAccounts } from "../src/accounts.ts";
import { removeTempDir, tempDir } from "./support.ts";

/**
 * Rowid-alias ids that may be reused after a delete, each with why that is
 * safe. Without AUTOINCREMENT, SQLite hands the highest deleted id to the
 * next insert, so anything that kept the old id (a stale list, an await, a
 * client) would hit the new row (#472, #481, #483).
 */
const REUSABLE_IDS: Record<string, string> = {
  // Nothing outside the database holds a user id: clients and hosts only see
  // usernames and the random account_id (#640), sessions are random tokens, and every row that references a
  // user cascades or nulls (checked below). The relay limiter's in-memory
  // per-account state is dropped on deletion (#483), and the routes that
  // carry a user id across an await re-read it from the session or
  // compare-and-swap on the password hash (#481).
  users: "no user id outlives its row outside the database",
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function migratedDatabase(): Promise<DatabaseSync> {
  const accounts = await openAccounts({ dataDir: await tempDir(dirs), bootstrapUser: "admin", bootstrapPassword: "correct horse battery" });
  const path = accounts.dbPath;
  await accounts.close();
  return new DatabaseSync(path);
}

const tables = (db: DatabaseSync): { name: string; sql: string }[] =>
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
    sql: string;
  }[];

describe("migrated schema", () => {
  it("gives every rowid-alias id AUTOINCREMENT unless it is on the reviewed list", async () => {
    const db = await migratedDatabase();
    const reusable: string[] = [];
    for (const { name, sql } of tables(db)) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string; pk: number }[];
      const keys = columns.filter((column) => column.pk > 0);
      // Only a single INTEGER PRIMARY KEY column aliases the rowid.
      if (keys.length !== 1 || keys[0]!.type.toUpperCase() !== "INTEGER") continue;
      if (!/\bAUTOINCREMENT\b/i.test(sql)) reusable.push(name);
    }
    db.close();
    expect(reusable.sort()).toEqual(Object.keys(REUSABLE_IDS).sort());
  });

  it("cascades or nulls every reference to an exempt id, so no row keeps a reused one", async () => {
    const db = await migratedDatabase();
    const dangling: string[] = [];
    for (const { name } of tables(db)) {
      const keys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string; on_delete: string }[];
      for (const key of keys) {
        if (key.table in REUSABLE_IDS && key.on_delete !== "CASCADE" && key.on_delete !== "SET NULL") {
          dangling.push(`${name}.${key.from} -> ${key.table} (${key.on_delete})`);
        }
      }
    }
    db.close();
    expect(dangling).toEqual([]);
  });
});
