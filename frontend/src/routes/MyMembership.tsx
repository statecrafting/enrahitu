import { useLoaderData } from "react-router";

import { InvoiceBadge, Refusal, StateBadge } from "../components";
import { isFailure, money, type MyMembership as Mine, type Result } from "../lib/members";

/**
 * The member plane (spec 036 §3.8): the caller's own record and nothing else.
 *
 * The endpoint behind this takes no name, so there is no version of this screen
 * that shows somebody else's standing. It is read-only for the same reason a
 * member cannot mark their own dues paid.
 */
export default function MyMembership() {
  const result = useLoaderData() as Result<Mine>;
  if (isFailure(result)) return <Refusal failure={result} />;

  const { member, membership, outstanding } = result;
  const owed = outstanding.reduce((sum, i) => sum + i.amountCents, 0);

  return (
    <>
      <section className="card">
        <h2>{member.displayName}</h2>
        {membership ? (
          <>
            <p>
              <StateBadge state={membership.state} />
            </p>
            <dl>
              <dt>tier</dt>
              <dd>{membership.tier}</dd>
              <dt>member since</dt>
              <dd>{member.joinedOn}</dd>
              {membership.renewsOn ? (
                <>
                  <dt>renews on</dt>
                  <dd>{membership.renewsOn}</dd>
                </>
              ) : null}
              {membership.lapsedOn ? (
                <>
                  <dt>lapsed on</dt>
                  <dd>{membership.lapsedOn}</dd>
                </>
              ) : null}
            </dl>
          </>
        ) : (
          <p className="hint">
            You are on the roll, but not enrolled in a tier. The association&apos;s staff can
            enrol you.
          </p>
        )}
      </section>

      {outstanding.length > 0 ? (
        <section className="card">
          <h2>You owe {money(owed)}</h2>
          <table className="roster">
            <tbody>
              {outstanding.map((invoice) => (
                <tr key={invoice.name}>
                  <td>
                    {invoice.periodStart} to {invoice.periodEnd}
                  </td>
                  <td>{money(invoice.amountCents)}</td>
                  <td>due {invoice.dueOn}</td>
                  <td>
                    <InvoiceBadge state={invoice.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Payment is recorded by the association&apos;s treasurer. This page shows what they have
            recorded.
          </p>
        </section>
      ) : null}
    </>
  );
}
