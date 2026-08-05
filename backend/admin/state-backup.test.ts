/**
 * The hot backup path's reach into the state layer (spec 027 §3.2).
 *
 * Asserted against a booted node rather than a mock, because the two properties
 * that matter are the addon's and not this file's: a snapshot taken while the
 * node serves is a real file on the volume, and a second one taken inside the
 * sixty-second duplicate-request guard is the SAME file. The verb reports the
 * age of what it ships on the strength of that second fact (§3.6), so a mock
 * that always returned a fresh name would prove the opposite of the thing.
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

let state: typeof import("../state");

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> => runAsService("admin", fn);

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "state-backup-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;

  state = await import("../state");
  await state.ready;
}, 60_000);

describe("the state backup surface", () => {
  it("produces a snapshot on the volume under the admin service's own attribution", async () => {
    expect(await asAdmin(() => state.backupListLocal())).toEqual([]);
    await asAdmin(() => state.backup());
    const listing = await asAdmin(() => state.backupListLocal());
    expect(listing).toHaveLength(1);
    expect(listing[0].name).toMatch(/backup/);
  });

  it("answers a second request inside the guard window with the first snapshot", async () => {
    // The guard is silent, which is the whole reason the endpoint reports
    // freshness: an archive built from the second call carries a member up to a
    // minute older than the moment it was asked for, and an unstated RPO is
    // always assumed to be zero (§3.6).
    const before = await asAdmin(() => state.backupListLocal());
    await asAdmin(() => state.backup());
    const after = await asAdmin(() => state.backupListLocal());
    expect(after.map((b) => b.name)).toEqual(before.map((b) => b.name));
  });

  it("is denied to a service the manifest does not grant it to", async () => {
    // A domain service that could take a backup could also read every row of
    // the store back out of one, which is the grant this proves is not held.
    await expect(runAsService("members", () => state.backup())).rejects.toThrow(
      /capability bucket.write on 'state-backups' denied for service 'members'/,
    );
  });
});
