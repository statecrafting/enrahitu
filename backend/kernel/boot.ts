/**
 * Kernel boot (spec 021 §3.4): synchronous, at module evaluation, so no
 * adjudication can precede it and a refused model never serves a request.
 * The model crosses the napi boundary once and is write-once per process
 * (statecrafting spec 004 §3.2): replacing it means restarting the cell,
 * which is exactly deploy semantics.
 *
 * Any of the nine boot refusals (parse, contract range, integrity,
 * dangling refs, unknown kind, unenforceable constraint, unknown check,
 * gate hash mismatch, window config) throws here and the process does not
 * come up. Fail-closed, never a warning.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { boot } from "@statecrafting/kernel-native";

export interface BootReceipt {
  modelHash: string;
  gateConfigHash: string;
  contractVersion: string;
  app: string;
  services: number;
  agents: number;
  capabilities: number;
}

const modelPath =
  process.env.ENRAHITU_APP_MODEL_PATH ?? join(process.cwd(), "app-model.json");

/** The committed model's exact bytes; the ledger genesis derives from them. */
export const modelJson: string = readFileSync(modelPath, "utf8");

/** The boot receipt of the write-once kernel. */
export const receipt: BootReceipt = JSON.parse(boot(modelJson)) as BootReceipt;
