import { Form, Link, useActionData, useLoaderData } from "react-router";

import { InvoiceBadge, Refusal, StateBadge } from "../components";
import {
  isFailure,
  money,
  todayUtc,
  type Failure,
  type MemberDetail as Detail,
  type Result,
  type TierView,
} from "../lib/members";

export interface MemberDetailData {
  detail: Result<Detail>;
  tiers: Result<{ tiers: TierView[] }>;
}

/**
 * One member: who they are, where their membership stands, and what they owe.
 *
 * Recording a payment posts to the invoice and nothing else. The membership
 * renews because the renewal controller notices the invoice changed (spec 036
 * §3.7), which is why there is no "renew" button here: a button that renewed
 * directly would be a second implementation of the association's policy.
 */
export default function MemberDetail() {
  const { detail, tiers } = useLoaderData() as MemberDetailData;
  const problem = useActionData() as Failure | undefined;

  if (isFailure(detail)) return <Refusal failure={detail} />;
  const { member, membership, invoices } = detail;
  const tierOptions = isFailure(tiers) ? [] : tiers.tiers;

  return (
    <>
      <section className="card">
        <h2>{member.displayName}</h2>
        <dl>
          <dt>handle</dt>
          <dd>{member.name}</dd>
          <dt>email</dt>
          <dd>{member.email}</dd>
          <dt>joined</dt>
          <dd>{member.joinedOn}</dd>
          <dt>login linked</dt>
          <dd>{member.sub ? "yes" : <span className="hint">not yet</span>}</dd>
        </dl>
        <p className="hint">
          <Link to="/members">back to the roster</Link>
        </p>
      </section>

      <section className="card">
        <h2>Membership</h2>
        {problem ? <p className="error">{problem.message}</p> : null}
        {membership ? (
          <>
            <p>
              <StateBadge state={membership.state} />
            </p>
            <dl>
              <dt>tier</dt>
              <dd>{membership.tier}</dd>
              <dt>term</dt>
              <dd>
                {membership.startsOn} to {membership.endsOn ?? "no end date"}
              </dd>
              {membership.renewsOn ? (
                <>
                  <dt>renews</dt>
                  <dd>{membership.renewsOn}</dd>
                </>
              ) : null}
              {membership.lapsedOn ? (
                <>
                  <dt>lapsed</dt>
                  <dd>{membership.lapsedOn}</dd>
                </>
              ) : null}
              <dt>renewal</dt>
              <dd>{membership.autoRenew ? "automatic" : "manual"}</dd>
            </dl>
            {membership.problem ? <p className="error">{membership.problem}</p> : null}
          </>
        ) : (
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="enroll" />
            <p className="hint">Not enrolled yet.</p>
            <label>
              tier
              <select name="tier" required>
                {tierOptions.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.label} ({money(t.duesCents)} {t.period})
                  </option>
                ))}
              </select>
            </label>
            <label>
              starts on
              <input name="startsOn" type="date" required />
            </label>
            <label>
              ends on
              <input name="endsOn" type="date" />
            </label>
            <p className="hint">Leave the end date empty for a lifetime tier.</p>
            <label className="kv">
              <input name="autoRenew" type="checkbox" defaultChecked />
              renew automatically
            </label>
            <button className="button primary" type="submit">
              Enrol
            </button>
          </Form>
        )}
      </section>

      <section className="card">
        <h2>Dues</h2>
        {invoices.length === 0 ? (
          <p className="hint">Nothing has been billed yet.</p>
        ) : (
          <table className="roster">
            <thead>
              <tr>
                <th>term</th>
                <th>amount</th>
                <th>due</th>
                <th>state</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.name}>
                  <td>
                    {invoice.periodStart} to {invoice.periodEnd}
                  </td>
                  <td>{money(invoice.amountCents)}</td>
                  <td>{invoice.dueOn}</td>
                  <td>
                    <InvoiceBadge state={invoice.state} />
                    {invoice.paidOn ? <div className="hint">paid {invoice.paidOn}</div> : null}
                  </td>
                  <td>
                    {invoice.state === "open" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="pay" />
                        <input type="hidden" name="invoice" value={invoice.name} />
                        {/* Empty means today (spec 036 §3.9). */}
                        <input
                          type="date"
                          name="paidOn"
                          max={todayUtc()}
                          aria-label="payment date"
                        />
                        <button className="button" type="submit">
                          Record payment
                        </button>
                      </Form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
