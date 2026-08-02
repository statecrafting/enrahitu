/**
 * The notice list (spec 037 §3.3).
 *
 * One endpoint, and it exists to make one sentence in the spec true: a notice
 * that exhausts its attempts is `failed` and STAYS VISIBLE, because a notice
 * that gave up silently is worse than one that was never raised. The treasurer
 * believes the member was told.
 *
 * Operator-gated, and read-only. Retrying by hand is not offered: a notice is
 * retried by the schedule, and a button that re-sends is a button that sends a
 * member their third copy of the same reminder.
 */
import { api, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { list } from "../control";
import { operatorRole, requireRole } from "../lib/roles";
import { guarded } from "../members/store";
import { tenantId } from "../members/tenant";

import { MAIL_NOTICE, type MailNoticeSpec, type MailNoticeStatus, type NoticeState } from "./kinds";

export interface NoticeView {
  name: string;
  to: string;
  subject: string;
  template: string;
  state: NoticeState;
  attempts: number;
  lastError?: string;
  sentAt?: string;
  nextAttemptAt?: string;
  revision: number;
}

export interface NoticeList {
  notices: NoticeView[];
}

export const listNotices = api(
  { expose: true, auth: true, method: "GET", path: "/api/notices" },
  async ({ state }: { state?: Query<string> }): Promise<NoticeList> => {
    requireRole(getAuthData()!, operatorRole());
    const tenant = tenantId();
    return guarded(async () => {
      const rows = await list<MailNoticeSpec>(MAIL_NOTICE, { tenant });
      const notices = rows
        .map((r) => {
          const status = (r.status as MailNoticeStatus | null) ?? {
            state: "pending" as const,
            attempts: 0,
          };
          const view: NoticeView = {
            name: r.name,
            to: r.spec.to,
            subject: r.spec.subject,
            template: r.spec.template,
            state: status.state,
            attempts: status.attempts,
            revision: r.revision,
          };
          if (status.lastError) view.lastError = status.lastError;
          if (status.sentAt) view.sentAt = status.sentAt;
          if (status.nextAttemptAt) view.nextAttemptAt = status.nextAttemptAt;
          return view;
        })
        .filter((n) => (state ? n.state === state : true));
      return { notices };
    });
  },
);
