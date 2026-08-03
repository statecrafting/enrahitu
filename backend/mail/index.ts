/**
 * The mail barrel (spec 037).
 *
 * This is the MAIL SERVICE's surface: it reaches the transport, so anything
 * importing it inherits the transport's egress ceiling (spec 020 §3.4 attributes
 * capabilities per service over the import graph).
 *
 * **A domain raising a notice must import `./notice` instead**, which reaches
 * the store and nothing else. That split is not stylistic: `backend/members/`
 * importing this barrel made model verification refuse the build, because the
 * members service was then deemed to use `http.egress` via the provider
 * transport. See the note at the top of `notice.ts`.
 */
export {
  MAIL_NOTICE,
  mailNoticeKind,
  registerMailKinds,
  type MailNoticeSpec,
  type MailNoticeStatus,
  type NoticeState,
} from "./kinds";
export { raiseNotice } from "./notice";
export { noticeNameFor, planFor, afterFailure, afterSuccess, MAX_ATTEMPTS } from "./schedule";
export { renderTemplate, templateSource, UnknownTemplateError } from "./templates";
export { render, MissingParamError } from "./render";
export {
  resolveTransport,
  noneTransport,
  smtpTransport,
  buildMessage,
  MailNotConfiguredError,
  type MailTransport,
  type Message,
} from "./transport";
export {
  deliverNotice,
  mailControllerSpec,
  mailSweepOnce,
  startMailSweep,
  MAIL_CONTROLLER,
  MAIL_LEASE,
} from "./controller";
