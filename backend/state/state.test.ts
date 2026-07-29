/**
 * The state layer facade (spec 032 §2): what this suite proves, and what it
 * deliberately leaves to the addon's own.
 *
 * The addon's `sanity-state.mjs` (statecrafting spec 003, run on all three
 * platforms by that repo's build gate) proves the SURFACE: that `txn` is atomic,
 * that `query` and `queryConsistent` differ, that the fence is monotonic and
 * durable, that a lease is a lease. Repeating that here would test hiqlite twice
 * and this facade zero times.
 *
 * What is only true on this side, and is therefore what this file covers:
 *
 * 1. Every call adjudicates before crossing into Rust, against the right kind
 *    and resource. A capability declared in the model but granted to no service
 *    is denied in fact, not merely undocumented.
 * 2. The migration runner's policy: ordering, duplicate refusal, and idempotence
 *    across runs. That policy lives here precisely because the addon exposes no
 *    migrate entry point (spec 032 §3.6).
 *
 * The `state` service holds `db.migrate` and `db.read` on `state` and nothing
 * else. That is not a placeholder: it owns the schema, so it may change the
 * schema and read what version it is at, and it cannot write a row, take a
 * lease, publish a notify, or touch a backup. Those grants belong to phase 3's
 * control plane, and the denial assertions below are the evidence that
 * withholding them means something.
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APIError, ErrCode } from "encore.dev/api";
import { beforeAll, describe, expect, it } from "vitest";

import { runAsService } from "../kernel/adjudicate";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// The facade starts the embedded node at module load (backend/hiq/init.ts), so
// the environment has to be in place before the first import of it. A dynamic
// import inside beforeAll is what makes that ordering explicit rather than
// dependent on where a static import lands in the file.
let state: typeof import("./index");

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "state-facade-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;
  state = await import("./index");
  await state.ready;
}, 60_000);

describe("the facade adjudicates every crossing (spec 032 §2)", () => {
  it("allows what the state service was granted: schema change and version reads", async () => {
    await expect(runAsService("state", () => state.schemaVersion())).resolves.toBeTypeOf("number");
    await expect(
      runAsService("state", () => state.migrate([])),
    ).resolves.toEqual([]);
  });

  it("denies every capability declared but granted to no one", async () => {
    const ungranted: Array<[string, () => Promise<unknown>]> = [
      ["db.write via execute", () => state.execute("SELECT 1")],
      ["db.write via executeReturning", () => state.executeReturning("SELECT 1")],
      ["db.txn", () => state.txn([{ sql: "SELECT 1" }])],
      ["lock.acquire", () => state.lock("k")],
      ["notify.publish", () => state.notify({ kind: "k", name: "n", revision: 1 })],
      ["bucket.write", () => state.backup()],
      ["bucket.list local", () => state.backupListLocal()],
      ["bucket.list s3", () => state.backupListS3()],
    ];
    for (const [label, call] of ungranted) {
      await expect(
        runAsService("state", call),
        `${label} must be denied`,
      ).rejects.toThrow(/kernel:deny:capability:undeclared/);
    }
    // listen() is synchronous and throws rather than rejecting.
    expect(() => runAsService("state", () => state.listen(() => {}))).toThrow(
      /kernel:deny:capability:undeclared/,
    );
  });

  it("denies a read from a service that holds no state grant, with the typed error", async () => {
    let thrown: unknown;
    try {
      await runAsService("web", () => state.query("SELECT 1"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).code).toBe(ErrCode.PermissionDenied);
  });

  it("denies the unattributable: no service context means no ceiling to stand in", async () => {
    await expect(state.schemaVersion()).rejects.toThrow(/kernel:deny:service/);
  });
});

describe("the migration runner's policy (spec 032 §3.6)", () => {
  const table = "facade_migration_probe";

  it("applies pending migrations once and is idempotent on a second run", async () => {
    const migrations = [
      {
        version: 1,
        name: "create probe",
        statements: [`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, note TEXT)`],
      },
      {
        version: 2,
        name: "seed probe",
        statements: [`INSERT INTO ${table} (id, note) VALUES ('a', 'seeded')`],
      },
    ];

    const first = await runAsService("state", () => state.migrate(migrations));
    expect(first).toEqual([
      { version: 1, name: "create probe" },
      { version: 2, name: "seed probe" },
    ]);
    expect(await runAsService("state", () => state.schemaVersion())).toBe(2);

    // The second run must apply nothing. If it re-ran migration 2 the INSERT
    // would raise a primary-key violation, so this asserts idempotence twice:
    // once on the empty result and once by not throwing.
    const second = await runAsService("state", () => state.migrate(migrations));
    expect(second).toEqual([]);
    expect(await runAsService("state", () => state.schemaVersion())).toBe(2);
  });

  it("records what it applied in the migrations table, with the name it ran under", async () => {
    const rows = await runAsService("state", () =>
      state.query<{ version: number; name: string }>(
        `SELECT version, name FROM ${state.MIGRATIONS_TABLE} ORDER BY version`,
      ),
    );
    expect(rows.map((r) => [Number(r.version), r.name])).toEqual([
      [1, "create probe"],
      [2, "seed probe"],
    ]);
  });

  it("refuses a list it cannot reason about, before touching the store", async () => {
    const refusals: Array<[string, Parameters<typeof state.migrate>[0], RegExp]> = [
      [
        "duplicate versions",
        [
          { version: 7, name: "a", statements: ["SELECT 1"] },
          { version: 7, name: "b", statements: ["SELECT 1"] },
        ],
        /duplicate migration version 7/,
      ],
      [
        "descending versions",
        [
          { version: 9, name: "a", statements: ["SELECT 1"] },
          { version: 8, name: "b", statements: ["SELECT 1"] },
        ],
        /must ascend/,
      ],
      [
        "an empty migration",
        [{ version: 10, name: "empty", statements: [] }],
        /has no statements/,
      ],
      [
        "a non-integer version",
        [{ version: 1.5, name: "fractional", statements: ["SELECT 1"] }],
        /non-integer version/,
      ],
    ];
    for (const [label, list, message] of refusals) {
      await expect(
        runAsService("state", () => state.migrate(list)),
        `${label} must be refused`,
      ).rejects.toThrow(message);
    }
    // Nothing above reached the store: the schema version is still the one the
    // successful run left behind.
    expect(await runAsService("state", () => state.schemaVersion())).toBe(2);
  });
});
