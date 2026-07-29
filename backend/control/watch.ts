/**
 * The watch (spec 034 §3.4): a change feed over the global revision.
 *
 * **The poll is the mechanism and the notify is an optimization.** That
 * ordering is the whole design, and inverting it is the classic way to build a
 * change feed that works until it silently does not. hiqlite's bus replays
 * cache events after a restart and delivers to one awaiter, delivery is not
 * guaranteed, and the notify crosses a different raft group than the write
 * (spec 032 §3.2, §3.5). So a consumer that acts on delivery is wrong in ways
 * that only appear under restart or partition.
 *
 * A watcher here is therefore correct with the notify pathway entirely dead: it
 * scans `revision > watermark` on a timer and converges. The notify shortens
 * the latency from "up to one tick" to "milliseconds" by waking the scan early,
 * and nothing else.
 */
import { listen, query } from "../state";

import { hydrateRow, type ResourceRow } from "./rows";
import { RESOURCE_TABLE } from "./schema";
import type { Resource } from "./admission";

export interface WatchOptions {
  /** Kinds to observe. Empty means every kind. */
  kinds?: string[];
  /** Start after this revision. 0 replays everything the store still holds. */
  since?: number;
  /** Rows per scan. Bounds both the query and the time one batch can take. */
  batchSize?: number;
}

export interface Change<TSpec = unknown> {
  resource: Resource<TSpec>;
  /** True when the row is a tombstone: the resource was retracted. */
  retracted: boolean;
}

/**
 * Read one batch of changes after `since`, oldest first.
 *
 * Local replica, not the leader: a watcher that lags is behaving correctly, and
 * paying a leader round-trip per scan to shave that lag would put every
 * controller's steady-state polling on the leader (spec 032 §3.3).
 */
export async function changesSince(
  since: number,
  opts: WatchOptions = {},
): Promise<Change[]> {
  const batchSize = opts.batchSize ?? 500;
  const kinds = opts.kinds ?? [];

  // Parameterized IN-list: the kind names are a fixed, registered vocabulary,
  // but they still travel as parameters rather than being interpolated.
  const kindFilter =
    kinds.length > 0
      ? ` AND kind IN (${kinds.map((_, i) => `$${i + 2}`).join(", ")})`
      : "";
  const rows = await query<ResourceRow>(
    `SELECT * FROM ${RESOURCE_TABLE}
      WHERE revision > $1${kindFilter}
      ORDER BY revision
      LIMIT ${batchSize}`,
    [since, ...kinds],
    { tables: [RESOURCE_TABLE] },
  );

  return rows.map((row) => ({
    resource: hydrateRow(row),
    retracted: row.deleted_at !== null,
  }));
}

/**
 * A wake source: resolves when a relevant notify arrives, or when the tick
 * elapses, whichever comes first.
 *
 * Returned as a factory rather than a bare promise because the subscription has
 * to be live BEFORE the scan runs. Subscribing after the scan would drop every
 * notify issued during it, which is precisely the window a busy store fills.
 */
export function waker(opts: WatchOptions & { tickMs?: number } = {}): {
  next: () => Promise<void>;
  stop: () => void;
} {
  const tickMs = opts.tickMs ?? 1000;
  const kinds = new Set(opts.kinds ?? []);
  let wake: (() => void) | undefined;

  const unsubscribe = listen((event) => {
    if (kinds.size > 0 && !kinds.has(event.kind)) return;
    wake?.();
  });

  return {
    next(): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(finish, tickMs);
        function finish(): void {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = finish;
      });
    },
    stop(): void {
      unsubscribe();
      wake?.();
    },
  };
}
