/**
 * The control plane against a real booted node (spec 034 §4).
 *
 * The properties under test are the ones that only exist once admission, the
 * revision sequence, and a controller are running together. Each is stated as
 * the failure it prevents, because a passing assertion about "revisions
 * increase" says nothing about why the code is shaped the way it is.
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

let control: typeof import("./index");
let state: typeof import("../state");

interface MemberSpec {
  displayName: string;
  tier: "basic" | "supporting" | "lifetime";
}

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "control-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;
  control = await import("./index");
  state = await import("../state");
  await state.ready;

  // The state service owns schema; the control service never migrates.
  await runAsService("state", () => state.migrate(control.CONTROL_PLANE_MIGRATIONS));

  control.registerKind<MemberSpec>({
    name: "member",
    tenantScoped: true,
    validate(input) {
      const obj = control.requireObject("member", input);
      return {
        displayName: control.requireString("member", obj, "displayName"),
        tier: control.requireEnum("member", obj, "tier", [
          "basic",
          "supporting",
          "lifetime",
        ] as const),
      };
    },
  });
  control.registerKind<{ note: string }>({
    name: "clusterNote",
    tenantScoped: false,
    validate(input) {
      const obj = control.requireObject("clusterNote", input);
      return { note: control.requireString("clusterNote", obj, "note") };
    },
  });
}, 60_000);

const asControl = <T>(fn: () => Promise<T>): Promise<T> => runAsService("control", fn);

describe("kinds (spec 034 §3.2)", () => {
  it("normalizes rather than merely approving, so an admitted spec is the clean one", async () => {
    const r = await asControl(() =>
      control.admit<MemberSpec>("member", "ada", { displayName: "  Ada Lovelace  ", tier: "lifetime" }, { tenant: "acme" }),
    );
    expect(r.spec.displayName).toBe("Ada Lovelace");
  });

  it("refuses an invalid spec naming the field, before any write", async () => {
    await expect(
      asControl(() => control.admit("member", "bad", { displayName: "x", tier: "platinum" }, { tenant: "acme" })),
    ).rejects.toThrow(/invalid member: tier: expected one of basic, supporting, lifetime/);
    expect(await asControl(() => control.get("member", "bad", { tenant: "acme" }))).toBeNull();
  });

  it("refuses an unknown kind, listing what is registered", async () => {
    await expect(asControl(() => control.admit("wombat", "w", {}, { tenant: "acme" }))).rejects.toThrow(
      /unknown kind 'wombat'; registered: clusterNote, member/,
    );
  });

  it("holds tenancy both ways: a tenant is required, and refused where meaningless", async () => {
    await expect(asControl(() => control.admit("member", "x", { displayName: "X", tier: "basic" }))).rejects.toThrow(
      /tenant-scoped and no tenant was given/,
    );
    await expect(
      asControl(() => control.admit("clusterNote", "n", { note: "hi" }, { tenant: "acme" })),
    ).rejects.toThrow(/cluster-scoped/);
  });

  it("isolates tenants sharing a resource name", async () => {
    await asControl(() => control.admit("member", "shared", { displayName: "Acme One", tier: "basic" }, { tenant: "acme" }));
    await asControl(() => control.admit("member", "shared", { displayName: "Beta One", tier: "basic" }, { tenant: "beta" }));
    const acme = await asControl(() => control.get<MemberSpec>("member", "shared", { tenant: "acme" }));
    const beta = await asControl(() => control.get<MemberSpec>("member", "shared", { tenant: "beta" }));
    expect(acme?.spec.displayName).toBe("Acme One");
    expect(beta?.spec.displayName).toBe("Beta One");
  });
});

describe("admission (spec 034 §3.3)", () => {
  it("assigns a strictly increasing global revision across kinds and tenants", async () => {
    const a = await asControl(() => control.admit("member", "r1", { displayName: "One", tier: "basic" }, { tenant: "acme" }));
    const b = await asControl(() => control.admit("clusterNote", "r2", { note: "two" }));
    const c = await asControl(() => control.admit("member", "r3", { displayName: "Three", tier: "basic" }, { tenant: "beta" }));
    expect(b.revision).toBeGreaterThan(a.revision);
    expect(c.revision).toBeGreaterThan(b.revision);
  });

  it("writes the outbox row in the same transaction and at the same revision", async () => {
    const r = await asControl(() =>
      control.admit("member", "outboxed", { displayName: "Outboxed", tier: "basic" }, { tenant: "acme" }),
    );
    const rows = await runAsService("state", () =>
      state.query<{ revision: number; op: string; name: string }>(
        `SELECT revision, op, name FROM ${control.OUTBOX_TABLE} WHERE revision = $1`,
        [r.revision],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("outboxed");
    expect(rows[0]!.op).toBe("created");
  });

  it("distinguishes create from update in the outbox op", async () => {
    const first = await asControl(() =>
      control.admit("member", "twice", { displayName: "First", tier: "basic" }, { tenant: "acme" }),
    );
    const second = await asControl(() =>
      control.admit("member", "twice", { displayName: "Second", tier: "supporting" }, { tenant: "acme" }),
    );
    expect(second.revision).toBeGreaterThan(first.revision);
    const ops = await runAsService("state", () =>
      state.query<{ op: string }>(
        `SELECT op FROM ${control.OUTBOX_TABLE} WHERE name = 'twice' ORDER BY revision`,
      ),
    );
    expect(ops.map((o) => o.op)).toEqual(["created", "updated"]);
  });

  it("is a no-op when nothing changed, which is what makes a controller quiescent", async () => {
    const first = await asControl(() =>
      control.admit("member", "idem", { displayName: "Same", tier: "basic" }, { tenant: "acme" }),
    );
    const second = await asControl(() =>
      control.admit("member", "idem", { displayName: "  Same  ", tier: "basic" }, { tenant: "acme" }),
    );
    // Same revision: no write, no outbox row, no notify. Without this a
    // controller that writes what it watches re-triggers itself forever.
    expect(second.revision).toBe(first.revision);
    const outbox = await runAsService("state", () =>
      state.query<{ revision: number }>(
        `SELECT revision FROM ${control.OUTBOX_TABLE} WHERE name = 'idem'`,
      ),
    );
    expect(outbox).toHaveLength(1);
  });

  it("retracts to a tombstone: gone from reads, still there for a watcher", async () => {
    await asControl(() => control.admit("member", "leaver", { displayName: "Leaver", tier: "basic" }, { tenant: "acme" }));
    const retracted = await asControl(() => control.retract("member", "leaver", { tenant: "acme" }));
    expect(retracted?.deletedAt).not.toBeNull();
    expect(await asControl(() => control.get("member", "leaver", { tenant: "acme" }))).toBeNull();
    expect((await asControl(() => control.list("member", { tenant: "acme" }))).map((r) => r.name)).not.toContain(
      "leaver",
    );
    const changes = await asControl(() => control.changesSince(retracted!.revision - 1, { kinds: ["member"] }));
    expect(changes.find((c) => c.resource.name === "leaver")?.retracted).toBe(true);
  });

  it("retracting twice is a no-op rather than a second tombstone", async () => {
    await asControl(() => control.admit("member", "twice-gone", { displayName: "G", tier: "basic" }, { tenant: "acme" }));
    expect(await asControl(() => control.retract("member", "twice-gone", { tenant: "acme" }))).not.toBeNull();
    expect(await asControl(() => control.retract("member", "twice-gone", { tenant: "acme" }))).toBeNull();
  });

  it("rejects a write carrying a fencing token below the one already recorded", async () => {
    await asControl(() =>
      control.admit("member", "fenced", { displayName: "Fenced", tier: "basic" }, { tenant: "acme", fence: 50 }),
    );
    await expect(
      asControl(() =>
        control.admit("member", "fenced", { displayName: "Zombie", tier: "basic" }, { tenant: "acme", fence: 10 }),
      ),
    ).rejects.toThrow(/another holder has the lease/);
    const still = await asControl(() => control.get<MemberSpec>("member", "fenced", { tenant: "acme" }));
    expect(still?.spec.displayName).toBe("Fenced");
  });
});

describe("the watch (spec 034 §3.4)", () => {
  it("returns changes after a revision, in revision order, filtered by kind", async () => {
    const base = await asControl(() =>
      control.admit("member", "w1", { displayName: "W1", tier: "basic" }, { tenant: "acme" }),
    );
    await asControl(() => control.admit("clusterNote", "w-note", { note: "ignored" }));
    await asControl(() => control.admit("member", "w2", { displayName: "W2", tier: "basic" }, { tenant: "acme" }));

    const changes = await asControl(() => control.changesSince(base.revision, { kinds: ["member"] }));
    expect(changes.map((c) => c.resource.name)).toEqual(["w2"]);
    const revisions = changes.map((c) => c.resource.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  });

  it("bounds a batch, so a controller's pass cannot be unbounded work", async () => {
    for (let i = 0; i < 5; i++) {
      await asControl(() =>
        control.admit("member", `batch-${i}`, { displayName: `B${i}`, tier: "basic" }, { tenant: "batch" }),
      );
    }
    const changes = await asControl(() => control.changesSince(0, { kinds: ["member"], batchSize: 3 }));
    expect(changes).toHaveLength(3);
  });
});

describe("controllers (spec 034 §3.5)", () => {
  it("reconciles every pending change once, then records a durable watermark", async () => {
    const seen: string[] = [];
    await asControl(() => control.admit("member", "c1", { displayName: "C1", tier: "basic" }, { tenant: "ctl" }));
    await asControl(() => control.admit("member", "c2", { displayName: "C2", tier: "basic" }, { tenant: "ctl" }));

    const watermark = await asControl(() =>
      control.runOnce({
        name: "test-observer",
        kinds: ["member"],
        reconcile: async (change) => {
          if (change.resource.tenant === "ctl") seen.push(change.resource.name);
        },
      }),
    );
    expect(seen).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect(watermark).toBeGreaterThan(0);

    // The second run starts from the durable watermark, so nothing replays.
    const again: string[] = [];
    await asControl(() =>
      control.runOnce({
        name: "test-observer",
        kinds: ["member"],
        reconcile: async (change) => {
          again.push(change.resource.name);
        },
      }),
    );
    expect(again).toEqual([]);
  });

  it("hands the reconciler a real fencing token it can write through", async () => {
    await asControl(() => control.admit("member", "fenceable", { displayName: "F", tier: "basic" }, { tenant: "ctl2" }));
    let observedFence = -1;
    await asControl(() =>
      control.runOnce({
        name: "test-fencer",
        kinds: ["member"],
        reconcile: async (change, ctx) => {
          if (change.resource.name !== "fenceable") return;
          observedFence = ctx.fence;
          // A status write from inside the reconcile, carrying the pass's token.
          await control.admit(
            "member",
            "fenceable",
            { displayName: "F reconciled", tier: "basic" },
            { tenant: "ctl2", fence: ctx.fence },
          );
        },
      }),
    );
    expect(observedFence).toBeGreaterThan(0);
    const after = await asControl(() => control.get<MemberSpec>("member", "fenceable", { tenant: "ctl2" }));
    expect(after?.spec.displayName).toBe("F reconciled");
    expect(after?.fence).toBe(observedFence);
  });

  it("keeps running when a reconciler throws, rather than exiting the loop", async () => {
    await asControl(() => control.admit("member", "boom", { displayName: "Boom", tier: "basic" }, { tenant: "ctl3" }));
    // The pass fails, so its watermark never advances; the controller survives
    // and the change is still pending for the next pass.
    await asControl(() =>
      control.runOnce({
        name: "test-thrower",
        kinds: ["member"],
        reconcile: async (change) => {
          if (change.resource.name === "boom") throw new Error("reconcile failed");
        },
      }),
    );
    const retried: string[] = [];
    await asControl(() =>
      control.runOnce({
        name: "test-thrower",
        kinds: ["member"],
        reconcile: async (change) => {
          retried.push(change.resource.name);
        },
      }),
    );
    expect(retried).toContain("boom");
  });
});

describe("the capability boundary (spec 034 §3.3)", () => {
  it("denies admission to a service without the state grants", async () => {
    await expect(
      runAsService("web", () =>
        control.admit("member", "unauthorized", { displayName: "No", tier: "basic" }, { tenant: "acme" }),
      ),
    ).rejects.toThrow(/kernel:deny:capability:undeclared/);
  });

  it("denies the control plane the schema change it does not hold", async () => {
    await expect(asControl(() => state.migrate(control.CONTROL_PLANE_MIGRATIONS))).rejects.toThrow(
      /kernel:deny:capability:undeclared/,
    );
  });
});
