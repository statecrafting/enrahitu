import { NavLink, Outlet } from "react-router";

// The shell: title, tagline, and the route crumbs, then the active route via
// Outlet. Matches the Vue flavor's <main class="shell"> header (spec 015 §3).
//
// The tagline names the product rather than the stack. It used to read
// "Encore.ts + rauthy + hiqlite (+ Turso), one container", which was the
// pre-pivot description of a substrate: Turso is benched (spec 001 §4.7) and
// what this is, to the association running it, is membership software.
export default function Root() {
  return (
    <main className="shell">
      <h1>enrahitu</h1>
      <p className="tagline">
        Membership and association management. One container, one volume, your own identity
        provider.
      </p>
      <nav className="crumbs">
        <NavLink to="/" end>
          home
        </NavLink>
        <NavLink to="/members">members</NavLink>
        <NavLink to="/dues">dues</NavLink>
        <NavLink to="/my-membership">my membership</NavLink>
        <NavLink to="/profile">profile</NavLink>
      </nav>
      <Outlet />
    </main>
  );
}
