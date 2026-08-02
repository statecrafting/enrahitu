/**
 * Bringing mail up (spec 037 §3.4).
 *
 * The order and the failure policy are spec 036 §3.6's, arrived at the same way
 * and for the same reason: a subsystem's failure may not remove the instruments
 * used to diagnose it. Nothing here is fatal. A misconfigured relay leaves the
 * application serving and the notices pending, which is precisely the state an
 * operator needs to be in while they fix the relay.
 */
import { runAsService } from "../kernel/adjudicate";
import { logError, logInfo } from "../lib/logger";
import { startController, type RunningController } from "../control";
import { ready } from "../state";

import { mailControllerSpec, startMailSweep, type RunningMailSweep } from "./controller";
import { registerMailKinds } from "./kinds";
import { noneTransport, resolveTransport, type MailTransport } from "./transport";

const SERVICE = "mail";

let controller: RunningController | undefined;
let sweep: RunningMailSweep | undefined;

/**
 * The transport, resolved once.
 *
 * Resolving at boot rather than per send is what makes §3.6's rule a boot
 * failure instead of a delivery failure: a missing `ENRAHITU_MAIL_FROM` is
 * reported when the deployment starts, by which time somebody is still looking
 * at it, rather than on the first notice weeks later.
 *
 * A resolution failure falls back to `none`, which holds notices as pending
 * rather than losing them.
 */
function transportOrNone(): MailTransport {
  try {
    return resolveTransport();
  } catch (err) {
    logError("mail: transport not configured; notices will be held as pending", {
      error: String((err as Error)?.message ?? err),
    });
    return noneTransport;
  }
}

export async function startMailRuntime(opts: { sweepIntervalMs?: number } = {}): Promise<void> {
  registerMailKinds();
  await ready;

  return runAsService(SERVICE, () => {
    const transport = transportOrNone();
    controller = startController(mailControllerSpec(transport));
    sweep = startMailSweep(
      transport,
      opts.sweepIntervalMs === undefined ? {} : { intervalMs: opts.sweepIntervalMs },
    );
    logInfo("mail: runtime started", { transport: transport.name });
  });
}

export async function stopMailRuntime(): Promise<void> {
  await Promise.all([controller?.stop(), sweep?.stop()]);
  controller = undefined;
  sweep = undefined;
}

/**
 * Fire-and-forget entry point for service load.
 *
 * Nothing here exits the process. Mail is a channel; a deployment whose relay is
 * wrong should still serve its members, and the notices it could not send stay
 * pending and are delivered when the relay is fixed (§3.4).
 */
export function startMailRuntimeOrLog(): void {
  startMailRuntime().catch((err: unknown) => {
    logError("mail: runtime did not start; notices will accumulate as pending", {
      error: String(err),
    });
  });
}
