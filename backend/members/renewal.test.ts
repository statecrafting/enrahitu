/**
 * The renewal rule and its calendar arithmetic (spec 036 §3.7, §4).
 *
 * No store, no node, no clock: `evaluate` is a pure function and every branch of
 * the rule is reachable here by choosing a date. That is the property the split
 * exists for. A renewal policy is a thing a board signs off on, and this file is
 * the version of it a board could read.
 */
import { describe, expect, it } from "vitest";

import { addDays, addPeriod, isDay, resolvePaidOn, today } from "./dates";
import { findLinkedMember } from "./identity";
import type { DuesInvoiceSpec, MemberSpec, MembershipSpec, TierSpec } from "./kinds";
import { evaluate, invoiceNameFor } from "./renewal";

const annual: TierSpec = {
  label: "Individual",
  duesCents: 4500,
  period: "annual",
  votingRights: true,
  graceDays: 30,
};

const lifetime: TierSpec = { ...annual, label: "Lifetime", period: "lifetime", duesCents: 0 };

const membership: MembershipSpec = {
  member: "ada",
  tier: "individual",
  startsOn: "2025-01-01",
  endsOn: "2026-01-01",
  autoRenew: true,
};

function run(over: Partial<Parameters<typeof evaluate>[0]> = {}) {
  return evaluate({
    membershipName: "ada-individual",
    membership,
    tier: annual,
    invoice: null,
    today: "2025-06-01",
    ...over,
  });
}

describe("the renewal rule (spec 036 §3.7)", () => {
  it("reports a dangling tier rather than refusing it, naming what is missing", () => {
    const plan = run({ tier: null });
    expect(plan.status.state).toBe("invalid");
    expect(plan.status.problem).toMatch(/tier 'individual' is not registered/);
    expect(plan.invoice).toBeUndefined();
  });

  it("holds a lifetime membership active forever, and refuses a contradictory end date", () => {
    expect(run({ tier: lifetime, membership: { ...membership, endsOn: undefined } }).status).toEqual({
      state: "active",
    });
    const contradiction = run({ tier: lifetime, today: "2099-01-01" });
    expect(contradiction.status.state).toBe("invalid");
    expect(contradiction.status.problem).toMatch(/must not carry endsOn/);
  });

  it("refuses a billed membership with no end date, naming the period that needs one", () => {
    const plan = run({ membership: { ...membership, endsOn: undefined } });
    expect(plan.status.state).toBe("invalid");
    expect(plan.status.problem).toMatch(/bills annual, so this membership needs endsOn/);
  });

  it("is active inside the term and reports when it renews", () => {
    expect(run().status).toEqual({ state: "active", renewsOn: "2026-01-01" });
  });

  it("lapses a manual membership the day the term ends, with no invoice", () => {
    const plan = run({ membership: { ...membership, autoRenew: false }, today: "2026-01-01" });
    expect(plan.status).toEqual({ state: "lapsed", lapsedOn: "2026-01-01" });
    expect(plan.invoice).toBeUndefined();
  });

  it("raises one invoice for the expiring term, priced and dated from the tier", () => {
    const plan = run({ today: "2026-01-02" });
    expect(plan.invoice).toEqual({
      name: "ada-individual-2026-01-01",
      spec: {
        membership: "ada-individual",
        member: "ada",
        tier: "individual",
        amountCents: 4500,
        periodStart: "2026-01-01",
        periodEnd: "2027-01-01",
        dueOn: "2026-01-31",
      },
    });
    expect(plan.status).toEqual({
      state: "pending",
      currentInvoice: "ada-individual-2026-01-01",
      renewsOn: "2027-01-01",
    });
  });

  it("stays pending inside the grace period and raises nothing further", () => {
    const invoice = run({ today: "2026-01-02" }).invoice!;
    const plan = run({ today: "2026-01-20", invoice: { spec: invoice.spec, status: null } });
    expect(plan.invoice).toBeUndefined();
    expect(plan.status.state).toBe("pending");
  });

  it("lapses once the invoice passes its due date, recording the date it was due", () => {
    const invoice = run({ today: "2026-01-02" }).invoice!;
    const plan = run({
      today: "2026-02-01",
      invoice: { spec: invoice.spec, status: { state: "open" } },
    });
    expect(plan.status).toEqual({
      state: "lapsed",
      lapsedOn: "2026-01-31",
      currentInvoice: "ada-individual-2026-01-01",
    });
  });

  it("renews the term when the invoice is paid, which is the whole loop", () => {
    const invoice = run({ today: "2026-01-02" }).invoice!;
    const plan = run({
      today: "2026-01-20",
      invoice: { spec: invoice.spec, status: { state: "paid", paidOn: "2026-01-19" } },
    });
    expect(plan.renewTo).toEqual({
      member: "ada",
      tier: "individual",
      startsOn: "2026-01-01",
      endsOn: "2027-01-01",
      autoRenew: true,
    });
    expect(plan.status).toEqual({ state: "active", renewsOn: "2027-01-01" });
  });

  it("lapses on a voided invoice, which is how an association declines to renew", () => {
    const invoice = run({ today: "2026-01-02" }).invoice!;
    const plan = run({
      today: "2026-01-05",
      invoice: { spec: invoice.spec, status: { state: "void" } },
    });
    expect(plan.status.state).toBe("lapsed");
  });

  it("names an invoice from the term it bills, so the same term names the same invoice", () => {
    expect(invoiceNameFor("ada-individual", "2026-01-01")).toBe("ada-individual-2026-01-01");
    expect(run({ today: "2026-01-02" }).invoice!.name).toBe(
      run({ today: "2026-06-02" }).invoice!.name,
    );
  });

  it("carries no evaluation timestamp, because that would make every pass a write", () => {
    // The quiescence rule compares the serialized status (spec 034 §3.3), so a
    // field that moves with the clock would defeat it. Two evaluations of the
    // same situation on different days must be equal.
    expect(run({ today: "2025-06-01" }).status).toEqual(run({ today: "2025-12-31" }).status);
  });
});

describe("calendar arithmetic (spec 036 §3.7)", () => {
  it("accepts real days and rejects ones that look real", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("2026-1-1")).toBe(false);
    expect(isDay(today())).toBe(true);
  });

  it("adds days across a month and a year boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", 30)).toBe("2026-01-31");
  });

  it("clamps a monthly period instead of skipping the short month", () => {
    // The failure this prevents: setUTCMonth(+1) on January 31st lands on March
    // 3rd, so a membership taken out on the 31st would skip February forever.
    expect(addPeriod("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(addPeriod("2028-01-31", "monthly")).toBe("2028-02-29");
    expect(addPeriod("2026-01-15", "monthly")).toBe("2026-02-15");
    expect(addPeriod("2026-12-15", "monthly")).toBe("2027-01-15");
  });

  it("clamps a leap-day annual term to February 28th in a common year", () => {
    expect(addPeriod("2028-02-29", "annual")).toBe("2029-02-28");
    expect(addPeriod("2026-06-30", "annual")).toBe("2027-06-30");
  });
});

describe("the payment date (spec 036 §3.9)", () => {
  const now = "2026-07-31";

  it("defaults to today when the treasurer sends nothing", () => {
    expect(resolvePaidOn(undefined, now)).toEqual({ ok: true, day: now });
  });

  it("accepts a backdated day, which is the whole point", () => {
    expect(resolvePaidOn("2026-07-01", now)).toEqual({ ok: true, day: "2026-07-01" });
    // The boundary: today itself is not the future.
    expect(resolvePaidOn(now, now)).toEqual({ ok: true, day: now });
  });

  it("refuses a day that does not exist, naming the field", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-7-1", "yesterday", ""]) {
      const answer = resolvePaidOn(bad, now);
      expect(answer.ok).toBe(false);
      expect(answer.ok === false && answer.problem).toContain("paidOn");
    }
  });

  it("refuses a future day, because a receipt records what happened", () => {
    // The failure this prevents is a typo in the year, which is how a payment
    // ends up dated 2027 and sorts to the top of every report thereafter.
    const answer = resolvePaidOn("2027-07-01", now);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.problem).toContain("in the future");
  });

  it("takes the day as an argument so the default cannot straddle midnight", () => {
    // Read from the clock twice, a payment recorded at 23:59:59.999 could default
    // to one day and then be refused for being after the next.
    expect(resolvePaidOn(undefined, "2026-12-31")).toEqual({ ok: true, day: "2026-12-31" });
  });
});

describe("the member-plane join (spec 036 §3.8)", () => {
  const member = (name: string, over: Partial<MemberSpec>) => ({
    name,
    spec: {
      displayName: name,
      email: `${name}@example.org`,
      joinedOn: "2025-01-01",
      ...over,
    } satisfies MemberSpec,
  });

  const roster = [
    member("ada", { sub: "rauthy-sub-1" }),
    member("grace", {}),
  ];

  it("prefers the durable subject binding over the email", () => {
    // This branch matched NOTHING until spec 004's rewrite: the session's
    // userID was a locally minted account id, never the IdP's sub.
    const found = findLinkedMember(roster, {
      userID: "rauthy-sub-1",
      email: "grace@example.org",
      emailVerified: true,
    });
    expect(found?.name).toBe("ada");
  });

  it("falls back to a VERIFIED email, so a pre-enrolled member can see their dues", () => {
    expect(
      findLinkedMember(roster, {
        userID: "unknown",
        email: "GRACE@example.org",
        emailVerified: true,
      })?.name,
    ).toBe("grace");
  });

  it("refuses an unverified address, which is the whole point of the fallback's guard", () => {
    // Registering an account with somebody else's address is the attack. Before
    // spec 004's rewrite nothing checked this and the comment claiming it did
    // was the only protection.
    expect(
      findLinkedMember(roster, {
        userID: "unknown",
        email: "grace@example.org",
        emailVerified: false,
      }),
    ).toBeNull();
  });

  it("never hands an unbound member to a session carrying no subject", () => {
    // `undefined === undefined` would have matched grace, who has no sub.
    expect(
      findLinkedMember(roster, { userID: "", email: "", emailVerified: true }),
    ).toBeNull();
  });

  it("links nothing rather than guessing", () => {
    expect(
      findLinkedMember(roster, {
        userID: "unknown",
        email: "nobody@example.org",
        emailVerified: true,
      }),
    ).toBeNull();
  });
});
