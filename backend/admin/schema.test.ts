/**
 * The schema verb against a booted node (spec 023 amendment 2026-07-30).
 *
 * The endpoints themselves are two lines of gate plus a call; what is worth
 * asserting is the deploy step's behavior, which is that it reports honestly
 * before it acts, applies once, and is held by the service the manifest says
 * holds it.
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

let control: typeof import("../control");
let state: typeof import("../state");
let plan: typeof import("./schema-plan");

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> => runAsService("admin", fn);

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "schema-verb-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;

  control = await import("../control");
  state = await import("../state");
  plan = await import("./schema-plan");
  await state.ready;
}, 60_000);

describe("the schema verb", () => {
  it("reports what is pending before anything is applied", async () => {
    const version = await asAdmin(() => state.schemaVersion());
    expect(version).toBe(0);
    const pending = plan.pendingMigrations(version, control.CONTROL_PLANE_MIGRATIONS);
    expect(pending).toEqual([{ version: 1, name: "control plane: resources, outbox, watermarks" }]);
  });

  it("applies the pending migrations under the admin service's own attribution", async () => {
    const applied = await asAdmin(() => state.migrate(control.CONTROL_PLANE_MIGRATIONS));
    expect(applied.map((m) => m.version)).toEqual([1]);
    expect(await asAdmin(() => state.schemaVersion())).toBe(1);
  });

  it("applies nothing the second time, rather than failing on a constraint", async () => {
    const again = await asAdmin(() => state.migrate(control.CONTROL_PLANE_MIGRATIONS));
    expect(again).toEqual([]);
    const version = await asAdmin(() => state.schemaVersion());
    expect(plan.pendingMigrations(version, control.CONTROL_PLANE_MIGRATIONS)).toEqual([]);
  });

  it("is denied to a service the manifest does not grant it to", async () => {
    // `members` deliberately holds no db.migrate: a domain service that could
    // migrate is one that could migrate by accident (spec 036 §3.6).
    await expect(
      runAsService("members", () => state.migrate(control.CONTROL_PLANE_MIGRATIONS)),
    ).rejects.toThrow(/capability db.migrate on 'state' denied for service 'members'/);
  });
});
