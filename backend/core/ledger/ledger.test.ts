import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Column,
  Entity,
  Ledger,
  LibsqlDriver,
  PostgresDriver,
  ledger as defaultLedger,
} from "./index";

@Entity("test_users")
class TestUser {
  @Column({ primary: true }) id = "";
  @Column({ unique: true }) email = "";
  @Column({ type: "integer", nullable: true }) age: number | null = null;
  @Column({ type: "boolean" }) active = true;
  @Column({ type: "json", nullable: true }) profile: { tags: string[] } | null = null;
  @Column({ type: "timestamp" }) createdAt = new Date("2026-01-01T00:00:00.000Z");
  @Column({ index: true }) role = "user";
}

function user(overrides: Partial<TestUser>): TestUser {
  return Object.assign(new TestUser(), overrides);
}

/**
 * Spec 011 acceptance: the exact same behavioral suite runs against both
 * drivers. The libSQL arm always runs; the Postgres arm runs when
 * TEST_POSTGRES_URL points at a database (CI service or local) and skips
 * cleanly otherwise, so a plain `npm test` stays green.
 */
const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

interface DriverArm {
  name: string;
  skip: boolean;
  open(): Promise<{ ledger: Ledger; close(): Promise<void> }>;
}

const ARMS: DriverArm[] = [
  {
    name: "libsql",
    skip: false,
    async open() {
      const dir = mkdtempSync(join(tmpdir(), "enrahitu-ledger-"));
      const ledger = new Ledger(new LibsqlDriver({ url: `file:${join(dir, "test.db")}` }));
      await ledger.init([TestUser]);
      return {
        ledger,
        close: async () => {
          await ledger.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: "postgres",
    skip: !POSTGRES_URL,
    async open() {
      const ledger = new Ledger(new PostgresDriver({ url: POSTGRES_URL as string }));
      // Persistent database: start from a clean table each run.
      await ledger.execute(`DROP TABLE IF EXISTS "test_users"`);
      await ledger.init([TestUser]);
      return {
        ledger,
        close: async () => {
          await ledger.execute(`DROP TABLE IF EXISTS "test_users"`);
          await ledger.close();
        },
      };
    },
  },
];

for (const arm of ARMS) {
  const suite = arm.skip ? describe.skip : describe;

  suite(`CoreLedger (${arm.name})`, () => {
    let handle: { ledger: Ledger; close(): Promise<void> };
    let ledger: Ledger;

    beforeAll(async () => {
      handle = await arm.open();
      ledger = handle.ledger;
    });

    afterAll(async () => {
      await handle.close();
    });

    it("round-trips an entity through insert + findById with codecs intact", async () => {
      const created = new Date("2026-07-13T12:00:00.000Z");
      await ledger.repo(TestUser).insert(
        user({
          id: "u1",
          email: "u1@example.com",
          age: 30,
          active: true,
          profile: { tags: ["a", "b"] },
          createdAt: created,
        }),
      );

      const found = await ledger.repo(TestUser).findById("u1");
      expect(found).toBeInstanceOf(TestUser);
      expect(found?.email).toBe("u1@example.com");
      expect(found?.age).toBe(30);
      expect(found?.active).toBe(true);
      expect(found?.profile).toEqual({ tags: ["a", "b"] });
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.createdAt.toISOString()).toBe(created.toISOString());
    });

    it("maps camelCase properties to snake_case columns", async () => {
      const rows = await ledger.query(`SELECT created_at FROM "test_users" WHERE id = ?`, ["u1"]);
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toBe("2026-07-13T12:00:00.000Z");
    });

    it("finds by equality criteria including null, with ordering and limits", async () => {
      await ledger.repo(TestUser).insert(user({ id: "u2", email: "u2@example.com", age: null, active: false }));
      await ledger.repo(TestUser).insert(user({ id: "u3", email: "u3@example.com", age: 40, role: "admin" }));

      const inactive = await ledger.repo(TestUser).findWhere({ active: false });
      expect(inactive.map((u) => u.id)).toEqual(["u2"]);

      const ageless = await ledger.repo(TestUser).findWhere({ age: null });
      expect(ageless.map((u) => u.id)).toEqual(["u2"]);

      const ordered = await ledger.repo(TestUser).findWhere({}, { orderBy: "id", direction: "desc", limit: 2 });
      expect(ordered.map((u) => u.id)).toEqual(["u3", "u2"]);

      const admin = await ledger.repo(TestUser).findOne({ role: "admin" });
      expect(admin?.id).toBe("u3");
    });

    it("updates by id, refuses primary-key updates, deletes, and counts", async () => {
      const repo = ledger.repo(TestUser);

      expect(await repo.updateById("u2", { age: 25, active: true })).toBe(true);
      const updated = await repo.findById("u2");
      expect(updated?.age).toBe(25);
      expect(updated?.active).toBe(true);

      await expect(async () => repo.updateById("u2", { id: "nope" })).rejects.toThrow(/primary key/);

      expect(await repo.count()).toBe(3);
      expect(await repo.count({ role: "admin" })).toBe(1);
      expect(await repo.deleteById("u3")).toBe(true);
      expect(await repo.deleteById("u3")).toBe(false);
      expect(await repo.count()).toBe(2);
    });

    it("enforces UNIQUE columns", async () => {
      await expect(
        ledger.repo(TestUser).insert(user({ id: "u9", email: "u1@example.com" })),
      ).rejects.toThrow(/UNIQUE/i);
    });

    it("rolls back a transaction when the callback throws", async () => {
      const before = await ledger.repo(TestUser).count();
      await expect(
        ledger.transaction(async ({ repo }) => {
          await repo(TestUser).insert(user({ id: "tx1", email: "tx1@example.com" }));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await ledger.repo(TestUser).count()).toBe(before);
      expect(await ledger.repo(TestUser).findById("tx1")).toBeNull();
    });

    it("commits a transaction that succeeds", async () => {
      await ledger.transaction(async ({ repo }) => {
        await repo(TestUser).insert(user({ id: "tx2", email: "tx2@example.com" }));
      });
      expect(await ledger.repo(TestUser).findById("tx2")).not.toBeNull();
    });

    it("rejects unknown properties in criteria", async () => {
      await expect(async () =>
        ledger.repo(TestUser).findWhere({ nope: 1 } as unknown as Partial<TestUser>),
      ).rejects.toThrow(/no @Column property/);
    });
  });
}

describe("CoreLedger decorator validation", () => {
  it("requires exactly one primary column", () => {
    expect(() => {
      @Entity("no_primary")
      class NoPrimary {
        @Column() name = "";
      }
      void NoPrimary;
    }).toThrow(/exactly one primary/);
  });

  it("requires at least one column", () => {
    expect(() => {
      @Entity("empty_entity")
      class EmptyEntity {}
      void EmptyEntity;
    }).toThrow(/no @Column fields/);
  });

  it("rejects duplicate column names", () => {
    expect(() => {
      @Entity("dupes")
      class Dupes {
        @Column({ primary: true }) id = "";
        @Column({ name: "id" }) other = "";
      }
      void Dupes;
    }).toThrow(/duplicate column names/);
  });

  it("rejects two entities claiming one table", () => {
    expect(() => {
      @Entity("test_users")
      class Impostor {
        @Column({ primary: true }) id = "";
      }
      void Impostor;
    }).toThrow(/claimed by both/);
  });
});

describe("Ledger.fromEnv", () => {
  it("builds the process-wide ledger lazily from env defaults", () => {
    // Just the wiring: the default URL is file-based and memoized.
    const a = defaultLedger();
    const b = defaultLedger();
    expect(a).toBe(b);
    expect(a.driver.dialect).toBe("sqlite");
  });
});
