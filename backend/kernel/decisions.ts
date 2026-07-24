/**
 * The Decision ledger store (spec 021 §3.6; integrity per spec 024):
 * persistence for the pure kernel's hash-linked Decision chain, exactly
 * the consumer role statecrafting spec 004 assigns (timestamps, ids, and
 * storage are the consumer's; record building and chain verification are
 * the kernel's).
 *
 * The store writes through a raw (ungoverned) CoreLedger driver: the
 * enforcement plane sits beneath its own gate by construction, so no
 * recursion between adjudication and its audit trail can exist. Appends
 * are serialized in-process and compare-and-swapped at the store (spec
 * 024 §3.1): the unique parent index makes each head claimable once, so
 * a second writer loses the race cleanly instead of forking the chain.
 * Denial appends stay fire-and-forget; their loss window is bracketed by
 * a durable dirty flag and marked at the next boot (spec 024 §3.3).
 */
import { createHash, createPrivateKey, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { buildRecord, genesisPayload, verifyChain } from "@statecrafting/kernel-native";

import type { LedgerDriver, LedgerTx } from "../core/ledger/driver";
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

// Every record names its parent; each parent is claimable once, so a
// chain under this index is linear by construction (spec 024 §3.1).
const PARENT_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS kernel_decisions_parent ON kernel_decisions (prev_hash)`;

// The denial-append bracket (spec 024 §3.3): dirty while denial appends
// are in flight, so an unclean end of the window is marked at next boot.
const META_DDL = `CREATE TABLE IF NOT EXISTS kernel_ledger_meta (id INTEGER PRIMARY KEY, dirty INTEGER NOT NULL)`;

const CAS_ATTEMPTS = 3;

const SIGNING_KEY_ENV = "ENRAHITU_LEDGER_SIGNING_KEY";

// The DER prefix that wraps a raw 32-byte ed25519 seed as PKCS#8.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** attest-ledger's native record shape (snake_case, deliberately). */
export interface LedgerRecord {
  id: string;
  timestamp: string;
  previous_record_hash: string;
  record_hash: string;
  payload: unknown;
}

/** The stored row: the native record plus the sibling signature (spec 024 §3.4). */
interface StoredRecord extends LedgerRecord {
  signature: string | null;
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

/**
 * An integrity violation of the chain or its signing config (spec 024
 * §3.2): process-fatal on the init path, propagated on runtime appends.
 */
export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
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

/**
 * A CAS miss surfaces as a unique violation on the parent index; the
 * shapes differ per dialect (libsql constraint codes and messages,
 * Postgres 23505). Exported for the dialect-shape acceptance test.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  return (
    code === "23505" ||
    code.startsWith("SQLITE_CONSTRAINT") ||
    /UNIQUE constraint failed/i.test(message) ||
    /duplicate key value/i.test(message)
  );
}

/**
 * The signing key, when `ledger.signing`'s declared env var is set
 * (spec 024 §3.4). A declared key that cannot sign fails loud: silence
 * here would silently disable signing. The one KeyObject serves both
 * directions: node's verify derives the public half from a private key.
 */
function signingKey(): KeyObject | undefined {
  const raw = process.env[SIGNING_KEY_ENV];
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new LedgerIntegrityError(
      `${SIGNING_KEY_ENV} must be a 64-char hex ed25519 seed (32 bytes)`,
    );
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(raw, "hex")]),
    format: "der",
    type: "pkcs8",
  });
}

// In-process append serialization: one writer, ordered, error-isolated.
let tail: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  const run = tail.then(op, op);
  tail = run.catch(() => {});
  return run;
}

/**
 * Integrity failures on the init path stop the process (spec 024 §3.2):
 * serving under a broken audit proof is worse than being down. Under the
 * test runner the same error rejects instead, and every awaiter of
 * `dbReady` fails closed.
 */
function escalate(err: unknown): never {
  if (err instanceof LedgerIntegrityError && !process.env.VITEST) {
    console.error(`kernel decision ledger: fatal integrity failure: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

function initGuarded(): Promise<void> {
  return initUnlocked().catch(escalate);
}

let initialized = false;
async function initUnlocked(): Promise<void> {
  if (initialized) return;
  const d = store();
  await d.execute(DDL[d.dialect]);
  await ensureParentIndex(d);
  await ensureSignatureColumn(d);
  await d.execute(META_DDL);

  const meta = await d.query(`SELECT dirty FROM kernel_ledger_meta WHERE id = 1`);
  if (meta.length === 0) {
    await d.execute(`INSERT INTO kernel_ledger_meta (id, dirty) VALUES (1, 0)`);
  }
  const wasDirty = meta[0] ? Number(meta[0].dirty) === 1 : false;

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

  if (wasDirty) {
    // The previous process ended inside a denial-append bracket: mark
    // the untrustworthy stretch as a first-class chained record, then
    // close the stale bracket (spec 024 §3.3).
    await appendUnlocked("marker", {
      modelHash: receipt.modelHash,
      gateConfigHash: receipt.gateConfigHash,
      service: "kernel",
      capability: { kind: "ledger.append", resource: "*" },
      contextHash: contextHash({ marker: "crash-window" }),
      outcome: "unknown",
      reason: "crash-window: denial appends from the previous process may be lost",
      checkIds: [],
    });
    await d.execute(`UPDATE kernel_ledger_meta SET dirty = 0 WHERE id = 1`);
  }

  const verdict = await verifyStored(d);
  if (!verdict.ok) {
    throw new LedgerIntegrityError(
      `chain verification failed at init: ${verdict.error ?? "unknown"}`,
    );
  }
  initialized = true;
}

async function ensureSignatureColumn(d: LedgerDriver): Promise<void> {
  if (d.dialect === "postgres") {
    await d.execute(`ALTER TABLE kernel_decisions ADD COLUMN IF NOT EXISTS signature TEXT`);
    return;
  }
  // SQLite has no ADD COLUMN IF NOT EXISTS; probe by attempting.
  try {
    await d.execute(`ALTER TABLE kernel_decisions ADD COLUMN signature TEXT`);
  } catch (err) {
    if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err;
  }
}

async function ensureParentIndex(d: LedgerDriver): Promise<void> {
  try {
    await d.execute(PARENT_INDEX);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Pre-024 damage: the table already carries a fork. Surfacing it
      // at the first boot under the index is the intended behavior.
      throw new LedgerIntegrityError(
        `the parent-uniqueness index cannot build: kernel_decisions already carries a fork (${String((err as Error)?.message ?? err)})`,
      );
    }
    throw err;
  }
}

async function appendUnlocked(
  idPrefix: string,
  decision: EffectDecisionPayload,
  explicitId?: string,
): Promise<void> {
  const d = store();
  const key = signingKey();
  for (let attempt = 1; ; attempt++) {
    try {
      await d.transaction(async (tx) => {
        // Head read and insert share one view; the unique parent index
        // makes the insert itself the CAS (spec 024 §3.1).
        const headRow = await tx.query(
          `SELECT seq, record_hash FROM kernel_decisions ORDER BY seq DESC LIMIT 1`,
        );
        // The chain is anchored to the booted model (spec 021 §3.6).
        const prevHash = headRow[0] ? String(headRow[0].record_hash) : receipt.modelHash;
        const seq = headRow[0] ? Number(headRow[0].seq) + 1 : 1;
        const id = explicitId ?? `${idPrefix}-${String(seq).padStart(6, "0")}`;
        const record = JSON.parse(
          buildRecord(prevHash, id, new Date().toISOString(), JSON.stringify(decision)),
        ) as LedgerRecord;
        const signature = key
          ? sign(null, Buffer.from(record.record_hash, "utf8"), key).toString("hex")
          : null;
        await tx.execute(
          `INSERT INTO kernel_decisions (record_id, ts, prev_hash, record_hash, payload, signature) VALUES (?, ?, ?, ?, ?, ?)`,
          [record.id, record.timestamp, record.previous_record_hash, record.record_hash, JSON.stringify(record.payload), signature],
        );
      });
      return;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A CAS miss: the head moved underneath us. Reload and re-chain;
      // the payload is untouched, only the link moves (spec 024 §3.1).
      if (attempt >= CAS_ATTEMPTS) {
        throw new LedgerIntegrityError(
          `append lost the head CAS ${CAS_ATTEMPTS} times (${explicitId ?? idPrefix}): another writer is racing this chain`,
        );
      }
    }
  }
}

/** Deploy-time genesis: table + the genesis record for the booted model. */
export function ensureDecisionLedger(): Promise<void> {
  return enqueue(initGuarded);
}

/** Append one Decision (awaitable; used for overrides and tests). */
export function appendDecision(decision: EffectDecisionPayload, explicitId?: string): Promise<void> {
  return enqueue(async () => {
    await initGuarded();
    await appendUnlocked("decision", decision, explicitId);
  });
}

/**
 * The denial record id, generated before the append so the request path
 * (and the observability tier, spec 022) knows it synchronously: ids are
 * the store's to supply (spec 021 §3.6), and a time-plus-entropy id needs
 * no round trip. The chain's ordering authority is the parent index
 * (spec 024 §3.1); the table seq stays the read order.
 */
function newDenialId(): string {
  return `decision-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

let pendingDenials = 0;
// In-memory mirror of the durable dirty flag, so the bracket is written
// once per burst, not once per denial.
let bracketOpen = false;

/**
 * Fire-and-forget denial append from the request path (spec 021 §3.6).
 * Returns the record id the append will carry. The append rides the
 * serialized queue inside the dirty-flag bracket (spec 024 §3.3).
 */
export function recordDenial(input: {
  service: string;
  capability: CapabilityRef;
  attributes?: Record<string, unknown>;
  result: Adjudication;
}): string {
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
  const decisionId = newDenialId();
  pendingDenials++;
  enqueue(async () => {
    try {
      await initGuarded();
      if (!bracketOpen) {
        // Bracket open: durable before the record transaction, so a
        // crash mid-append is marked at the next boot (spec 024 §3.3).
        await store().execute(`UPDATE kernel_ledger_meta SET dirty = 1 WHERE id = 1`);
        bracketOpen = true;
      }
      await appendUnlocked("decision", payload, decisionId);
    } finally {
      pendingDenials--;
      if (pendingDenials === 0 && bracketOpen) {
        await store().execute(`UPDATE kernel_ledger_meta SET dirty = 0 WHERE id = 1`);
        bracketOpen = false;
      }
    }
  }).catch((err) => {
    // The deny already blocked the operation; a failed audit append must
    // not take the request path down with it. Loud, though (spec 024):
    // a silent audit failure is the thing this spec exists to remove.
    console.error(`kernel decision ledger: denial append failed for ${decisionId}: ${String(err)}`);
  });
  return decisionId;
}

async function fetchStored(db: LedgerTx): Promise<StoredRecord[]> {
  const rows = await db.query(
    `SELECT record_id, ts, prev_hash, record_hash, payload, signature FROM kernel_decisions ORDER BY seq ASC`,
  );
  return rows.map((row) => ({
    id: String(row.record_id),
    timestamp: String(row.ts),
    previous_record_hash: String(row.prev_hash),
    record_hash: String(row.record_hash),
    payload: JSON.parse(String(row.payload)) as unknown,
    signature: row.signature == null ? null : String(row.signature),
  }));
}

function toNative(record: StoredRecord): LedgerRecord {
  return {
    id: record.id,
    timestamp: record.timestamp,
    previous_record_hash: record.previous_record_hash,
    record_hash: record.record_hash,
    payload: record.payload,
  };
}

/**
 * The signature suffix pass (spec 024 §3.4): from the first signed
 * record onward every record must verify; earlier records are exempt
 * (signing proves origin from its activation point, not retroactively).
 */
function verifySignatures(
  records: StoredRecord[],
  key: KeyObject,
): { ok: boolean; error?: string } {
  let signingSeen = false;
  for (const record of records) {
    if (record.signature === null) {
      if (signingSeen) {
        return { ok: false, error: `record ${record.id} is unsigned after signing activation` };
      }
      continue;
    }
    signingSeen = true;
    const valid = verify(
      null,
      Buffer.from(record.record_hash, "utf8"),
      key,
      Buffer.from(record.signature, "hex"),
    );
    if (!valid) {
      return { ok: false, error: `record ${record.id} carries an invalid signature` };
    }
  }
  return { ok: true };
}

async function verifyStored(db: LedgerTx): Promise<{ ok: boolean; error?: string }> {
  const stored = await fetchStored(db);
  const native = JSON.parse(verifyChain(JSON.stringify(stored.map(toNative)))) as {
    ok: boolean;
    error?: string;
  };
  if (!native.ok) return native;
  const key = signingKey();
  if (!key) return native;
  return verifySignatures(stored, key);
}

/** All records in chain order, as attest-ledger native shapes. */
export async function decisionRecords(): Promise<LedgerRecord[]> {
  await ensureDecisionLedger();
  return (await fetchStored(store())).map(toNative);
}

/**
 * Re-verify the persisted chain exactly as the stock verifier would,
 * plus the signature suffix pass when the signing key is present.
 */
export async function verifyDecisionChain(): Promise<{ ok: boolean; error?: string }> {
  await ensureDecisionLedger();
  return verifyStored(store());
}
