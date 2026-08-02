/**
 * The delivery rule (spec 037 §3.3), as pure functions.
 *
 * Three decisions live here and none of them needs a node, a relay, or a clock
 * it reads itself: what a notice is called, when a failed notice may be tried
 * again, and which notices a pass should attempt at all. Keeping them separable
 * from the controller is the same move spec 036 §3.7 made for the renewal rule,
 * and for the same reason: "when does a member get chased for dues" is a policy
 * a board has opinions about, and a policy readable only as a sequence of store
 * calls cannot be reviewed by the people whose policy it is.
 */
import type { MailNoticeStatus, NoticeState } from "./kinds";

/**
 * The maximum number of attempts before a notice is `failed`.
 *
 * Six attempts spread by the backoff below covers about half a day, which is
 * longer than an ordinary relay outage and shorter than the interval at which
 * anybody would look. Past that the notice is not going to be delivered by
 * repetition.
 */
export const MAX_ATTEMPTS = 6;

/** Base backoff, doubled per attempt: 1m, 2m, 4m, 8m, 16m, 32m. */
const BASE_BACKOFF_MS = 60_000;

/**
 * The name a notice is stored under, and therefore its identity.
 *
 * Derived from what the notice is ABOUT, never from a clock or a counter. The
 * whole idempotence story rests on this: raising the same notice twice raises
 * one, because the second `admit` normalizes to the spec already stored and
 * produces no revision (spec 034 §3.3). A controller that crashes mid-pass and
 * re-reconciles from a reset watermark therefore sends nothing twice.
 *
 * This is spec 036's `invoiceNameFor` applied to a channel that cannot take back
 * a mistake.
 */
export function noticeNameFor(kind: string, subject: string): string {
  return `${kind}-${subject}`;
}

/**
 * When a notice that just failed its `attempts`-th try may be tried again.
 *
 * Exponential, because the overwhelming cause of a failed send is a relay that
 * is down or throttling, and retrying instantly turns one outage into a tight
 * loop against a host that is already struggling. `now` is an argument so the
 * schedule is reachable in a test at the instant that produces it.
 */
export function nextAttemptAfter(attempts: number, now: number): string {
  const delay = BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return new Date(now + delay).toISOString();
}

export interface DeliveryPlan {
  /** Whether this pass should try to send. */
  attempt: boolean;
  /** Why not, when it should not. Read by tests and by the operator surface. */
  reason?: "already-sent" | "given-up" | "not-yet-due";
}

/**
 * Whether a pass should attempt this notice now.
 *
 * A notice with no status has never been tried. `sent` is terminal and so is
 * `failed`: after the bounded number of attempts a notice stays visible with its
 * last error rather than disappearing, because a notice that gave up silently is
 * worse than one that was never raised. The treasurer believes the member was
 * told.
 */
export function planFor(status: MailNoticeStatus | null, now: number): DeliveryPlan {
  if (!status) return { attempt: true };
  if (status.state === "sent") return { attempt: false, reason: "already-sent" };
  if (status.state === "failed") return { attempt: false, reason: "given-up" };
  if (status.nextAttemptAt && Date.parse(status.nextAttemptAt) > now) {
    return { attempt: false, reason: "not-yet-due" };
  }
  return { attempt: true };
}

/** The status to record after an attempt failed. */
export function afterFailure(
  status: MailNoticeStatus | null,
  error: string,
  now: number,
): MailNoticeStatus {
  const attempts = (status?.attempts ?? 0) + 1;
  const state: NoticeState = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  const next: MailNoticeStatus = {
    state,
    attempts,
    // Truncated: a relay's rejection can be a paragraph, and this string is read
    // in a list of notices rather than in a log.
    lastError: error.slice(0, 500),
  };
  if (state === "pending") next.nextAttemptAt = nextAttemptAfter(attempts, now);
  return next;
}

/** The status to record after an attempt succeeded. */
export function afterSuccess(status: MailNoticeStatus | null, now: number): MailNoticeStatus {
  return {
    state: "sent",
    // The count includes the successful attempt, so a notice delivered on the
    // third try reads as 3 rather than as 2 failures and a mystery.
    attempts: (status?.attempts ?? 0) + 1,
    sentAt: new Date(now).toISOString(),
  };
}
