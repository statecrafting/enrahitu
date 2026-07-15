import { useLoaderData } from "react-router";

import type { AuthStatus } from "../lib/api";

// Driver choice (spec 015 §3): the mock and rauthy links are plain anchors,
// not client navigations. The backend login endpoints redirect and mint the
// httpOnly session cookies server-side, exactly as the Vue flavor does; the
// browser lands back on / afterwards.
export default function Login() {
  const { drivers } = useLoaderData() as AuthStatus;
  return (
    <section className="card">
      <h2>Sign in</h2>
      <ul className="drivers">
        {drivers.includes("mock") && (
          <li>
            <a className="button" href="/api/v1/auth/mock/login?user=0">
              Mock: Casey User
            </a>
            <a className="button" href="/api/v1/auth/mock/login?user=1">
              Mock: Avery Admin
            </a>
          </li>
        )}
        {drivers.includes("rauthy") && (
          <li>
            <a className="button primary" href="/api/v1/auth/rauthy/login">
              Sign in with rauthy
            </a>
          </li>
        )}
      </ul>
      <p className="hint">drivers configured: {drivers.join(", ") || "none"}</p>
    </section>
  );
}
