/**
 * The membership core against a booted node (spec 036 §4).
 *
 * Each property is stated as the failure it prevents. "The controller raises an
 * invoice" is not worth asserting; "the controller raises exactly one invoice
 * however many times it runs" is the entire reason the design looks the way it
 * does.
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { runAsService } from "../kernel/adjudicate";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const TENANT_A = "hollis-society";
const TENANT_B = "beta-assoc";

let control: typeof import("../control");
let state: typeof import("../state");
let kinds: typeof import("./kinds");
let controller: typeof import("./controller");
let store: typeof import("./store");
let tenantMod: typeof import("./tenant");
let boot: typeof import("./boot");
let mail: typeof import("../mail/notice");

const asMembers = <T>(fn: () => Promise<T>): Promise<T> => runAsService("members", fn);

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "members-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;
  process.env.ENRAHITU_TENANT = TENANT_A;

  control = await import("../control");
  state = await import("../state");
  kinds = await import("./kinds");
  controller = await import("./controller");
  store = await import("./store");
  tenantMod = await import("./tenant");
  boot = await import("./boot");
  mail = await import("../mail/notice");
  await state.ready;

  // The state service owns schema; the domain never migrates (spec 036 §3.6).
  await runAsService("state", () => state.migrate(control.CONTROL_PLANE_MIGRATIONS));
  kinds.registerMembershipKinds();
  // The renewal controller raises mail notices (spec 037), so the kind has to be
  // registered here exactly as boot registers it.
  mail.registerMailKinds();
}, 60_000);

/** A tier, a member and a membership, ready to reconcile. */
async function seed(
  tenant: string,
  name: string,
  over: Partial<import("./kinds").MembershipSpec> = {},
  tier: Partial<import("./kinds").TierSpec> = {},
): Promise<void> {
  await asMembers(async () => {
    await control.admit(
      kinds.TIER,
      "individual",
      { label: "Individual", duesCents: 4500, period: "annual", votingRights: true, graceDays: 30, ...tier },
      { tenant },
    );
    await control.admit(
      kinds.MEMBER,
      name,
      { displayName: name, email: `${name}@example.org`, joinedOn: "2025-01-01" },
      { tenant },
    );
    await control.admit(
      kinds.MEMBERSHIP,
      `${name}-individual`,
      { member: name, tier: "individual", startsOn: "2025-01-01", endsOn: "2026-01-01", autoRenew: true, ...over },
      { tenant },
    );
  });
}

describe("the tenant seam (spec 036 §3.2)", () => {
  it("reads an operator-chosen slug, and refuses to invent one in production", () => {
    expect(tenantMod.tenantId()).toBe(TENANT_A);

    const saved = process.env.ENRAHITU_TENANT;
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.ENRAHITU_TENANT;
      process.env.NODE_ENV = "production";
      tenantMod.resetTenantForTest();
      expect(() => tenantMod.tenantId()).toThrow(/ENRAHITU_TENANT is required/);

      process.env.NODE_ENV = "test";
      tenantMod.resetTenantForTest();
      expect(tenantMod.tenantId()).toBe("local-dev");

      process.env.ENRAHITU_TENANT = "Not A Slug";
      tenantMod.resetTenantForTest();
      expect(() => tenantMod.tenantId()).toThrow(/is not a valid slug/);
    } finally {
      process.env.ENRAHITU_TENANT = saved;
      process.env.NODE_ENV = savedNodeEnv;
      tenantMod.resetTenantForTest();
    }
    expect(tenantMod.tenantId()).toBe(TENANT_A);
  });
});

describe("the kinds (spec 036 §3.1)", () => {
  it("normalizes rather than approving, so what is stored is the clean value", async () => {
    const stored = await asMembers(() =>
      control.admit<import("./kinds").MemberSpec>(
        kinds.MEMBER,
        "ada",
        { displayName: "  Ada Lovelace  ", email: "ADA@Example.ORG", joinedOn: "2025-03-01" },
        { tenant: TENANT_A },
      ),
    );
    expect(stored.spec.displayName).toBe("Ada Lovelace");
    expect(stored.spec.email).toBe("ada@example.org");
    expect(stored.spec.sub).toBeUndefined();
  });

  it("refuses an invalid value naming the field, before any write", async () => {
    await expect(
      asMembers(() =>
        control.admit(
          kinds.TIER,
          "weekly",
          { label: "Weekly", duesCents: 100, period: "weekly", votingRights: false },
          { tenant: TENANT_A },
        ),
      ),
    ).rejects.toThrow(/invalid tier: period: expected one of annual, monthly, lifetime/);

    await expect(
      asMembers(() =>
        control.admit(
          kinds.MEMBER,
          "bad-day",
          { displayName: "X", email: "x@example.org", joinedOn: "2025-02-30" },
          { tenant: TENANT_A },
        ),
      ),
    ).rejects.toThrow(/invalid member: joinedOn: expected a calendar day/);

    await expect(
      asMembers(() =>
        control.admit(
          kinds.MEMBER,
          "bad-mail",
          { displayName: "X", email: "not-an-address", joinedOn: "2025-01-01" },
          { tenant: TENANT_A },
        ),
      ),
    ).rejects.toThrow(/invalid member: email: expected an email address/);

    expect(await asMembers(() => control.get(kinds.TIER, "weekly", { tenant: TENANT_A }))).toBeNull();
  });

  it("refuses a term that ends before it starts", async () => {
    await expect(
      asMembers(() =>
        control.admit(
          kinds.MEMBERSHIP,
          "backwards",
          { member: "ada", tier: "individual", startsOn: "2026-01-01", endsOn: "2025-01-01", autoRenew: false },
          { tenant: TENANT_A },
        ),
      ),
    ).rejects.toThrow(/invalid membership: endsOn: must not precede startsOn/);
  });
});

describe("referential integrity is observed, not enforced (spec 036 §3.3)", () => {
  it("reports a membership whose tier was retracted, and recovers when it returns", async () => {
    await seed(TENANT_A, "dangling", { tier: "seasonal" });
    await asMembers(() =>
      control.admit(
        kinds.TIER,
        "seasonal",
        { label: "Seasonal", duesCents: 1000, period: "annual", votingRights: false },
        { tenant: TENANT_A },
      ),
    );

    const name = "dangling-individual";
    await asMembers(() => controller.reconcileMembership(TENANT_A, name, 1, "2025-06-01"));
    expect(
      (await asMembers(() => control.get(kinds.MEMBERSHIP, name, { tenant: TENANT_A })))?.status,
    ).toEqual({ state: "active", renewsOn: "2026-01-01" });

    // Retracting a tier that memberships still use is allowed: the point is to
    // show what it broke, not to make it impossible.
    await asMembers(() => control.retract(kinds.TIER, "seasonal", { tenant: TENANT_A }));
    await asMembers(() => controller.reconcileMembership(TENANT_A, name, 1, "2025-06-01"));
    const broken = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, name, { tenant: TENANT_A }),
    );
    expect((broken?.status as { state: string; problem: string }).state).toBe("invalid");
    expect((broken?.status as { problem: string }).problem).toMatch(
      /tier 'seasonal' is not registered/,
    );

    await asMembers(() =>
      control.admit(
        kinds.TIER,
        "seasonal",
        { label: "Seasonal", duesCents: 1000, period: "annual", votingRights: false },
        { tenant: TENANT_A },
      ),
    );
    await asMembers(() => controller.reconcileMembership(TENANT_A, name, 1, "2025-06-01"));
    expect(
      (
        await asMembers(() => control.get(kinds.MEMBERSHIP, name, { tenant: TENANT_A }))
      )?.status,
    ).toEqual({ state: "active", renewsOn: "2026-01-01" });
  });
});

describe("the renewal loop against the store (spec 036 §3.7)", () => {
  it("raises exactly one invoice however many times it reconciles", async () => {
    await seed(TENANT_A, "grace");
    const membership = "grace-individual";
    const invoiceName = "grace-individual-2026-01-01";

    await asMembers(() => controller.reconcileMembership(TENANT_A, membership, 1, "2026-01-05"));
    const first = await asMembers(() =>
      control.get(kinds.DUES_INVOICE, invoiceName, { tenant: TENANT_A }),
    );
    expect(first?.spec).toMatchObject({ amountCents: 4500, periodStart: "2026-01-01", dueOn: "2026-01-31" });

    const afterFirst = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, membership, { tenant: TENANT_A }),
    );
    expect((afterFirst?.status as { state: string }).state).toBe("pending");

    // The whole idempotence claim: reconciling again writes nothing at all.
    await asMembers(() => controller.reconcileMembership(TENANT_A, membership, 1, "2026-01-06"));
    const second = await asMembers(() =>
      control.get(kinds.DUES_INVOICE, invoiceName, { tenant: TENANT_A }),
    );
    expect(second?.revision).toBe(first?.revision);
    const afterSecond = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, membership, { tenant: TENANT_A }),
    );
    expect(afterSecond?.revision).toBe(afterFirst?.revision);

    const invoices = await asMembers(() =>
      control.list<import("./kinds").DuesInvoiceSpec>(kinds.DUES_INVOICE, { tenant: TENANT_A }),
    );
    expect(invoices.filter((i) => i.spec.membership === membership)).toHaveLength(1);
  });

  it("renews on payment and then goes quiet, which is what converged means", async () => {
    const membership = "grace-individual";
    const invoiceName = "grace-individual-2026-01-01";

    const invoice = await asMembers(() =>
      control.get(kinds.DUES_INVOICE, invoiceName, { tenant: TENANT_A }),
    );
    await asMembers(() =>
      control.setStatus(kinds.DUES_INVOICE, invoiceName, { state: "paid", paidOn: "2026-01-10" }, {
        tenant: TENANT_A,
        fence: invoice!.fence,
        actor: "treasurer@example.org",
      }),
    );

    // One pass converges: the term extends and the status becomes active.
    await asMembers(() => controller.reconcileMembership(TENANT_A, membership, 1, "2026-01-11"));
    const renewed = await asMembers(() =>
      control.get<import("./kinds").MembershipSpec>(kinds.MEMBERSHIP, membership, { tenant: TENANT_A }),
    );
    expect(renewed?.spec.endsOn).toBe("2027-01-01");
    expect(renewed?.status).toEqual({ state: "active", renewsOn: "2027-01-01" });

    // The next pass observes the change it just made and writes nothing. Without
    // the no-op rule this is where a controller starts spinning (spec 034 §3.3).
    await asMembers(() => controller.reconcileMembership(TENANT_A, membership, 1, "2026-01-12"));
    const quiet = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, membership, { tenant: TENANT_A }),
    );
    expect(quiet?.revision).toBe(renewed?.revision);
  });

  it("lapses a manual term, an unpaid invoice past its date, and never a lifetime", async () => {
    await seed(TENANT_A, "manual", { autoRenew: false });
    await asMembers(() => controller.reconcileMembership(TENANT_A, "manual-individual", 1, "2026-01-02"));
    expect(
      (await asMembers(() => control.get(kinds.MEMBERSHIP, "manual-individual", { tenant: TENANT_A })))
        ?.status,
    ).toEqual({ state: "lapsed", lapsedOn: "2026-01-01" });

    await seed(TENANT_A, "overdue");
    await asMembers(() => controller.reconcileMembership(TENANT_A, "overdue-individual", 1, "2026-01-05"));
    await asMembers(() => controller.reconcileMembership(TENANT_A, "overdue-individual", 1, "2026-03-01"));
    const lapsed = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, "overdue-individual", { tenant: TENANT_A }),
    );
    expect(lapsed?.status).toEqual({
      state: "lapsed",
      lapsedOn: "2026-01-31",
      currentInvoice: "overdue-individual-2026-01-01",
    });

    await asMembers(() =>
      control.admit(
        kinds.TIER,
        "life",
        { label: "Lifetime", duesCents: 0, period: "lifetime", votingRights: true },
        { tenant: TENANT_A },
      ),
    );
    await asMembers(() =>
      control.admit(
        kinds.MEMBERSHIP,
        "forever",
        { member: "ada", tier: "life", startsOn: "2020-01-01", autoRenew: false },
        { tenant: TENANT_A },
      ),
    );
    await asMembers(() => controller.reconcileMembership(TENANT_A, "forever", 1, "2099-01-01"));
    expect(
      (await asMembers(() => control.get(kinds.MEMBERSHIP, "forever", { tenant: TENANT_A })))?.status,
    ).toEqual({ state: "active" });
  });

  it("raises one dues notice per term, addressed to the member (spec 037)", async () => {
    await seed(TENANT_A, "noticed");
    const invoice = "noticed-individual-2026-01-01";
    const notice = `dues-reminder-${invoice}`;

    // Reconciling repeatedly must produce ONE notice, for the same reason it
    // produces one invoice: the name is derived from what it is about. A member
    // who receives a reminder per reconcile stops reading them.
    for (let i = 0; i < 4; i++) {
      await asMembers(() =>
        controller.reconcileMembership(TENANT_A, "noticed-individual", 0, "2026-02-01"),
      );
    }

    const raised = await asMembers(() =>
      control.get(mail.MAIL_NOTICE, notice, { tenant: TENANT_A }),
    );
    expect(raised).not.toBeNull();
    const spec = raised!.spec as import("../mail/notice").MailNoticeSpec;
    expect(spec.to).toBe("noticed@example.org");
    expect(spec.template).toBe("dues-reminder");
    // The amount is formatted here rather than in the template: a member should
    // not receive "your dues of 4500".
    expect(spec.params.amount).toBe("45.00");
    // The term ended 2026-01-01 and the tier allows 30 days' grace.
    expect(spec.params.dueOn).toBe("2026-01-31");

    const all = await asMembers(() => control.list(mail.MAIL_NOTICE, { tenant: TENANT_A }));
    expect(all.filter((n) => n.name === notice)).toHaveLength(1);
  });

  it("raises a receipt when the payment lands, and never a second one", async () => {
    await seed(TENANT_A, "receipted");
    const invoice = "receipted-individual-2026-01-01";
    await asMembers(() =>
      controller.reconcileMembership(TENANT_A, "receipted-individual", 0, "2026-02-01"),
    );
    await asMembers(() =>
      control.setStatus(kinds.DUES_INVOICE, invoice, { state: "paid", paidOn: "2026-02-02" }, {
        tenant: TENANT_A,
      }),
    );

    for (let i = 0; i < 3; i++) {
      await asMembers(() =>
        controller.reconcileMembership(TENANT_A, "receipted-individual", 0, "2026-02-03"),
      );
    }

    const receipt = await asMembers(() =>
      control.get(mail.MAIL_NOTICE, `dues-receipt-${invoice}`, { tenant: TENANT_A }),
    );
    expect(receipt).not.toBeNull();
    expect((receipt!.spec as import("../mail/notice").MailNoticeSpec).params.paidOn).toBe("2026-02-02");
  });

  it("drives the same convergence through the real controller loop", async () => {
    await seed(TENANT_A, "loopy");
    const applied = await asMembers(() => control.runOnce(controller.renewalControllerSpec()));
    expect(applied).toBeGreaterThan(0);
    const membership = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, "loopy-individual", { tenant: TENANT_A }),
    );
    // Today is well past the seeded term, so the loop has already billed it.
    expect((membership?.status as { state: string }).state).toMatch(/pending|lapsed/);
  });
});

describe("the fence as the human plane's concurrency control (spec 036 §3.4)", () => {
  it("lets a person write a row the controller has fenced, and refuses a stale edit", async () => {
    await seed(TENANT_A, "contended");
    const name = "contended-individual";

    // A controller pass writes status under a real token, raising the mark.
    await asMembers(() => controller.reconcileMembership(TENANT_A, name, 5, "2025-06-01"));
    const current = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, name, { tenant: TENANT_A }),
    );
    expect(current?.fence).toBe(5);

    // Re-reading and passing what was read lands, which is the rule.
    const edited = await asMembers(() =>
      store.writeSpec(
        kinds.MEMBERSHIP,
        name,
        { member: "contended", tier: "individual", startsOn: "2025-01-01", endsOn: "2026-06-01", autoRenew: true },
        { tenant: TENANT_A, actor: "staff@example.org" },
      ),
    );
    expect((edited.spec as import("./kinds").MembershipSpec).endsOn).toBe("2026-06-01");

    // A client holding a fence from before the controller wrote is refused, and
    // told so as 409 rather than silently overwriting what it never saw.
    await expect(
      asMembers(() =>
        store.writeSpec(
          kinds.MEMBERSHIP,
          name,
          { member: "contended", tier: "individual", startsOn: "2025-01-01", endsOn: "2027-01-01", autoRenew: true },
          { tenant: TENANT_A, expected: 0, actor: "stale@example.org" },
        ),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("produces no revision for a status write that changes nothing", async () => {
    const name = "contended-individual";
    const before = await asMembers(() => control.get(kinds.MEMBERSHIP, name, { tenant: TENANT_A }));
    const same = await asMembers(() =>
      control.setStatus(kinds.MEMBERSHIP, name, before?.status, {
        tenant: TENANT_A,
        fence: before!.fence,
      }),
    );
    expect(same?.revision).toBe(before?.revision);
  });
});

describe("the edge's error vocabulary (spec 036 §3.6)", () => {
  it("answers 503 naming the precondition when the schema is absent", () => {
    const mapped = store.toApiError(new Error("no such table: resource")) as {
      code: string;
      message: string;
    };
    expect(mapped.code).toBe("unavailable");
    expect(mapped.message).toMatch(/control plane schema has not been applied/);
  });

  it("reports the schema as present once it has been applied", async () => {
    expect(await asMembers(() => store.schemaPresent())).toBe(true);
  });

  it("turns a validator refusal into 400 naming the field", () => {
    const mapped = store.toApiError(
      new control.InvalidSpecError("tier", "period", "expected one of annual"),
    ) as { code: string };
    expect(mapped.code).toBe("invalid_argument");
  });
});

describe("the ceiling (spec 021, spec 036 §2)", () => {
  it("denies a service that holds no state grants", async () => {
    await expect(
      runAsService("web", () =>
        control.admit(
          kinds.MEMBER,
          "smuggled",
          { displayName: "Smuggled", email: "s@example.org", joinedOn: "2025-01-01" },
          { tenant: TENANT_A },
        ),
      ),
    ).rejects.toThrow(/denied for service 'web'/);
    expect(
      await asMembers(() => control.get(kinds.MEMBER, "smuggled", { tenant: TENANT_A })),
    ).toBeNull();
  });
});

describe("the calendar sweep (spec 036 §3.7)", () => {
  it("reconciles memberships the change feed has already delivered and moved past", async () => {
    // The sweep enumerates associations, so the association needs its record.
    // A display name an operator would have chosen, reused by the boot test below.
    await asMembers(() =>
      control.admit(kinds.TENANT, TENANT_A, { displayName: "Hollis Society" }, { actor: "test" }),
    );
    await seed(TENANT_A, "sweeper");

    const memberships = await asMembers(() =>
      control.list(kinds.MEMBERSHIP, { tenant: TENANT_A }),
    );
    expect(memberships.length).toBeGreaterThan(0);

    // A membership whose term expires tomorrow is not WRITTEN tomorrow, so the
    // change feed can never deliver its expiry: this loop is the only thing that
    // can ever lapse anyone. It reconciles EVERY membership rather than the ones
    // a feed happened to deliver.
    //
    // `contended-individual` carries a hand-raised fence from the concurrency
    // test above and cannot be reconciled, which is convenient here: it sorts
    // before `sweeper-individual`, so if one bad row aborted the pass, the
    // membership seeded by this test would never be reached.
    const swept = await asMembers(() => controller.sweepOnce());
    expect(swept).toBeGreaterThanOrEqual(memberships.length - 1);

    const sweeper = await asMembers(() =>
      control.get(kinds.MEMBERSHIP, "sweeper-individual", { tenant: TENANT_A }),
    );
    expect((sweeper?.status as { state: string } | null)?.state).toBeDefined();

    // And it does it again on the next pass: it keeps no watermark and re-lists
    // from the top, which is what makes stopping early at the budget free.
    const again = await asMembers(() => controller.sweepOnce());
    expect(again).toBe(swept);
  });

  it("shares the change loop's lease key, so the two can never run concurrently", () => {
    // `startController` derives its key as `ctl:<name>`, and the sweep hardcodes
    // the same string. If either side ever drifts, both loops write the same
    // rows under interleaved tokens and each supersedes the other for no reason.
    expect(controller.RENEWAL_LEASE).toBe(`ctl:${controller.RENEWAL_CONTROLLER}`);
  });
});

describe("bringing the domain up (spec 036 §3.6)", () => {
  it("ensures the association record without overwriting what an operator named", async () => {
    // `admit` writes the spec it is given, so an unconditional admit at boot
    // would reset this to the tenant slug on every restart: a change that
    // reverts itself overnight and looks like somebody else undid it.
    await boot.startMembershipRuntime({ sweepIntervalMs: 3_600_000 });
    try {
      const org = await asMembers(() => control.get(kinds.TENANT, TENANT_A));
      expect((org?.spec as { displayName: string }).displayName).toBe("Hollis Society");
    } finally {
      await boot.stopMembershipRuntime();
    }
  }, 30_000);
});

// Last, because both properties below put a second tenant's rows in the store
// and the boot assertion is deliberately strict about that afterwards.
describe("tenant isolation and the boot assertion (spec 036 §3.2)", () => {
  it("passes while the store holds only this deployment's rows", async () => {
    await expect(asMembers(() => tenantMod.assertTenantConsistency())).resolves.toBeUndefined();
  });

  it("reconciles two tenants independently, though the change feed sees both", async () => {
    await seed(TENANT_B, "bruno");

    // The feed carries no tenant predicate by design (spec 034 §3.4), so a
    // reconciler that ignored change.resource.tenant would resolve tiers and
    // write invoices in whichever tenant it happened to be given.
    const changes = await asMembers(() =>
      control.changesSince(0, { kinds: [kinds.MEMBERSHIP], batchSize: 500 }),
    );
    const tenants = new Set(changes.map((c) => c.resource.tenant));
    expect(tenants.has(TENANT_A)).toBe(true);
    expect(tenants.has(TENANT_B)).toBe(true);

    for (const change of changes) {
      if (change.retracted) continue;
      await asMembers(() =>
        controller.reconcileMembership(
          change.resource.tenant,
          change.resource.name,
          6,
          "2026-01-05",
        ),
      );
    }

    const brunoInvoice = "bruno-individual-2026-01-01";
    expect(
      await asMembers(() => control.get(kinds.DUES_INVOICE, brunoInvoice, { tenant: TENANT_B })),
    ).not.toBeNull();
    // The same name in the other tenant is a different resource, and it is empty.
    expect(
      await asMembers(() => control.get(kinds.DUES_INVOICE, brunoInvoice, { tenant: TENANT_A })),
    ).toBeNull();
  });

  it("refuses to start once the store holds another association's rows", async () => {
    await expect(asMembers(() => tenantMod.assertTenantConsistency())).rejects.toThrow(
      /refusing to start.*'hollis-society'.*'beta-assoc'/s,
    );
  });
});
