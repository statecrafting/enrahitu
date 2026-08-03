/**
 * Raising a notice: the entire surface a domain is allowed to touch (spec 037).
 *
 * **This is a separate module from the barrel for a reason the toolchain found
 * rather than a reason anybody argued.** The barrel re-exports the transport,
 * and capability attribution is per-service over the import graph (spec 020
 * §3.4), so `backend/members/` importing `../mail` made the members service
 * inherit the transport's `http.egress` ceiling. Model verification refused it:
 *
 *     service 'members' uses http.egress (via backend/mail/transport.ts)
 *     beyond its declared ceiling
 *
 * That refusal is worth more than the fix. The barrel's own comment claimed a
 * domain needs `raiseNotice` and nothing else, and the import graph quietly
 * said otherwise; granting `members` the egress capability would have made the
 * error go away and made the claim false. A domain that can reach the transport
 * can send inside a request, which is the one thing spec 037 §3.3 is arranged to
 * prevent.
 *
 * So the rule is structural: **domains import this module, never the barrel.**
 * Nothing reachable from here opens a socket or a connection.
 */
import { admit } from "../control";

import { MAIL_NOTICE, type MailNoticeSpec } from "./kinds";
import { noticeNameFor } from "./schedule";

export { MAIL_NOTICE, registerMailKinds } from "./kinds";
export type { MailNoticeSpec, MailNoticeStatus, NoticeState } from "./kinds";
export { noticeNameFor } from "./schedule";

/**
 * Raise a notice, idempotently.
 *
 * `kind` and `subject` compose the name, and the name IS the identity: raising
 * `dues-reminder` about invoice `ada-2026-01-01` twice raises one resource,
 * because the second `admit` normalizes to the spec already stored and produces
 * no revision (spec 034 §3.3). Callers therefore do no bookkeeping and keep no
 * memory of what they have raised, which is what makes a controller correct
 * after a crash, a replay, or a watermark reset.
 *
 * Returns nothing on purpose. There is no send result to report: the notice has
 * been recorded, and whether it has left the building is the controller's
 * observation, readable as the notice's status.
 */
export async function raiseNotice(
  tenant: string,
  kind: string,
  subject: string,
  spec: MailNoticeSpec,
  opts: { actor?: string } = {},
): Promise<void> {
  await admit(MAIL_NOTICE, noticeNameFor(kind, subject), spec, {
    tenant,
    ...(opts.actor === undefined ? {} : { actor: opts.actor }),
  });
}
