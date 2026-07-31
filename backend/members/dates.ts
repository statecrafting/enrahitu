/**
 * Calendar arithmetic for renewal (spec 036 §3.7).
 *
 * Membership terms are calendar days (`YYYY-MM-DD`), never instants. A term that
 * ends "on the 30th" ends on the 30th in the association's own reckoning, and
 * carrying a timestamp would make the answer depend on the reader's timezone:
 * two operators in different offsets would see different lapse dates for the
 * same row, and the one who is wrong would have no way to tell.
 *
 * Everything here is UTC-anchored string arithmetic for that reason. The only
 * place a clock is read is `today()`, and the renewal rule takes the day as an
 * argument rather than calling it, so the rule is testable at any date.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a well-formed calendar day that actually exists. */
export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  // Round-tripping rejects 2026-02-30 and 2026-13-01, which the regex admits.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Today, UTC. The only clock read in the renewal path. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export type PaidOn = { ok: true; day: string } | { ok: false; problem: string };

/**
 * Resolve the day a payment was received (spec 036 §3.9).
 *
 * Absent, it is today. Present, it is a treasurer entering a cheque that arrived
 * last week, and two days are refused: one that does not exist, and one in the
 * future. A receipt dated forward records nothing that has happened, and the
 * ordinary way to produce one is a typo in the year.
 *
 * `now` is an argument rather than a clock read so the default and the
 * comparison cannot straddle midnight: read twice, a payment recorded at
 * 23:59:59.999 could default to one day and then be refused for being after the
 * next. It also makes every branch reachable in a test at the date that produces
 * it.
 *
 * It answers rather than throwing, so this module keeps no dependency on the
 * edge's error vocabulary; the endpoint turns a refusal into a 400.
 */
export function resolvePaidOn(provided: string | undefined, now: string): PaidOn {
  if (provided === undefined) return { ok: true, day: now };
  if (!isDay(provided)) {
    return { ok: false, problem: `paidOn '${provided}' is not a calendar day (YYYY-MM-DD)` };
  }
  if (provided > now) {
    return { ok: false, problem: `paidOn '${provided}' is in the future; today is ${now}` };
  }
  return { ok: true, day: provided };
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/**
 * Advance one billing period, clamping to the end of the target month.
 *
 * Clamping is the whole reason this is not `setUTCMonth(+1)`: on the 31st of
 * January that rolls to March 3rd, so a monthly membership taken out on the 31st
 * would skip February every year and drift forward one month at a time. The
 * same applies to a leap-day annual term, which lands on February 28th in a
 * common year rather than on March 1st.
 */
export function addPeriod(day: string, period: "annual" | "monthly"): string {
  const date = new Date(`${day}T00:00:00Z`);
  const dayOfMonth = date.getUTCDate();
  const target = new Date(date);
  target.setUTCDate(1);
  if (period === "annual") target.setUTCFullYear(target.getUTCFullYear() + 1);
  else target.setUTCMonth(target.getUTCMonth() + 1);

  const lastOfTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(dayOfMonth, lastOfTarget));
  return target.toISOString().slice(0, 10);
}
