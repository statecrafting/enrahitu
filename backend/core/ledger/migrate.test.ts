/**
 * The migration seam (spec 027 §3.4, §4 item 7).
 *
 * The runner itself is spec 011's and is tested there. What is new is the act
 * around it: one `db.migrate` adjudication for the whole run, a version report
 * that does not write on the way past, and a concurrent loser that says what
 * happened instead of surfacing a constraint violation.
 *
 * The concurrency test is a real race rather than a simulated one. Two runners
 * share one file; the second is held between its read of applied versions and
 * its first transaction, which is the exact window the race lives in, and
 * released after the first has committed. The conflict SQLite then reports is
 * the genuine one, and it arrives deterministically rather than when the test
 * machine happens to interleave two writers.
 *
 * Running it is what showed §3.4's expectation of that conflict to be wrong.
 * The loser does not reach the migrations table's primary key: it fails inside
 * its own `up()`, on "table migrate_test_a already exists", because the winner
 * created it first. A seam that recognised the loser by matching constraint
 * text would have passed this suite's intent and failed in production.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAsService } from "../../kernel/adjudicate";

import type { LedgerDriver } from "./driver";
import { Ledger } from "./ledger";
import { LibsqlDriver } from "./libsql";
import type { Migration } from "./migrations";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "members: add a note column",
    up: async (tx) => {
      await tx.execute(`CREATE TABLE "migrate_test_a" ("id" text PRIMARY KEY)`);
    },
  },
  {
    version: 2,
    name: "members: add an index",
    up: async (tx) => {
      await tx.execute(`CREATE TABLE "migrate_test_b" ("id" text PRIMARY KEY)`);
    },
  },
];

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> => runAsService("admin", fn);

let dir: string;
let url: string;
const open = (): LedgerDriver => new LibsqlDriver({ url });
const opened: LedgerDriver[] = [];

function ledgerOn(driver: LedgerDriver = open()): Ledger {
  opened.push(driver);
  return new Ledger(driver);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "enrahitu-migrate-"));
  url = `file:${join(dir, "ledger.db")}`;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((driver) => driver.close().catch(() => {})));
  rmSync(dir, { recursive: true, force: true });
});

describe("the migration seam", () => {
  it("reports version 0 before anything is applied, without creating the table", async () => {
    const ledger = ledgerOn();
    expect(await asAdmin(() => ledger.schemaVersion())).toBe(0);
    // A report that created the migrations table would be a write, and the
    // operator plane's GET would stop being a read.
    await expect(ledger.query(`SELECT 1 FROM "_coreledger_migrations"`)).rejects.toThrow();
  });

  it("applies every pending migration and reports where the ledger stands", async () => {
    const ledger = ledgerOn();
    const result = await asAdmin(() => ledger.migrate(MIGRATIONS));
    expect(result.applied).toEqual([1, 2]);
    expect(result.version).toBe(2);
    expect(result.concurrent).toBeUndefined();
    expect(await asAdmin(() => ledger.schemaVersion())).toBe(2);
  });

  it("applies nothing the second time, rather than failing on a constraint", async () => {
    const ledger = ledgerOn();
    await asAdmin(() => ledger.migrate(MIGRATIONS));
    const again = await asAdmin(() => ledger.migrate(MIGRATIONS));
    expect(again.applied).toEqual([]);
    expect(again.version).toBe(2);
  });

  it("applies a migration exactly once across two concurrent runners", async () => {
    const winner = ledgerOn();

    // The loser, held open between its read of applied versions and its first
    // transaction. Everything else passes straight through to a real driver.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const real = open();
    opened.push(real);
    const slow: LedgerDriver = {
      ...real,
      dialect: real.dialect,
      query: (sql, params) => real.query(sql, params),
      execute: (sql, params) => real.execute(sql, params),
      close: () => real.close(),
      async transaction(fn) {
        if (!blocked) {
          blocked = true;
          await held;
        }
        return real.transaction(fn);
      },
    };
    const loser = new Ledger(slow);

    const pending = asAdmin(() => loser.migrate(MIGRATIONS));
    await new Promise((resolve) => setImmediate(resolve));
    const won = await asAdmin(() => winner.migrate(MIGRATIONS));
    release();
    const lost = await pending;

    expect(won.applied).toEqual([1, 2]);
    // Legible rather than an exception, and careful about what it claims: the
    // versions became recorded while the loser ran, and the loser cannot know
    // that the winner is the one who recorded them, which is exactly what
    // `concurrent` says (spec 027 §4 item 7).
    expect(lost.concurrent).toMatch(/another runner/);
    expect(lost.applied).toEqual([1, 2]);
    expect(lost.version).toBe(2);
    expect(await asAdmin(() => winner.schemaVersion())).toBe(2);

    // Exactly once is the property under test, so it is asserted on the store
    // rather than inferred from the two reports.
    const rows = await winner.query(`SELECT version FROM "_coreledger_migrations" ORDER BY version`);
    expect(rows.map((row) => Number(row.version))).toEqual([1, 2]);
  });

  it("is denied to a service the manifest does not grant it to", async () => {
    // `members` holds no db.migrate on the app ledger, deliberately: a domain
    // service that could migrate is one that could migrate by accident.
    const ledger = ledgerOn();
    await expect(runAsService("members", () => ledger.migrate(MIGRATIONS))).rejects.toThrow(
      /capability db.migrate on 'app' denied for service 'members'/,
    );
  });

  it("adjudicates the whole run once rather than per statement", async () => {
    // The property that makes cap.db.app.migrate usable on its own: a service
    // holding only it can migrate. Holding db.read/db.write/db.txn as well
    // would be write access with a migration-shaped name.
    const ledger = ledgerOn();
    const result = await asAdmin(() => ledger.migrate(MIGRATIONS));
    expect(result.applied).toEqual([1, 2]);
  });
});
