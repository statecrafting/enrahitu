import { Form, Link, useActionData, useLoaderData } from "react-router";

import { Refusal, StateBadge } from "../components";
import {
  isFailure,
  type Failure,
  type MemberRow,
  type OrgView,
  type Result,
} from "../lib/members";

export interface MembersData {
  roster: Result<{ members: MemberRow[] }>;
  org: Result<OrgView>;
}

/**
 * The roster (spec 036 §3.8, operator plane).
 *
 * Membership state is the controller's finding rather than anything this page
 * computes: the SPA renders what reconciliation observed, which is the whole
 * reason the state is a stored status and not a date comparison in the view.
 */
export default function Members() {
  const { roster, org } = useLoaderData() as MembersData;
  const problem = useActionData() as Failure | undefined;

  if (isFailure(roster)) return <Refusal failure={roster} />;

  const name = isFailure(org) ? "This association" : org.displayName;

  return (
    <>
      <section className="card">
        <h2>{name}</h2>
        <p className="hint">
          {roster.members.length} member{roster.members.length === 1 ? "" : "s"} on the roll.
        </p>
        {roster.members.length === 0 ? (
          <p className="hint">No members yet. Add the first one below.</p>
        ) : (
          <table className="roster">
            <thead>
              <tr>
                <th>member</th>
                <th>tier</th>
                <th>standing</th>
                <th>renews</th>
              </tr>
            </thead>
            <tbody>
              {roster.members.map(({ member, membership }) => (
                <tr key={member.name}>
                  <td>
                    <Link to={`/members/${encodeURIComponent(member.name)}`}>
                      {member.displayName}
                    </Link>
                    <div className="hint">{member.email}</div>
                  </td>
                  <td>{membership?.tier ?? <span className="hint">none</span>}</td>
                  <td>
                    {membership ? (
                      <StateBadge state={membership.state} />
                    ) : (
                      <span className="hint">not enrolled</span>
                    )}
                  </td>
                  <td>{membership?.renewsOn ?? membership?.lapsedOn ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Add a member</h2>
        {problem ? <p className="error">{problem.message}</p> : null}
        <Form method="post" className="stack">
          <label>
            handle
            <input name="name" required placeholder="ada-lovelace" pattern="[a-z0-9][a-z0-9-]*" />
          </label>
          <p className="hint">
            The permanent handle for this member. Reusing an existing handle updates that member
            rather than adding a new one.
          </p>
          <label>
            full name
            <input name="displayName" required placeholder="Ada Lovelace" />
          </label>
          <label>
            email
            <input name="email" type="email" required placeholder="ada@example.org" />
          </label>
          <label>
            joined on
            <input name="joinedOn" type="date" required />
          </label>
          <button className="button primary" type="submit">
            Add member
          </button>
        </Form>
      </section>
    </>
  );
}
