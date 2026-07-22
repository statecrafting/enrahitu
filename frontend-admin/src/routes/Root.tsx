import { NavLink, Outlet } from "react-router";

const navItems = [
  { to: "/", label: "Overview", end: true },
  { to: "/catalog", label: "Catalog", end: false },
  { to: "/traces", label: "Traces", end: false },
];

// The shell: a compact left nav plus the active route. No logo, no wordmark
// (spec 023 §3.5): the app name renders as plain text.
export default function Root() {
  return (
    <div className="flex h-screen bg-bg text-text">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <span className="text-sm font-semibold tracking-wide">Operator console</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
