import { OrganizationSwitcher } from "@clerk/tanstack-react-start";

// In zpecs the active Clerk organization *is* the workspace: the session token
// carries org_id and the API scopes every read by it. So this switcher is not a
// convenience — it is the only control in this read-only UI that changes which
// data the app can see at all.
//
// hidePersonal because a personal account carries no org_id, and the API
// answers that state with 403 no_workspace. Offering it would let a user select
// a workspace that cannot exist.
export function WorkspaceSwitcher() {
  return <OrganizationSwitcher hidePersonal />;
}
