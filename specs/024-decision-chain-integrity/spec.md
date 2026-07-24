---
id: "024-decision-chain-integrity"
title: "Decision-chain integrity: CAS append, fatal forks, marked loss, live signing"
status: approved
created: "2026-07-23"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "003-coreledger"
  - "011-coreledger-postgres-driver"
  - "020-app-model-contract"
  - "021-kernel-native-consumption"
establishes:
  - "backend/kernel/ledger-integrity.test.ts"
summary: >
  The Decision chain's ordering authority moves from the in-process
  append queue into the store itself: a unique index on
  previous_record_hash makes every append a compare-and-swap on the
  chain head, inside one transaction, on both CoreLedger dialects, so
  two writers against one kernel_decisions table produce a clean
  retry-or-fail instead of a fork. Boot-time chain verification becomes
  real and fatal: a chain the kernel verifier rejects stops the process
  rather than serving under a broken proof. The fire-and-forget denial
  append (spec 021 section 3.6 policy, kept) gains a marked loss
  window: a durable dirty flag brackets pending denial appends, and an
  unclean end of a bracketed window ledgers a crash-window marker
  Decision at the next boot. The ledger signing the model has declared
  since spec 021 (ed25519, ENRAHITU_LEDGER_SIGNING_KEY) activates
  consumer-side: a detached signature over record_hash in a sibling
  column, invisible to the native verifier, verified as a chain-suffix
  property whenever the key is present.
---

# 024: Decision-chain integrity

## 1. Purpose

Spec 021 landed the Decision ledger with exactly one ordering
authority: the in-process append queue in
`backend/kernel/decisions.ts`. That authority is real but local. Two
processes over the same `kernel_decisions` table (a deploy overlap, an
accidental second replica, an operator shell) each hold their own
queue, each read the same head, and each append a child of it: the
table then carries two records naming the same parent, on any driver,
and `verifyChain` can never accept it again. A forked hash chain is
worse than no hash chain: it is a proof that fails.

An external review proposed solving this with hiqlite: either the
chain moves onto hiqlite Raft or hiqlite holds a fenced chain head.
Neither is buildable today, and this spec records why: hiqlite is
in-process per pod (spec 002), so two pods hold two independent
hiqlite instances, and a fencing token nobody shares fences nothing.
The single-node cell (spec 001 section 4.1) has no replication to
fork; the present, real risks are narrower:

1. The chain's linearity is enforced nowhere the data lives.
2. Denial appends are fire-and-forget (spec 021 section 3.6, a policy
   this spec keeps), so crash-window loss is unbounded and, worse,
   unmarked: an auditor cannot distinguish "no denials" from "denials
   lost".

This spec closes both at the store, keeps every spec 021 policy
otherwise intact, and activates the signing the model already
declares. The clustered future (chain head in hiqlite Raft) is Phase B
doctrine and is recorded in spec 001, not built here.

## 2. Territory

- `backend/kernel/ledger-integrity.test.ts` (this spec): the
  integrity proofs: fork rejection at the store, CAS re-chaining,
  fatal verification, the crash-window marker, signature round-trips.

Amended in sibling territory (owning spec edited alongside, the spec
011 pattern):

- `backend/kernel/decisions.ts` (spec 021): the store grows the CAS
  append, the boot verification, the dirty flag, and the signing
  hooks. `backend/kernel/` as a directory stays owned by spec 021.

No driver changes: both `LedgerDriver` implementations already carry
the interactive `transaction()` this spec rides (specs 003 and 011).
No manifest or model change: `ledger.signing` has been declared since
spec 021 and no capability moves.

## 3. Behavior

### 3.1 CAS append at the store

The table gains a uniqueness law and the append becomes a
compare-and-swap on it:

- **The index.** `CREATE UNIQUE INDEX IF NOT EXISTS
  kernel_decisions_parent ON kernel_decisions (prev_hash)`, both
  dialects, created at init directly after the table DDL. Every
  record names its parent; the index says every parent has at most
  one child; a chain under this index is linear by construction.
  Distinct chains cannot collide on it: the first genesis's parent is
  the booted model hash, and every later record's parent (deploy
  genesis records included) is the head record hash it extends.
- **The transaction.** Head read, record build
  (`kernelNative.buildRecord`), and insert run inside one
  `driver.transaction()`. The transaction gives the head read and the
  insert one consistent view; the index makes the insert itself the
  CAS. Two appends claiming the same parent commit exactly once; the
  loser surfaces as a unique violation, never as a second child.
- **The retry.** A unique violation is a CAS miss, not an error: the
  head moved. The append re-enters the transaction, reloads the head,
  rebuilds the record on the new parent (re-chaining: the Decision
  payload is untouched, only the link moves), and tries again, three
  attempts in all. Exhaustion throws a typed integrity error: fail
  loud, never fork. Awaited appends propagate it to their caller;
  denial appends log it with the decision id (the request path stays
  uncoupled, spec 021 section 3.6, but the failure is no longer
  silent).
- **Pre-existing damage.** On a table that already carries a fork,
  the index cannot build: init fails with a named integrity error
  before any append. Surfacing pre-024 damage at the first boot under
  this spec is the intended behavior, not a migration hazard.

Unique-violation classification is by dialect: SQLite constraint
codes and message shapes from libsql, `23505` from Postgres.

### 3.2 Fork detection and fatality

Init runs the full chain verification
(`kernelNative.verifyChain`, plus the signature pass of 3.4) after
DDL, genesis, and marker handling. A chain the verifier rejects, an
index that cannot build, a malformed signing key, or a CAS retry
that exhausts during init: each is a `LedgerIntegrityError`, and an
integrity error on the init path is process-fatal: the error is
written to stderr and the process exits nonzero. A runtime append
that exhausts the CAS throws the same typed error without killing
the process: the awaited caller gets it, the denial path logs it
(3.1); the chain stayed linear either way, which is the property
being defended. Spec 021
section 3.4 makes a refused model stop the process at module
evaluation; this extends the same fail-closed doctrine to the ledger,
whose init is necessarily async: a cell serving requests under a
broken audit proof is worse than a cell that is down. Under the test
runner (`VITEST` set) the same error rejects the init promise instead
of exiting, so the fatal path is provable in-process; every awaiter
of `dbReady` then fails closed, which is the same posture one level
softer.

Transient store errors (connection refused, disk full) are not
integrity errors and keep today's behavior: the init promise rejects
and every awaiter fails; nothing exits.

Verification cost is a full chain walk at every boot. The ledger
records governance events, not traffic (spec 021 section 3.6), so
the walk is thousands of records at pessimistic volume; checkpointed
verification is a named extension for when a measured boot says
otherwise.

### 3.3 The marked loss window

The denial append stays fire-and-forget; what changes is that its
loss window becomes bracketed and marked:

- **The flag.** A one-row sidecar table, `kernel_ledger_meta`
  (`id` fixed 1, `dirty` integer), same store, same dialects.
- **Bracket open.** When a denial append is enqueued and the flag is
  not already durably set, the serialized queue writes `dirty = 1`
  as its own durable statement before the record transaction. The
  write rides the queue, never the request path.
- **Bracket close.** When the last pending denial append settles,
  the queue writes `dirty = 0`. Steady state is clean; the flag is
  set only while denial appends are actually in flight.
- **The marker.** Init reads the flag before genesis handling. A set
  flag means the previous process ended inside a bracket: one or
  more denial appends may have committed, been lost, or both. Init
  appends a crash-window marker Decision: `service` `kernel`,
  `capability` `ledger.append` on `*`, `outcome` `unknown`, `reason`
  `crash-window: denial appends from the previous process may be
  lost`, then resets the flag. The marker is a first-class chained
  record: the auditor sees exactly where the record stream is not
  trustworthy as a negative ("no denial recorded" stops implying "no
  denial happened" across a marker).

The residual window, stated honestly: a crash between the request
path enqueue and the `dirty = 1` commit loses that denial unmarked.
The window is one durable write wide and is the irreducible price of
keeping the audit append off the request path's availability budget;
shrinking it to zero means a synchronous durable write per denial,
which spec 021 section 3.6 deliberately refuses. Over-marking is
possible (crash after the record committed but before the bracket
closed) and harmless: the marker says "may".

### 3.4 Signing, activated

The model has declared `ledger.signing` (`ed25519`, keyEnv
`ENRAHITU_LEDGER_SIGNING_KEY`) since spec 021, policy-only. This spec
activates it consumer-side, leaving the native record shape and
verifier byte-identical:

- **Key.** The env var holds a 64-char hex ed25519 seed (32 bytes).
  Present: signing is on. Absent: dormant, exactly as today. Present
  but malformed: a `LedgerIntegrityError` at init (a declared key
  that cannot sign must not silently disable signing). Key
  provisioning at first boot is spec 007 territory and a named
  follow-up; nothing here requires it.
- **Sign.** Every append (genesis and markers included) computes a
  detached ed25519 signature over the UTF-8 bytes of `record_hash`
  and stores it hex in a nullable `signature` column, added
  additively at init (`ADD COLUMN IF NOT EXISTS` on Postgres, a
  probe-then-alter on SQLite). `record_hash` already commits to id,
  timestamp, parent, and payload via `buildRecord`, so the signature
  authenticates the whole record; because it lives beside the record
  rather than inside it, `verifyChain` input is unchanged and old
  rows need no backfill.
- **Verify.** When the key is present, chain verification (3.2 and
  `verifyDecisionChain`) gains a suffix pass: from the first signed
  record onward, every record must carry a signature the derived
  public key accepts. Records before activation are exempt (signing
  proves origin from its activation point, not retroactively); an
  unsigned or invalid record after that point fails verification,
  so signing cannot be silently switched off by dropping the column
  value. When the key is absent, the pass is skipped: signature
  authority is key custody, and a store without the key verifies
  hash-linkage only. Key rotation (key ids, multi-key verification)
  is a named extension.

### 3.5 Topology assumptions, restated

The cell's operating assumption stays single-writer (spec 001
section 4.1: one container, one volume). What this spec changes is
the failure mode when the assumption breaks: yesterday a second
writer forked the chain silently; today it loses the CAS and fails
loud, and the surviving chain stays linear and verifiable. The
`kernel_ledger_meta` flag degrades gracefully under two writers (the
bracket becomes imprecise, the marker over-fires) and the chain
itself never degrades. Clustered ordering authority (the chain head
in hiqlite Raft, an addon chain-head API) is Phase B doctrine
recorded in spec 001; nothing here anticipates its shape beyond
keeping the store behind `LedgerDriver`.

## 4. Acceptance

1. **Fork rejection.** A fabricated record claiming an
   already-claimed parent is rejected by the store (unique
   violation), proven on libSQL always and on Postgres under the
   spec 011 gated suite's conditions.
2. **Re-chaining.** With the head moved underneath a pending append,
   the append lands as a child of the new head and the chain
   verifies; the retry classification recognizes both dialects'
   unique-violation shapes.
3. **Fatal verification.** A store seeded with a fork (built without
   the index) and a store with a tampered payload both refuse init
   with a `LedgerIntegrityError` (rejection under `VITEST`, exit
   otherwise).
4. **The marker.** A store whose flag is durably set at init gains
   exactly one crash-window marker Decision (outcome `unknown`) and
   a cleared flag; after a denial append drains, the record is
   present and the flag is clear (the bracket closed).
5. **Signing.** With the key set: appended records carry signatures,
   verification passes, a tampered signature fails it, and an
   unsigned record after activation fails it. With the key unset:
   the store behaves exactly as before this spec. A malformed key
   refuses init.
6. The full suite (`npm run typecheck && npm test`) stays green on
   both CoreLedger drivers.

## 5. Out of scope

- Moving the chain or its head into hiqlite (Raft ordering
  authority, an addon chain-head API): Phase B, recorded as
  doctrine in spec 001, buildable only when hiqlite stops being
  per-process.
- An outbox between hiqlite and CoreLedger: no invariant spans them
  today; the law that keeps it that way is spec 001's.
- Synchronous durable denial appends: refused by spec 021 section
  3.6, reaffirmed here; the loss window is marked, not closed.
- Checkpointed or incremental chain verification: named extension,
  waits for a measured boot cost.
- Key rotation and multi-key signature verification: named
  extension.
- Signed anchors and per-record external timestamping: spec 020's
  named extensions, untouched.
