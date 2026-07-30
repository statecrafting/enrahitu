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
