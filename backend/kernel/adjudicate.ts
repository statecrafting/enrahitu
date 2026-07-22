/**
 * The single enforcement call of the TS tier (spec 021 §3.5): demand() a
 * capability before an operation crosses into Rust. Deny-by-default is the
 * kernel's (statecrafting spec 004 §3.4); this module adds acting-service
 * attribution, the typed deny, and the Decision append.
 *
 * Attribution precedence: explicit service argument, then an ambient
 * runAsService scope (module-eval side effects, tests), then the encore
 * request context. Unattributable requests are adjudicated as the empty
 * service and denied by the kernel's unknown-service rule: unverifiable
 * is denied, never excused.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { currentRequest } from "encore.dev";
import { APIError } from "encore.dev/api";
import { adjudicate as kernelAdjudicate } from "@statecrafting/kernel-native";

import { recordDenial } from "./decisions";
import { notifyDenial } from "./observe";

const serviceScope = new AsyncLocalStorage<string>();

/** Run fn with its kernel attribution pinned to `service`. */
export function runAsService<T>(service: string, fn: () => T): T {
  return serviceScope.run(service, fn);
}

export function actingService(): string | undefined {
  const scoped = serviceScope.getStore();
  if (scoped) return scoped;
  const meta = currentRequest();
  if (meta?.type === "api-call") return meta.api.service;
  if (meta?.type === "pubsub-message") return meta.service;
  return undefined;
}

export interface CapabilityRef {
  kind: string;
  resource: string;
}

export interface Adjudication {
  decision: { outcome: string; reason: string; checkIds: string[]; blocking: boolean };
  configHash: string;
  modelHash: string;
}

export interface DemandOptions {
  service?: string;
  attributes?: Record<string, unknown>;
  payloadSummary?: string;
  payloadBody?: string;
}

/**
 * Adjudicate one proposed effect against the booted model. Returns on
 * allow; on anything else appends the Decision (fire-and-forget) and
 * throws the typed deny naming the missing capability.
 */
export function demand(kind: string, resource: string, opts: DemandOptions = {}): void {
  const service = opts.service ?? actingService() ?? "";
  const capability: CapabilityRef = { kind, resource };
  const request: Record<string, unknown> = { service, capability };
  if (opts.attributes && Object.keys(opts.attributes).length > 0) {
    request.attributes = opts.attributes;
  }
  if (opts.payloadSummary !== undefined) request.payloadSummary = opts.payloadSummary;
  if (opts.payloadBody !== undefined) request.payloadBody = opts.payloadBody;

  const result = JSON.parse(kernelAdjudicate(JSON.stringify(request))) as Adjudication;
  if (result.decision.outcome === "allow") return;

  const decisionId = recordDenial({ service, capability, attributes: opts.attributes, result });
  notifyDenial({
    decisionId,
    service,
    capability,
    outcome: result.decision.outcome === "degrade" ? "degrade" : "deny",
    reason: result.decision.reason,
    checkIds: result.decision.checkIds,
  });
  throw APIError.permissionDenied(
    `capability ${kind} on '${resource}' denied for service '${service || "<unattributed>"}': ${result.decision.reason}`,
  ).withDetails({
    code: "KERNEL_DENIED",
    kind,
    resource,
    service,
    reason: result.decision.reason,
    decisionId,
  });
}
