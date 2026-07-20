/**
 * The Decision ledger store (spec 021 §3.6): persistence for the pure
 * kernel's hash-linked Decision chain, exactly the consumer role
 * statecrafting spec 004 assigns (timestamps, ids, and storage are the
 * consumer's; record building and chain verification are the kernel's).
 *
 * The store writes through a raw (ungoverned) CoreLedger driver: the
 * enforcement plane sits beneath its own gate by construction, so no
 * recursion between adjudication and its audit trail can exist. Appends
 * are serialized in-process; denial appends are fire-and-forget so the
 * audit record never adds availability coupling to the request path.
 */
import { createHash } from "node:crypto";

import { buildRecord, genesisPayload, verifyChain } from "@statecrafting/kernel-native";

import type { LedgerDriver } from "../core/ledger/driver";
import { rawDriverFromEnv } from "../core/ledger/from-env";

import type { Adjudication, CapabilityRef } from "./adjudicate";
import { modelJson, receipt } from "./boot";

const DDL: Record<"sqlite" | "postgres", string> = {
  sqlite: `CREATE TABLE IF NOT EXISTS kernel_decisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  postgres: `CREATE TABLE IF NOT EXISTS kernel_decisions (
    seq BIGSERIAL PRIMARY KEY,
    record_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
};

/** attest-ledger's native record shape (snake_case, deliberately). */
export interface LedgerRecord {
  id: string;
  timestamp: string;
  previous_record_hash: string;
  record_hash: string;
  payload: unknown;
}

/** The decision/v1 payload (statecrafting spec 004 §3.5, camelCase). */
export interface EffectDecisionPayload {
  modelHash: string;
  gateConfigHash: string;
  service: string;
  agent?: string;
  capability: CapabilityRef;
  contextHash: string;
  outcome: string;
  reason: string;
  checkIds: string[];
  approver?: string;
}

let driver: LedgerDriver | undefined;
function store(): LedgerDriver {
  driver ??= rawDriverFromEnv();
  return driver;
}

/** Recursive keysort stringify for the context hash (spec 020 §3.5 form). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextHash(context: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(`${canonical(context)}\n`, "utf8").digest("hex")}`;
}

// In-process append serialization: one writer, ordered, error-isolated.
let tail: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  const run = tail.then(op, op);
  tail = run.catch(() => {});
  return run;
}

let initialized = false;
async function initUnlocked(): Promise<void> {
  if (initialized) return;
  const d = store();
  await d.execute(DDL[d.dialect]);
  const rows = await d.query(
    `SELECT payload FROM kernel_decisions WHERE record_id LIKE 'genesis-%' ORDER BY seq DESC LIMIT 1`,
  );
  const head = rows[0]
    ? (JSON.parse(String(rows[0].payload)) as { modelHash?: string })
    : undefined;
  if (head?.modelHash !== receipt.modelHash) {
    const genesis = JSON.parse(genesisPayload(modelJson)) as {
      modelHash: string;
      gateConfigHash: string;
      contractVersion: string;
    };
    await appendUnlocked("genesis", {
      modelHash: genesis.modelHash,
      gateConfigHash: genesis.gateConfigHash,
      service: "kernel",
      capability: { kind: "ledger.append", resource: "*" },
      contextHash: genesis.modelHash,
      outcome: "allow",
      reason: `genesis:${genesis.contractVersion}`,
      checkIds: [],
    });
  }
  initialized = true;
}

async function appendUnlocked(idPrefix: string, decision: EffectDecisionPayload): Promise<void> {
  const d = store();
  const head = await d.query(
    `SELECT seq, record_hash FROM kernel_decisions ORDER BY seq DESC LIMIT 1`,
  );
  // The chain is anchored to the booted model (spec 021 §3.6).
  const prevHash = head[0] ? String(head[0].record_hash) : receipt.modelHash;
  const seq = head[0] ? Number(head[0].seq) + 1 : 1;
  const id = `${idPrefix}-${String(seq).padStart(6, "0")}`;
  const record = JSON.parse(
    buildRecord(prevHash, id, new Date().toISOString(), JSON.stringify(decision)),
  ) as LedgerRecord;
  await d.execute(
    `INSERT INTO kernel_decisions (record_id, ts, prev_hash, record_hash, payload) VALUES (?, ?, ?, ?, ?)`,
    [record.id, record.timestamp, record.previous_record_hash, record.record_hash, JSON.stringify(record.payload)],
  );
}

/** Deploy-time genesis: table + the genesis record for the booted model. */
export function ensureDecisionLedger(): Promise<void> {
  return enqueue(initUnlocked);
}

/** Append one Decision (awaitable; used for overrides and tests). */
export function appendDecision(decision: EffectDecisionPayload): Promise<void> {
  return enqueue(async () => {
    await initUnlocked();
    await appendUnlocked("decision", decision);
  });
}

/** Fire-and-forget denial append from the request path (spec 021 §3.6). */
export function recordDenial(input: {
  service: string;
  capability: CapabilityRef;
  attributes?: Record<string, unknown>;
  result: Adjudication;
}): void {
  const payload: EffectDecisionPayload = {
    modelHash: input.result.modelHash,
    gateConfigHash: input.result.configHash,
    service: input.service,
    capability: input.capability,
    contextHash: contextHash({
      attributes: input.attributes ?? {},
      capability: input.capability,
      service: input.service,
    }),
    outcome: input.result.decision.outcome === "degrade" ? "degrade" : "deny",
    reason: input.result.decision.reason,
    checkIds: input.result.decision.checkIds,
  };
  void appendDecision(payload).catch(() => {
    // The deny already blocked the operation; a failed audit append must
    // not take the request path down with it.
  });
}

/** All records in chain order, as attest-ledger native shapes. */
export async function decisionRecords(): Promise<LedgerRecord[]> {
  await ensureDecisionLedger();
  const rows = await store().query(
    `SELECT record_id, ts, prev_hash, record_hash, payload FROM kernel_decisions ORDER BY seq ASC`,
  );
  return rows.map((row) => ({
    id: String(row.record_id),
    timestamp: String(row.ts),
    previous_record_hash: String(row.prev_hash),
    record_hash: String(row.record_hash),
    payload: JSON.parse(String(row.payload)) as unknown,
  }));
}

/** Re-verify the persisted chain exactly as the stock verifier would. */
export async function verifyDecisionChain(): Promise<{ ok: boolean; error?: string }> {
  const records = await decisionRecords();
  return JSON.parse(verifyChain(JSON.stringify(records))) as { ok: boolean; error?: string };
}
