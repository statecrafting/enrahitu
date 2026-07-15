import { Form, useLoaderData } from "react-router";

import KvDemo from "../components/KvDemo";
import type { Me } from "../lib/api";

// Profile (spec 015 §3): renders GET /api/v1/auth/me, the logout action, and
// the hiqlite cache demo widget. The loader redirects to /login when there is
// no session, so `me` is always present here.
export default function Profile() {
  const me = useLoaderData() as Me;
  return (
    <section className="card">
      <h2>Signed in</h2>
      <dl>
        <dt>name</dt>
        <dd>{me.name}</dd>
        <dt>email</dt>
        <dd>{me.email}</dd>
        <dt>roles</dt>
        <dd>{me.roles.join(", ")}</dd>
        <dt>provider</dt>
        <dd>{me.ssoProvider}</dd>
        <dt>last login</dt>
        <dd>{me.lastLoginAt ?? "n/a"}</dd>
      </dl>
      <Form method="post" action="/logout">
        <button className="button" type="submit">
          Sign out
        </button>
      </Form>

      <h3>hiqlite cache demo</h3>
      <KvDemo />
    </section>
  );
}
