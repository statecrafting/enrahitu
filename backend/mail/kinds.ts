/**
 * The `mailNotice` kind (spec 037 §3.3).
 *
 * A notice is a resource rather than a function call, and the reason has nothing
 * to do with taste. Sending is not idempotent. Everything else in this substrate
 * is: `admit` normalizes to what is stored and returns without a revision (spec
 * 034 §3.3), which is what lets a controller reconcile the same membership a
 * hundred times and raise one invoice (spec 036 §3.7). A `mailer.send(...)`
 * reconciled a hundred times sends a hundred emails, and the recipient is a
 * person who now distrusts the software.
 *
 * So delivery is reconciliation over a resource and idempotence comes from the
 * same place it comes from everywhere else: the name. A notice is named for what
 * it is ABOUT (`dues-reminder-<invoice>`), never from a clock or a counter, so
 * raising the same notice twice raises one.
 */
import {
  InvalidSpecError,
  optionalString,
  registerKind,
  requireObject,
  requireString,
  type Kind,
} from "../control";

export const MAIL_NOTICE = "mailNotice";

export type NoticeState = "pending" | "sent" | "failed";

export interface MailNoticeSpec {
  /** The recipient address. One notice, one recipient: see spec 037 §5 on bulk. */
  to: string;
  /** Template name, resolved against `app/mail/templates/` then the chassis. */
  template: string;
  /** What the notice says, as data. Rendered by the template. */
  params: Record<string, string>;
  /** The subject line the notice is about, in the reader's words. */
  subject: string;
}

/**
 * What the controller has observed about delivery.
 *
 * `nextAttemptAt` is an ISO instant rather than a calendar day, unlike the
 * membership domain's dates (spec 036 §3.7): a backoff is a duration measured in
 * seconds and a day-granular schedule could not express it.
 */
export interface MailNoticeStatus {
  state: NoticeState;
  attempts: number;
  lastError?: string;
  sentAt?: string;
  nextAttemptAt?: string;
}

// Shape only, not deliverability. The same rule the member kind uses (spec 036
// §3.1): a validator that tries to be RFC 5322 rejects addresses that work.
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Templates are resolved into a filesystem path, so the name is bounded to what
// cannot escape the directory it is joined onto. A traversal here would read an
// arbitrary file and mail its contents to an address the same request chose.
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const mailNoticeKind: Kind<MailNoticeSpec> = {
  name: MAIL_NOTICE,
  tenantScoped: true,
  validate(input) {
    const obj = requireObject(MAIL_NOTICE, input);

    const to = requireString(MAIL_NOTICE, obj, "to").trim().toLowerCase();
    if (!ADDRESS.test(to)) {
      throw new InvalidSpecError(MAIL_NOTICE, "to", `expected an email address, got '${to}'`);
    }

    const template = requireString(MAIL_NOTICE, obj, "template");
    if (!TEMPLATE_NAME.test(template)) {
      throw new InvalidSpecError(
        MAIL_NOTICE,
        "template",
        `expected a template name (lowercase letters, digits and hyphens), got '${template}'`,
      );
    }

    const subject = requireString(MAIL_NOTICE, obj, "subject").trim();
    if (!subject) {
      throw new InvalidSpecError(MAIL_NOTICE, "subject", "must not be empty");
    }

    // Params are the template's substitutions and are stringly typed on purpose:
    // a template renders text, and letting numbers and dates through unformatted
    // is how a member receives "your dues of 4500 are due on 1767225600000".
    const rawParams = obj.params === undefined || obj.params === null ? {} : obj.params;
    if (typeof rawParams !== "object" || Array.isArray(rawParams)) {
      throw new InvalidSpecError(MAIL_NOTICE, "params", "expected an object of strings");
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new InvalidSpecError(
          MAIL_NOTICE,
          `params.${key}`,
          `expected a string, got ${typeof value}`,
        );
      }
      params[key] = value;
    }

    const spec: MailNoticeSpec = { to, template, params, subject };
    const replyTo = optionalString(MAIL_NOTICE, obj, "replyTo");
    if (replyTo !== undefined && replyTo !== "") {
      // Inbound mail is out of scope (spec 037 §5); a reply-to that reaches a
      // human mailbox is the honest answer for as long as it is honest.
      if (!ADDRESS.test(replyTo)) {
        throw new InvalidSpecError(MAIL_NOTICE, "replyTo", `expected an email address`);
      }
      (spec as MailNoticeSpec & { replyTo?: string }).replyTo = replyTo.toLowerCase();
    }
    return spec;
  },
};

export function registerMailKinds(): void {
  registerKind(mailNoticeKind);
}
