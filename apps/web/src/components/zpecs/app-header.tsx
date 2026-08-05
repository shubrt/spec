import { Link, useLoaderData, useNavigate } from "@tanstack/react-router";
import { WorkspaceSwitcher } from "~/components/zpecs/workspace-switcher";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

/**
 * The one chrome element: brand, project picker, navigation, workspace switcher.
 *
 * It replaces the inline `<header>` λ left in `__root.tsx`, which existed so the
 * organization switcher had somewhere to live. Three pages and a project picker
 * is past what belongs inline, and λ's note anticipated the lift.
 */

const NAV = [
  { to: "/", label: "Overview", exact: true },
  { to: "/epics", label: "Epics", exact: false },
  { to: "/connection", label: "Connection", exact: false },
] as const;

export function AppHeader() {
  const board = useLoaderData({ from: "__root__" });
  const navigate = useNavigate();

  // Switching project resets any open drawer: the epic, stream or task in the URL
  // belongs to the project being navigated away from.
  const switchProject = (projectId: string) => {
    void navigate({ to: ".", search: { project: projectId } });
  };

  const projects = board.status === "ok" ? board.projects : [];
  const selectedId = board.status === "ok" ? board.aggregate?.project.id : undefined;

  return (
    <header className="flex h-14 flex-none items-center gap-4 border-b px-4">
      <span className="flex items-center gap-2 text-base font-bold tracking-tight">
        <span className="flex size-[26px] items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          z
        </span>
        zpecs
      </span>

      {/* A picker for one project would only be a control that cannot change
          anything, so it appears from two upwards. */}
      {projects.length > 1 && selectedId ? (
        <Select value={selectedId} onValueChange={switchProject}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <nav className="flex items-center gap-1">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            // `project` is carried across every navigation and the drawer
            // parameters are not: which project you are looking at survives a
            // page change, an open detail view does not.
            search={(prev) => ({ project: prev.project })}
            activeOptions={{ exact: item.exact }}
            className="rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary [&.active]:bg-secondary [&.active]:font-semibold [&.active]:text-foreground"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="flex-1" />
      <WorkspaceSwitcher />
    </header>
  );
}
