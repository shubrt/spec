import { OrganizationSwitcher } from "@clerk/tanstack-react-start";
import { workspaceChangedUrl } from "~/lib/search";

// In zpecs the active Clerk organization *is* the workspace: the session token
// carries org_id and the API scopes every read by it. So this switcher is not a
// convenience — it is the only control that changes which tenant the app can see
// or create a project container in.
//
// hidePersonal because a personal account carries no org_id, and the API
// answers that state with 403 no_workspace. Offering it would let a user select
// a workspace that cannot exist.
export function WorkspaceSwitcher() {
  return (
    <OrganizationSwitcher
      hidePersonal
      afterCreateOrganizationUrl={(organization) => workspaceChangedUrl(organization.id)}
      afterSelectOrganizationUrl={(organization) => workspaceChangedUrl(organization.id)}
    />
  );
}
