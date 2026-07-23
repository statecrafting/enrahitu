/**
 * Decision-chain integrity acceptance (spec 024 §4): fork rejection at
 * the store, re-chaining over a moved head, fatal verification at init,
 * the crash-window marker, and the signature round-trips.
 *
 * Each case runs against a throwaway store: env is pointed at a fresh
 * file, the module registry is reset, and `./decisions` is imported
 * fresh, so init (which is write-once per module instance) re-runs.
 * Kernel boot re-evaluates too; a re-boot with the same model is
 * idempotent (spec 021 §3.4). Raw seeding goes through
 * `rawDriverFromEnv`, keeping driver construction inside its permitted
 * sites (spec 021 §3.2 ban-list).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRecord } from "@statecrafting/kernel-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LedgerDriver } from "../core/ledger/driver";
import { rawDriverFromEnv } from "../core/ledger/from-env";

import { receipt } from "./boot";
import { isUniqueViolation } from "./decisions";
import type { EffectDecisionPayload } from "./decisions";

type DecisionsModule = typeof import("./decisions");

const savedUrl = process.env.ENRAHITU_LEDGER_URL;
const SEED = "7f".repeat(32);

afterEach(() => {
  process.env.ENRAHITU_LEDGER_URL = savedUrl;
  delete process.env.ENRAHITU_LEDGER_SIGNING_KEY;
  vi.resetModules();
});

function freshDbUrl(): string {
  return `file:${join(mkdtempSync(join(tmpdir(), "enrahitu-ledger-integrity-")), "ledger.db")}`;
}

async function freshModule(url: string, signingKey?: string): Promise<DecisionsModule> {
  vi.resetModules();
  process.env.ENRAHITU_LEDGER_URL = url;
  if (signingKey === undefined) delete process.env.ENRAHITU_LEDGER_SIGNING_KEY;
  else process.env.ENRAHITU_LEDGER_SIGNING_KEY = signingKey;
  return import("./decisions");
}

async function withRaw<T>(url: string, fn: (d: LedgerDriver) => Promise<T>): Promise<T> {
  const prev = process.env.ENRAHITU_LEDGER_URL;
  process.env.ENRAHITU_LEDGER_URL = url;
  const d = rawDriverFromEnv();
  process.env.ENRAHITU_LEDGER_URL = prev;
  try {
    return await fn(d);
  } finally {
    await d.close();
  }
}

function denialPayload(reason: string): EffectDecisionPayload {
  return {
    modelHash: receipt.modelHash,
    gateConfigHash: receipt.gateConfigHash,
    service: "web",
    capability: { kind: "db.write", resource: "app" },
    contextHash: `sha256:${"0".repeat(64)}`,
    outcome: "deny",
    reason,
    checkIds: [],
  };
}

const INSERT = `INSERT INTO kernel_decisions (record_id, ts, prev_hash, record_hash, payload, signature) VALUES (?, ?, ?, ?, ?, ?)`;

describe("CAS append at the store (spec 024 §3.1)", () => {
  it("classifies both dialects' unique-violation shapes", () => {
    expect(
      isUniqueViolation({
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }),
    ).toBe(true);
    expect(
      isUniqueViolation({
        code: "SQLITE_CONSTRAINT_UNIQUE",
        message: "UNIQUE constraint failed: kernel_decisions.prev_hash",
      }),
    ).toBe(true);
    expect(isUniqueViolation(new Error("disk I/O error"))).toBe(false);
  });

  it("rejects a second child of an already-claimed parent", async () => {
    const url = freshDbUrl();
    const mod = await freshModule(url);
    await mod.ensureDecisionLedger();
    const genesis = (await mod.decisionRecords())[0]!;
    let caught: unknown;
    await withRaw(url, async (d) => {
      try {
        await d.execute(INSERT, [
          "forged-000001",
          new Date().toISOString(),
          genesis.previous_record_hash,
          `sha256:${"f".repeat(64)}`,
          "{}",
          null,
        ]);
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("chains onto a head moved out-of-band and still verifies", async () => {
    const url = freshDbUrl();
    const mod = await freshModule(url);
    await mod.ensureDecisionLedger();
    const records = await mod.decisionRecords();
    const head = records[records.length - 1]!;
    const moved = JSON.parse(
      buildRecord(
        head.record_hash,
        "outofband-000001",
        new Date().toISOString(),
        JSON.stringify(denialPayload("out-of-band writer")),
      ),
    ) as { id: string; timestamp: string; previous_record_hash: string; record_hash: string; payload: unknown };
    await withRaw(url, (d) =>
      d.execute(INSERT, [
        moved.id,
        moved.timestamp,
        moved.previous_record_hash,
        moved.record_hash,
        JSON.stringify(moved.payload),
        null,
      ]),
    );
    await mod.appendDecision(denialPayload("after the move"), "decision-aftermove");
    const verdict = await mod.verifyDecisionChain();
    expect(verdict).toEqual({ ok: true });
    const all = await mod.decisionRecords();
    expect(all[all.length - 1]!.previous_record_hash).toBe(moved.record_hash);
  });
});

describe("fatal verification at init (spec 024 §3.2)", () => {
  it("refuses init on a table that already carries a fork", async () => {
    const url = freshDbUrl();
    await withRaw(url, async (d) => {
      await d.execute(`CREATE TABLE kernel_decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        payload TEXT NOT NULL
      )`);
      const parent = `sha256:${"a".repeat(64)}`;
      await d.execute(
        `INSERT INTO kernel_decisions (record_id, ts, prev_hash, record_hash, payload) VALUES (?, ?, ?, ?, ?)`,
        ["decision-000001", new Date().toISOString(), parent, `sha256:${"b".repeat(64)}`, "{}"],
      );
      await d.execute(
        `INSERT INTO kernel_decisions (record_id, ts, prev_hash, record_hash, payload) VALUES (?, ?, ?, ?, ?)`,
        ["decision-000002", new Date().toISOString(), parent, `sha256:${"c".repeat(64)}`, "{}"],
      );
    });
    const mod = await freshModule(url);
    await expect(mod.ensureDecisionLedger()).rejects.toThrow(/carries a fork/);
  });

  it("refuses init on a tampered chain", async () => {
    const url = freshDbUrl();
    let mod = await freshModule(url);
    await mod.appendDecision(denialPayload("tamper target"), "decision-tampered");
    await withRaw(url, (d) =>
      d.execute(`UPDATE kernel_decisions SET payload = ? WHERE record_id = ?`, [
        JSON.stringify({ tampered: true }),
        "decision-tampered",
      ]),
    );
    mod = await freshModule(url);
    await expect(mod.ensureDecisionLedger()).rejects.toThrow(
      /chain verification failed at init/,
    );
  });
});

describe("the marked loss window (spec 024 §3.3)", () => {
  it("ledgers exactly one crash-window marker when the flag is set at init", async () => {
    const url = freshDbUrl();
    let mod = await freshModule(url);
    await mod.ensureDecisionLedger();
    await withRaw(url, (d) => d.execute(`UPDATE kernel_ledger_meta SET dirty = 1 WHERE id = 1`));
    mod = await freshModule(url);
    const records = await mod.decisionRecords();
    const markers = records.filter(
      (r) => (r.payload as { outcome?: string }).outcome === "unknown",
    );
    expect(markers).toHaveLength(1);
    expect((markers[0]!.payload as { reason: string }).reason).toMatch(/^crash-window:/);
    expect(markers[0]!.id).toMatch(/^marker-/);
    const dirty = await withRaw(url, (d) =>
      d.query(`SELECT dirty FROM kernel_ledger_meta WHERE id = 1`),
    );
    expect(Number(dirty[0]!.dirty)).toBe(0);
    expect(await mod.verifyDecisionChain()).toEqual({ ok: true });
  });

  it("drains a denial append and closes the bracket", async () => {
    const url = freshDbUrl();
    const mod = await freshModule(url);
    await mod.ensureDecisionLedger();
    const id = mod.recordDenial({
      service: "web",
      capability: { kind: "db.write", resource: "app" },
      result: {
        decision: { outcome: "deny", reason: "kernel:deny:test", checkIds: [], blocking: true },
        configHash: receipt.gateConfigHash,
        modelHash: receipt.modelHash,
      },
    });
    await mod.ensureDecisionLedger();
    const records = await mod.decisionRecords();
    expect(records.some((r) => r.id === id)).toBe(true);
    const dirty = await withRaw(url, (d) =>
      d.query(`SELECT dirty FROM kernel_ledger_meta WHERE id = 1`),
    );
    expect(Number(dirty[0]!.dirty)).toBe(0);
  });
});

describe("signing, activated (spec 024 §3.4)", () => {
  it("signs every append when the declared key is present and verifies", async () => {
    const url = freshDbUrl();
    const mod = await freshModule(url, SEED);
    await mod.appendDecision(denialPayload("signed append"), "decision-signed");
    const rows = await withRaw(url, (d) =>
      d.query(`SELECT signature FROM kernel_decisions ORDER BY seq ASC`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(String(row.signature)).toMatch(/^[0-9a-f]{128}$/);
    }
    expect(await mod.verifyDecisionChain()).toEqual({ ok: true });
  });

  it("fails verification on a tampered signature", async () => {
    const url = freshDbUrl();
    const mod = await freshModule(url, SEED);
    await mod.appendDecision(denialPayload("to be tampered"), "decision-sigtamper");
    await withRaw(url, (d) =>
      d.execute(`UPDATE kernel_decisions SET signature = ? WHERE record_id = ?`, [
        "00".repeat(64),
        "decision-sigtamper",
      ]),
    );
    const verdict = await mod.verifyDecisionChain();
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/invalid signature/);
  });

  it("fails verification on an unsigned record after activation", async () => {
    const url = freshDbUrl();
    const mod = await freshModule(url, SEED);
    await mod.appendDecision(denialPayload("stripped later"), "decision-stripped");
    await withRaw(url, (d) =>
      d.execute(`UPDATE kernel_decisions SET signature = NULL WHERE record_id = ?`, [
        "decision-stripped",
      ]),
    );
    const verdict = await mod.verifyDecisionChain();
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toMatch(/unsigned/);
  });

  it("refuses init with a malformed declared key", async () => {
    const mod = await freshModule(freshDbUrl(), "not-a-key");
    await expect(mod.ensureDecisionLedger()).rejects.toThrow(/64-char hex/);
  });

  it("verifies hash-linkage only when the key is absent", async () => {
    const url = freshDbUrl();
    let mod = await freshModule(url, SEED);
    await mod.appendDecision(denialPayload("signed then keyless"), "decision-keyless");
    mod = await freshModule(url);
    expect(await mod.verifyDecisionChain()).toEqual({ ok: true });
  });
});

const PG_URL = process.env.TEST_POSTGRES_URL;
const describePg = PG_URL ? describe : describe.skip;

describePg("postgres dialect parity (spec 024 §4 item 1)", () => {
  it("enforces parent uniqueness with the 23505 shape", async () => {
    await withRaw(PG_URL as string, async (d) => {
      await d.execute(`DROP TABLE IF EXISTS kernel_decisions_integrity_probe`);
      await d.execute(
        `CREATE TABLE kernel_decisions_integrity_probe (seq BIGSERIAL PRIMARY KEY, prev_hash TEXT NOT NULL)`,
      );
      await d.execute(
        `CREATE UNIQUE INDEX kernel_decisions_integrity_probe_parent ON kernel_decisions_integrity_probe (prev_hash)`,
      );
      await d.execute(`INSERT INTO kernel_decisions_integrity_probe (prev_hash) VALUES (?)`, [
        "sha256:probe",
      ]);
      let caught: unknown;
      try {
        await d.execute(`INSERT INTO kernel_decisions_integrity_probe (prev_hash) VALUES (?)`, [
          "sha256:probe",
        ]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isUniqueViolation(caught)).toBe(true);
      await d.execute(`DROP TABLE kernel_decisions_integrity_probe`);
    });
  });
});
