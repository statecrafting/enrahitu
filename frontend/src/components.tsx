import type { Failure, InvoiceState, MembershipState } from "./lib/members";

/**
 * A refusal the staff can act on.
 *
 * The three that actually happen each get their own sentence: not an operator,
 * schema not yet applied (spec 036 §3.6), and no linked member record. Anything
 * else falls through to the server's own message, which is written for a person
 * rather than for a log.
 */
export function Refusal({ failure }: { failure: Failure }) {
  const title =
    failure.status === 403
      ? "This page is for the association's staff"
      : failure.status === 503
        ? "This deployment is not finished setting up"
        : failure.status === 404
          ? "Nothing here yet"
          : "That did not work";
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="hint">{failure.message}</p>
    </section>
  );
}

const MEMBERSHIP_WORDS: Record<MembershipState, string> = {
  active: "active",
  pending: "dues outstanding",
  lapsed: "lapsed",
  invalid: "needs attention",
};

export function StateBadge({ state }: { state: MembershipState }) {
  return <span className={`badge badge-${state}`}>{MEMBERSHIP_WORDS[state]}</span>;
}

const INVOICE_WORDS: Record<InvoiceState, string> = {
  open: "open",
  paid: "paid",
  void: "void",
};

export function InvoiceBadge({ state }: { state: InvoiceState }) {
  return <span className={`badge badge-invoice-${state}`}>{INVOICE_WORDS[state]}</span>;
}
