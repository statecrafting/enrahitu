import { Link, useLoaderData } from "react-router";

import type { AuthStatus } from "../lib/api";

// Landing with login state (spec 015 §3): reads the auth status loader and
// points the visitor at /login or /profile accordingly.
export default function Landing() {
  const status = useLoaderData() as AuthStatus;
  return (
    <section className="card">
      {status.authenticated ? (
        <>
          <h2>Signed in</h2>
          <p className="hint">Your session is active.</p>
          <Link className="button" to="/profile">
            View profile
          </Link>
        </>
      ) : (
        <>
          <h2>Welcome</h2>
          <p className="hint">You are not signed in.</p>
          <Link className="button primary" to="/login">
            Sign in
          </Link>
        </>
      )}
      <p className="hint">drivers configured: {status.drivers.join(", ") || "none"}</p>
    </section>
  );
}
