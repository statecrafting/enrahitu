/**
 * Phase A acceptance (spec 021 §4): fail-closed boot against the published
 * kernel, the deny-and-audit round trip, and the Decision chain with its
 * deploy genesis. Boot is write-once per process, so refusal cases run in
 * child processes against tampered copies of the committed model.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { boot } from "@statecrafting/kernel-native";
import { APIError, ErrCode } from "encore.dev/api";
import { describe, expect, it } from "vitest";

import { demand, runAsService } from "./adjudicate";
import { modelJson, receipt } from "./boot";
import { decisionRecords, verifyDecisionChain } from "./decisions";

/** Boot a tampered model in a fresh process; return the thrown message. */
function bootInChild(mutate: string): string {
  const script = `
    const k = require("@statecrafting/kernel-native");
    const model = JSON.parse(process.env.MODEL_JSON);
    (${mutate})(model);
    try {
      k.boot(JSON.stringify(model));
      console.log("BOOTED");
    } catch (err) {
      console.log("REFUSED: " + err.message);
    }
  `;
  return execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, MODEL_JSON: modelJson },
  })
    .toString()
    .trim();
}

describe("kernel boot (spec 021 §3.4)", () => {
  it("booted the committed model write-once; a re-boot with the same model is idempotent", () => {
    expect(receipt.modelHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.app).toBe("enrahitu");
    const again = JSON.parse(boot(modelJson)) as typeof receipt;
    expect(again.modelHash).toBe(receipt.modelHash);
  });

  it("refuses a model whose integrity hash does not match its content", () => {
    // Invert rather than set: the committed model records otel: true since
    // spec 022, and only a real mutation breaks the hash.
    const out = bootInChild(`(m) => { m.observability.otel = !m.observability.otel; }`);
    expect(out).toMatch(/^REFUSED: kernel-native boot: integrity mismatch/);
  });

  it("refuses a model declaring a capability kind outside the kind table", () => {
    const out = bootInChild(`(m) => { m.capabilities[0].kind = "quantum.entangle"; }`);
    expect(out).toContain("REFUSED:");
    expect(out).not.toContain("BOOTED");
  });

  it("refuses a model whose pinned gate.configHash does not match the roster", () => {
    const out = bootInChild(
      `(m) => { m.gate.configHash = "sha256:" + "0".repeat(64); }`,
    );
    expect(out).toContain("REFUSED:");
    expect(out).not.toContain("BOOTED");
  });
});

describe("adjudication and the Decision ledger (spec 021 §3.5-§3.6)", () => {
  it("allows a declared operation without ceremony", () => {
    expect(() => runAsService("health", () => demand("db.read", "app"))).not.toThrow();
  });

  it("enforces constraint narrowing: the rate-limit grant covers only rl: keys", () => {
    expect(() =>
      runAsService("auth", () =>
        demand("counter.add", "counters", { attributes: { key: "rl:auth:1.2.3.4:1" } }),
      ),
    ).not.toThrow();
    expect(() =>
      runAsService("auth", () =>
        demand("counter.add", "counters", { attributes: { key: "free:key" } }),
      ),
    ).toThrow(/kernel:deny:constraint:keyPrefix/);
  });

  it("denies an undeclared operation with the typed error and appends the Decision", async () => {
    let thrown: unknown;
    try {
      runAsService("web", () => demand("db.write", "app"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(APIError);
    expect((thrown as APIError).code).toBe(ErrCode.PermissionDenied);
    expect((thrown as APIError).message).toContain("kernel:deny:capability:undeclared");

    const records = await decisionRecords();
    const denial = records.find(
      (r) =>
        (r.payload as { reason?: string; service?: string }).service === "web" &&
        (r.payload as { reason?: string }).reason?.startsWith(
          "kernel:deny:capability:undeclared",
        ),
    );
    expect(denial).toBeDefined();
    expect((denial!.payload as { modelHash: string }).modelHash).toBe(receipt.modelHash);
  });

  it("denies the unattributable: no service context means no ceiling to stand in", () => {
    expect(() => demand("db.read", "app")).toThrow(/kernel:deny:service/);
  });

  it("anchors the chain in a genesis that commits to the booted model hash", async () => {
    const records = await decisionRecords();
    expect(records.length).toBeGreaterThan(0);
    const genesis = records[0]!;
    expect(genesis.id).toMatch(/^genesis-/);
    expect(genesis.previous_record_hash).toBe(receipt.modelHash);
    const payload = genesis.payload as { modelHash: string; reason: string };
    expect(payload.modelHash).toBe(receipt.modelHash);
    expect(payload.reason).toBe(`genesis:${receipt.contractVersion}`);
  });

  it("re-verifies the persisted chain exactly as the stock verifier would", async () => {
    const result = await verifyDecisionChain();
    expect(result).toEqual({ ok: true });
  });

  it("boots from the same bytes the extractor sealed (the committed model)", () => {
    expect(modelJson).toBe(readFileSync("app-model.json", "utf8"));
  });
});
