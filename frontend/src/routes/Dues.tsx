import { Form, Link, useActionData, useLoaderData } from "react-router";

import { InvoiceBadge, Refusal } from "../components";
import {
  isFailure,
  money,
  todayUtc,
  type Failure,
  type InvoiceView,
  type Result,
} from "../lib/members";

/**
 * Every invoice the renewal controller has raised (spec 036 §3.8).
 *
 * Nothing on this page creates an invoice, because nothing should: dues are
 * derived from a membership and a tier, and the controller raises them on the
 * day the term ends. A page that could also raise one by hand would be a second
 * source of truth for what a member owes.
 */
export default function Dues() {
  const result = useLoaderData() as Result<{ invoices: InvoiceView[] }>;
  const problem = useActionData() as Failure | undefined;

  if (isFailure(result)) return <Refusal failure={result} />;

  const open = result.invoices.filter((i) => i.state === "open");
  const settled = result.invoices.filter((i) => i.state !== "open");
  const owed = open.reduce((sum, i) => sum + i.amountCents, 0);

  return (
    <>
      <section className="card">
        <h2>Outstanding dues</h2>
        {problem ? <p className="error">{problem.message}</p> : null}
        {open.length === 0 ? (
          <p className="hint">Nothing outstanding.</p>
        ) : (
          <>
            <p className="hint">
              {open.length} invoice{open.length === 1 ? "" : "s"}, {money(owed)} in total.
            </p>
            <table className="roster">
              <thead>
                <tr>
                  <th>member</th>
                  <th>amount</th>
                  <th>due</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.map((invoice) => (
                  <tr key={invoice.name}>
                    <td>
                      <Link to={`/members/${encodeURIComponent(invoice.member)}`}>
                        {invoice.member}
                      </Link>
                      <div className="hint">{invoice.tier}</div>
                    </td>
                    <td>{money(invoice.amountCents)}</td>
                    <td>{invoice.dueOn}</td>
                    <td>
                      <Form method="post">
                        <input type="hidden" name="invoice" value={invoice.name} />
                        {/* Empty means today. A treasurer entering a cheque that
                            arrived last week sets the day it arrived; the server
                            refuses a future one. */}
                        <input
                          type="date"
                          name="paidOn"
                          max={todayUtc()}
                          aria-label={`payment date for ${invoice.member}`}
                        />
                        <button className="button primary" name="intent" value="pay" type="submit">
                          Record payment
                        </button>
                        <button className="button" name="intent" value="void" type="submit">
                          Void
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {settled.length > 0 ? (
        <section className="card">
          <h2>Settled</h2>
          <table className="roster">
            <tbody>
              {settled.map((invoice) => (
                <tr key={invoice.name}>
                  <td>{invoice.member}</td>
                  <td>{money(invoice.amountCents)}</td>
                  <td>
                    <InvoiceBadge state={invoice.state} />
                  </td>
                  <td className="hint">{invoice.paidOn ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
