import { createBrowserRouter, redirect } from "react-router";

import { fetchMe, fetchStatus, logout, type AuthStatus, type Me } from "./lib/api";
import Landing from "./routes/Landing";
import Login from "./routes/Login";
import Profile from "./routes/Profile";
import Root from "./routes/Root";

// SPA / data-router mode (spec 015 §3): createBrowserRouter, no SSR and no
// framework-mode server bundle. Loaders drive auth state off the same endpoints
// the Vue flavor calls; the server keeps serving static files from
// backend/web/dist. The unauthenticated /profile visit throws a redirect to
// /login, mirroring the Vue app's inline gate.
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
      {
        index: true,
        loader: (): Promise<AuthStatus> => fetchStatus(),
        element: <Landing />,
      },
      {
        path: "login",
        loader: (): Promise<AuthStatus> => fetchStatus(),
        element: <Login />,
      },
      {
        path: "profile",
        loader: async (): Promise<Me> => {
          const me = await fetchMe();
          if (!me) throw redirect("/login");
          return me;
        },
        element: <Profile />,
      },
      {
        // Action-only route: the profile's logout Form posts here, we drop the
        // session (CSRF handled inside api.logout), then bounce home.
        path: "logout",
        action: async () => {
          await logout();
          return redirect("/");
        },
      },
    ],
  },
]);
