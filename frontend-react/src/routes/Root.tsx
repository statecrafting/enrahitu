import { NavLink, Outlet } from "react-router";

// The shell: title, tagline, and the route crumbs, then the active route via
// Outlet. Matches the Vue flavor's <main class="shell"> header (spec 015 §3).
export default function Root() {
  return (
    <main className="shell">
      <h1>enrahitu</h1>
      <p className="tagline">Encore.ts + rauthy + hiqlite (+ Turso), one container.</p>
      <nav className="crumbs">
        <NavLink to="/" end>
          home
        </NavLink>
        <NavLink to="/login">login</NavLink>
        <NavLink to="/profile">profile</NavLink>
      </nav>
      <Outlet />
    </main>
  );
}
