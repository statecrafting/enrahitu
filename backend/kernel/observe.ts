/**
 * The kernel's observation hook (spec 021 §3.6 amendment, spec 022 §3.2):
 * the enforcement plane announces denials to at most one registered
 * observer so the observability tier can attach the Decision id to the
 * active span. The kernel imports nothing from backend/obs/ (direction is
 * preserved: obs registers here), and a failing observer can never affect
 * enforcement.
 */
export interface DenialObservation {
  decisionId: string;
  service: string;
  capability: { kind: string; resource: string };
  outcome: string;
  reason: string;
  checkIds: string[];
}

let observer: ((denial: DenialObservation) => void) | undefined;

export function setDenialObserver(fn: ((denial: DenialObservation) => void) | undefined): void {
  observer = fn;
}

export function notifyDenial(denial: DenialObservation): void {
  try {
    observer?.(denial);
  } catch {
    // Observation is best-effort; enforcement already happened.
  }
}
