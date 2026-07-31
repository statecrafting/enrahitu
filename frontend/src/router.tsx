import { createBrowserRouter, redirect } from "react-router";

import { fetchMe, fetchStatus, logout, type AuthStatus, type Me } from "./lib/api";
import {
  fetchDues,
  fetchMember,
  fetchMembers,
  fetchMyMembership,
  fetchOrg,
  fetchTiers,
  isFailure,
  putMember,
  putMembership,
  recordPayment,
  voidInvoice,
} from "./lib/members";
import Dues from "./routes/Dues";
import Landing from "./routes/Landing";
import Login from "./routes/Login";
import MemberDetail, { type MemberDetailData } from "./routes/MemberDetail";
import Members, { type MembersData } from "./routes/Members";
import MyMembership from "./routes/MyMembership";
import Profile from "./routes/Profile";
import Root from "./routes/Root";

// SPA / data-router mode (spec 015 §3): createBrowserRouter, no SSR and no
// framework-mode server bundle. Loaders drive auth state off the same endpoints
// the Vue flavor calls; the server keeps serving static files from
// backend/web/dist. The unauthenticated /profile visit throws a redirect to
// /login, mirroring the Vue app's inline gate.
//
// The membership routes (spec 036) do NOT redirect on refusal. Their loaders
// return the failure and the screen renders a sentence, because "you are not
// one of the association's staff" and "this deployment has not applied its
// schema yet" are different answers and bouncing both to /login would tell a
// signed-in operator that they are signed out.
/**
 * The backdate field, or nothing at all.
 *
 * An untouched `<input type="date">` submits an empty string, and forwarding
 * that would send `?paidOn=` and earn a 400 for the ordinary "paid today" case.
 * Absent means today, and the server decides which day that is.
 */
function paidOnFrom(form: FormData): string | undefined {
  const value = String(form.get("paidOn") ?? "").trim();
  return value === "" ? undefined : value;
}

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
        path: "members",
        loader: async (): Promise<MembersData> => {
          const [roster, org] = await Promise.all([fetchMembers(), fetchOrg()]);
          return { roster, org };
        },
        action: async ({ request }) => {
          const form = await request.formData();
          const name = String(form.get("name") ?? "").trim();
          const result = await putMember(name, {
            displayName: String(form.get("displayName") ?? ""),
            email: String(form.get("email") ?? ""),
            joinedOn: String(form.get("joinedOn") ?? ""),
          });
          if (isFailure(result)) return result;
          return redirect(`/members/${encodeURIComponent(name)}`);
        },
        element: <Members />,
      },
      {
        path: "members/:name",
        loader: async ({ params }): Promise<MemberDetailData> => {
          const [detail, tiers] = await Promise.all([
            fetchMember(params.name ?? ""),
            fetchTiers(),
          ]);
          return { detail, tiers };
        },
        action: async ({ params, request }) => {
          const form = await request.formData();
          const member = params.name ?? "";
          if (form.get("intent") === "enroll") {
            const tier = String(form.get("tier") ?? "");
            const endsOn = String(form.get("endsOn") ?? "");
            const result = await putMembership(`${member}-${tier}`, {
              member,
              tier,
              startsOn: String(form.get("startsOn") ?? ""),
              autoRenew: form.get("autoRenew") === "on",
              ...(endsOn ? { endsOn } : {}),
            });
            return isFailure(result) ? result : null;
          }
          const result = await recordPayment(
            String(form.get("invoice") ?? ""),
            paidOnFrom(form),
          );
          return isFailure(result) ? result : null;
        },
        element: <MemberDetail />,
      },
      {
        path: "dues",
        loader: () => fetchDues(),
        action: async ({ request }) => {
          const form = await request.formData();
          const invoice = String(form.get("invoice") ?? "");
          const result =
            form.get("intent") === "void"
              ? await voidInvoice(invoice)
              : await recordPayment(invoice, paidOnFrom(form));
          return isFailure(result) ? result : null;
        },
        element: <Dues />,
      },
      {
        path: "my-membership",
        loader: () => fetchMyMembership(),
        element: <MyMembership />,
      },
      {
        // Action-only route: the profile's logout Form posts here, we drop the
        // session (CSRF handled inside api.logout), then follow the server's
        // redirectUrl (spec 005 RP-initiated logout). A document navigation,
        // not a router redirect: the end-session URL lives outside the SPA's
        // route table.
        path: "logout",
        action: async () => {
          const { redirectUrl } = await logout();
          window.location.assign(redirectUrl);
          return null;
        },
      },
    ],
  },
], {
  // Under a project Pages base (/<repo>/), the data router must know its mount
  // point or client navigation escapes the subpath. import.meta.env.BASE_URL is
  // "/" for the container and dev builds, "/<repo>/" for a Pages build (spec 013).
  basename: import.meta.env.BASE_URL,
});
