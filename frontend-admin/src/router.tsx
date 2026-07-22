import { createBrowserRouter, useRouteError } from "react-router";

import { ApiError, fetchCatalog, fetchOverview, fetchTraces } from "./lib/api";
import Catalog from "./routes/Catalog";
import Overview from "./routes/Overview";
import Root from "./routes/Root";
import Traces from "./routes/Traces";

// Loader errors bubble to the nearest ancestor errorElement; one boundary at
// the layout route covers all three pages (spec 023 §3.2: 403 means no
// operator role, distinct from the 401 redirect api.ts already performs).
function RouteError() {
  const error = useRouteError();

  if (error instanceof ApiError && error.status === 403) {
    return (
      <div className="mx-auto max-w-lg p-10">
        <h1 className="text-lg font-semibold text-text">Operator role required</h1>
        <p className="mt-3 text-sm text-muted">
          This session does not hold the role this dashboard requires. The required role name is
          recorded in the app model at <code className="font-mono text-text">auth.operatorRole</code>;
          ask an administrator to grant it.
        </p>
      </div>
    );
  }

  const message =
    error instanceof ApiError
      ? `${error.status}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "unknown error";

  return (
    <div className="mx-auto max-w-lg p-10">
      <h1 className="text-lg font-semibold text-error">Something went wrong</h1>
      <p className="mt-3 text-sm text-muted">{message}</p>
    </div>
  );
}

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <Root />,
      errorElement: <RouteError />,
      children: [
        { index: true, loader: () => fetchOverview(), element: <Overview /> },
        { path: "catalog", loader: () => fetchCatalog(), element: <Catalog /> },
        { path: "traces", loader: () => fetchTraces(50), element: <Traces /> },
      ],
    },
  ],
  {
    // Serves under /admin (spec 023, vite.config.ts base "/admin/"); the
    // basename must agree with it or client navigation escapes the mount.
    basename: import.meta.env.BASE_URL,
  },
);
