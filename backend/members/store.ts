/**
 * The domain's store access: error translation and the fence rule (spec 036
 * §3.4, §3.6).
 *
 * Two jobs, both about being legible at the edge. A control-plane error is
 * precise and internal (`InvalidSpecError` names a field, `SupersededError`
 * names a fence) and an HTTP client needs a status code and a sentence. And a
 * deployment whose schema has not been applied should say so rather than leaking
 * `no such table: resource` from four frames down.
 */
import { APIError } from "encore.dev/api";

import {
  InvalidSpecError,
  SupersededError,
  TenancyError,
  admit,
  get,
  type Resource,
} from "../control";
import { query } from "../state";

// libSQL and SQLite phrase it differently, and the addon has passed both
// through at various points. Matching on the message is unpleasant and is the
// only signal available: a missing table is not a distinct error type anywhere
// in the stack.
const MISSING_TABLE = /no such table|does not exist/i;

// Written for the person who will read it, which is an operator standing in
// front of a deployment that will not serve. The spec reference belongs in this
// comment (spec 032 §3.6 is why it is a deploy step) and not in their face.
const SCHEMA_ABSENT =
  "the control plane schema has not been applied to this deployment yet, so the membership " +
  "surface cannot serve. An operator applies it once, as a deploy step, before any of the " +
  "association's records can be created.";

/** Translate a domain error into the status code a client should see. */
export function toApiError(err: unknown): unknown {
  if (err instanceof APIError) return err;

  const message = String((err as Error)?.message ?? err);
  if (MISSING_TABLE.test(message)) return APIError.unavailable(SCHEMA_ABSENT);

  if (err instanceof InvalidSpecError) {
    return APIError.invalidArgument(err.message).withDetails({
      code: "INVALID_SPEC",
      kind: err.kind,
      field: err.field,
    });
  }
  if (err instanceof TenancyError) return APIError.invalidArgument(err.message);
  if (err instanceof SupersededError) {
    // 409: somebody else wrote this row between the read and the write. The
    // client re-reads and retries; it has not lost anything.
    return APIError.aborted(err.message).withDetails({ code: "SUPERSEDED" });
  }
  return err;
}

/** Run a store operation with the edge's error vocabulary. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

/**
 * Write a resource's spec from the human plane, passing a fence.
 *
 * This is spec 036 §3.4's rule in one place. The renewal controller writes
 * membership status under its pass token, so the row's mark is non-zero, and an
 * `admit` at the default fence of 0 would be refused forever. Passing the mark
 * that was read makes the write land, and makes it fail loudly when the mark
 * moved in between.
 *
 * `expected` is the fence the CLIENT read, when it sends one. That is real
 * optimistic concurrency: a stale editor is told to re-read instead of silently
 * overwriting a change it never saw. Without it the server re-reads, the window
 * narrows to microseconds, and two operators editing the same member still
 * resolve last-write-wins.
 */
export async function writeSpec<TSpec>(
  kind: string,
  name: string,
  spec: unknown,
  opts: { tenant: string; actor?: string; expected?: number },
): Promise<Resource<TSpec>> {
  return guarded(async () => {
    const fence =
      opts.expected ?? (await get(kind, name, { tenant: opts.tenant }))?.fence ?? 0;
    return admit<TSpec>(kind, name, spec, { tenant: opts.tenant, fence, actor: opts.actor });
  });
}

/**
 * Whether the control plane's tables exist.
 *
 * Asked of `sqlite_master` rather than by catching a failed query, so the answer
 * is a fact rather than a parsed error message. The controller uses it to wait
 * instead of failing a pass every second, which is how an operator ends up
 * ignoring the log.
 */
export async function schemaPresent(): Promise<boolean> {
  try {
    const rows = await query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`,
      ["resource"],
      { tables: ["sqlite_master"] },
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
