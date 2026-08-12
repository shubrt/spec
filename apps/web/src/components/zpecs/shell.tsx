import { useClerk } from "@clerk/tanstack-react-start";
import { Link, useNavigate, useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NAV, activeNavPath, breadcrumb } from "~/lib/navigation";
import { validateProjectName } from "~/lib/project";
import { carry, projectChangedSearch } from "~/lib/search";
import { createProject } from "~/server/project";
import type { ProjectModel } from "~/lib/model";
import { cn } from "~/lib/utils";

// These routes have server-side collection loaders. Loading them on a passing
// pointer hover performs real database work the user may never navigate to.
const EXPLICIT_NAVIGATION_PRELOAD = new Set<string>([
  "/changes",
  "/criteria",
  "/roadmap",
  "/trace",
]);

/**
 * The frame: a sidebar, a context bar, and the switchers in it.
 *
 * Every popover here is Radix-free and plain state. That is not a dependency
 * preference — these are three small disclosures with the same behaviour (close on
 * outside click, close on Escape) and one shared implementation is less code than
 * three configurations of a primitive.
 *
 * The context bar starts with the two things that decide what you are looking at
 * at all — the organization and the Project — and only then the trail. A Project
 * is where keys are minted, so `S-1` means nothing until you know which Project
 * issued it.
 */

function ChevronPair() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="shrink-0 opacity-60"
    >
      <path d="M5 6.5 8 3.5l3 3" />
      <path d="M5 9.5l3 3 3-3" />
    </svg>
  );
}

/** Closes on outside click and on Escape. Escape is captured so it does not also close the Inspector. */
function Popover({
  open,
  onClose,
  align = "left",
  width = 260,
  anchor = "top",
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly align?: "left" | "right";
  readonly width?: number;
  readonly anchor?: "top" | "bottom";
  readonly children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={container}
      role="menu"
      style={{ width }}
      className={cn(
        "border-border-strong bg-popover absolute z-[70] rounded-md border p-1 shadow-[0_6px_24px_rgba(0,0,0,0.12)]",
        anchor === "top" ? "top-[calc(100%+4px)]" : "bottom-[calc(100%+4px)]",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {children}
    </div>
  );
}

function MenuItem({
  onClick,
  active,
  disabled,
  title,
  detail,
  lead,
  children,
}: {
  readonly onClick?: () => void;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly detail?: string;
  readonly lead?: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none",
        disabled ? "text-muted-foreground cursor-default" : "hover:bg-muted focus-visible:bg-muted",
        active ? "bg-accent" : "",
      )}
    >
      {lead ? (
        <span className="w-3 shrink-0 pt-px font-mono text-[11px] leading-none">{lead}</span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {detail ? (
          <span className="text-muted-foreground block truncate text-[11px]">{detail}</span>
        ) : null}
      </span>
      {active ? <span className="font-mono text-[11px]">✓</span> : null}
    </button>
  );
}

function MenuNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-muted-foreground border-border mt-1 border-t px-2 py-1.5 text-[11px] leading-[15px]">
      {children}
    </p>
  );
}

function SwitcherButton({
  label,
  open,
  title,
  onClick,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly title: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="menu"
      aria-expanded={open}
      title={title}
      className={cn(
        "hover:bg-muted focus-visible:ring-ring flex max-w-[210px] items-center gap-1.5 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2",
        open ? "bg-muted" : "",
      )}
    >
      <span className="truncate font-mono text-xs">{label}</span>
      <ChevronPair />
    </button>
  );
}

/* --------------------------------------------------------------- sidebar -- */

function NavBadge({ value }: { readonly value: number }) {
  return <span className="ml-auto font-mono text-xs tabular-nums opacity-70">{value}</span>;
}

export function AppSidebar({
  model,
  actorId,
  onSignOut,
}: {
  readonly model: ProjectModel | null;
  readonly actorId: string | null;
  readonly onSignOut: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNavPath(pathname);

  return (
    <div className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full w-56 flex-none flex-col border-r">
      <div className="border-sidebar-border flex h-12 flex-none items-center border-b px-4">
        <span className="font-mono text-sm font-semibold tracking-tight">zpecs</span>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
        <ul className="flex w-full min-w-0 flex-col">
          {NAV.map((entry, index) => {
            if (entry.kind === "group") {
              return (
                <li key={`group-${String(index)}`} aria-hidden="true">
                  <div className="bg-border my-2 h-px" />
                  {entry.label ? (
                    <div className="text-muted-foreground text-micro flex h-8 shrink-0 items-center px-2 pt-3 font-semibold uppercase tracking-wide">
                      {entry.label}
                    </div>
                  ) : null}
                </li>
              );
            }
            const isActive = active === entry.to;
            // In a Project with nothing in it every badge reads 0 rather than
            // keeping the counts of the Project you just left.
            const count = entry.count
              ? entry.count === "fragmentCount"
                ? (model?.fragmentCount ?? 0)
                : (model?.[entry.count].length ?? 0)
              : null;
            return (
              <li key={entry.to} className="relative">
                <Link
                  to={entry.to}
                  search={carry}
                  preload={EXPLICIT_NAVIGATION_PRELOAD.has(entry.to) ? false : undefined}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "text-ledger flex h-[30px] w-full items-center gap-2 overflow-hidden rounded-sm px-2 text-left outline-none transition-colors",
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2",
                    isActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                      : "",
                  )}
                >
                  <span className="truncate">{entry.label}</span>
                  {count === null ? null : <NavBadge value={count} />}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <UserBlock actorId={actorId} onSignOut={onSignOut} />
    </div>
  );
}

/**
 * Foot of the sidebar.
 *
 * Sign out arms a confirmation first — it drops you out of the product, and a menu
 * item you can hit by accident should not do that. Profile & preferences opens
 * Settings · Account, which is where the identity zpecs actually holds is written
 * down; a profile belongs on a screen rather than in a popover.
 */
function UserBlock({
  actorId,
  onSignOut,
}: {
  readonly actorId: string | null;
  readonly onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div className="border-sidebar-border relative border-t p-2">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setConfirming(false);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none focus-visible:ring-2",
          open ? "bg-muted" : "",
        )}
      >
        <span className="border-border-strong text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]">
          u
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px]">{actorId ?? "—"}</span>
          <span className="text-muted-foreground block text-[10px]">Signed in</span>
        </span>
        <ChevronPair />
      </button>

      <Popover open={open} onClose={close} anchor="bottom" width={208}>
        <Link
          to="/settings"
          search={(previous) => ({ ...carry(previous), tab: "account" as const })}
          onClick={close}
          role="menuitem"
          title="The identity zpecs holds, and what it does not"
          className="hover:bg-muted focus-visible:bg-muted flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs outline-none"
        >
          Profile &amp; preferences
        </Link>

        {confirming ? (
          <div className="px-2 py-1.5">
            <p className="text-ledger">Sign out of zpecs?</p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  close();
                  onSignOut();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-8 items-center rounded-md px-3 text-xs font-medium outline-none focus-visible:ring-2"
              >
                Sign out
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md px-3 text-xs font-medium outline-none focus-visible:ring-2"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <MenuItem title="Ends the Clerk session" onClick={() => setConfirming(true)}>
            Sign out
          </MenuItem>
        )}

        <MenuNote>
          zpecs stores no user row and no session. The actor id on a revision is the only identity
          it has ever recorded; name, email and password live in Clerk.
        </MenuNote>
      </Popover>
    </div>
  );
}

/* ----------------------------------------------------------- context bar -- */

function OrgSwitcher({ orgId }: { readonly orgId: string | null }) {
  const { openOrganizationProfile, openCreateOrganization } = useClerk();
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex">
      <SwitcherButton
        label={orgId ?? "no organization"}
        open={open}
        title="Organization — stored on the workspace row as a Clerk id"
        onClick={() => setOpen(!open)}
      />
      <Popover open={open} onClose={() => setOpen(false)} width={340}>
        <MenuItem active onClick={() => setOpen(false)}>
          {orgId ?? "no organization"}
        </MenuItem>
        <div className="bg-border my-1 h-px" />
        <MenuItem
          onClick={() => {
            setOpen(false);
            openOrganizationProfile();
          }}
        >
          Switch or manage organizations
        </MenuItem>
        <MenuItem
          lead="+"
          onClick={() => {
            setOpen(false);
            openCreateOrganization();
          }}
        >
          Create organization
        </MenuItem>
        <MenuNote>
          zpecs stores one workspace row carrying a Clerk organization id and no display name. The
          readable name and the list you belong to both live in Clerk.
        </MenuNote>
      </Popover>
    </span>
  );
}

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

function ProjectSwitcher({
  projects,
  currentId,
  currentName,
}: {
  readonly projects: readonly ProjectOption[];
  readonly currentId: string | undefined;
  readonly currentName: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const close = () => {
    setOpen(false);
    setCreating(false);
  };

  const switchTo = (projectId: string) => {
    close();
    // Landing on Overview rather than staying put: a detail path carries a key
    // minted by the Project being left, and keys are only unique inside one.
    void navigate({
      to: "/",
      search: (previous) => projectChangedSearch(previous, projectId),
    });
  };

  return (
    <span className="relative inline-flex">
      <SwitcherButton
        label={currentName}
        open={open}
        title="Project — keys are project-scoped, so the Project decides what S-1 means"
        onClick={() => {
          setOpen(!open);
          setCreating(false);
        }}
      />
      <Popover open={open} onClose={close} width={290}>
        {creating ? (
          <CreateProjectForm
            onCancel={() => setCreating(false)}
            onCreated={(projectId) => {
              close();
              switchTo(projectId);
            }}
          />
        ) : (
          <>
            {projects.map((project) => (
              <MenuItem
                key={project.id}
                active={project.id === currentId}
                onClick={() => switchTo(project.id)}
              >
                {project.name}
              </MenuItem>
            ))}
            <div className="bg-border my-1 h-px" />
            <MenuItem lead="+" onClick={() => setCreating(true)}>
              Create project
            </MenuItem>
            <MenuNote>
              A Project has its own key counters: the first Epic in a new one is E-1 again. Creating
              the container is the one write this surface makes — everything inside it enters
              through the MCP server.
            </MenuNote>
          </>
        )}
      </Popover>
    </span>
  );
}

/**
 * The one write this surface makes.
 *
 * A Project is an unversioned container with no document, no readiness gates and no
 * revision history, which is exactly why creating one is safe here and creating
 * anything inside it is not. The name is validated in the browser so a mistake is
 * explained without a round trip, and again on the server, which stays
 * authoritative.
 */
function CreateProjectForm({
  onCancel,
  onCreated,
}: {
  readonly onCancel: () => void;
  readonly onCreated: (projectId: string) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    const validated = validateProjectName(name);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }
    setBusy(true);
    setError(null);
    void createProject({ data: { name: validated.name } })
      .then(async (result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        // The project list lives in the root loader, so it has to be re-read
        // before the switcher can show what was just created.
        await router.invalidate();
        onCreated(result.project.id);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="p-1">
      <label
        htmlFor="new-project-name"
        className="text-muted-foreground mb-1 block px-1 text-[11px]"
      >
        Project name
      </label>
      <input
        id="new-project-name"
        autoFocus
        value={name}
        placeholder="a new project"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        className="border-input focus-visible:ring-ring bg-background h-8 w-full rounded-md border px-2 font-mono text-xs outline-none focus-visible:ring-2"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy || name.trim().length === 0}
          onClick={submit}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-8 items-center rounded-md px-3 text-xs font-medium outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md px-3 text-xs font-medium outline-none focus-visible:ring-2"
        >
          Cancel
        </button>
      </div>
      {error ? <MenuNote>{error}</MenuNote> : null}
    </div>
  );
}

function Crumb({ crumb }: { readonly crumb: import("~/lib/navigation").Crumb }) {
  const search = useSearch({ from: "__root__" });
  if (!crumb.to) return <span className="font-mono text-xs">{crumb.label}</span>;
  return (
    <Link
      to={crumb.to}
      search={carry(search)}
      className="focus-visible:ring-ring hover:text-foreground text-muted-foreground rounded-sm font-mono text-xs underline decoration-transparent underline-offset-2 outline-none transition-colors hover:decoration-current focus-visible:ring-2"
    >
      {crumb.label}
    </Link>
  );
}

export function ContextBar({
  orgId,
  projects,
  currentProjectId,
  currentProjectName,
  onOpenSearch,
}: {
  readonly orgId: string | null;
  readonly projects: readonly ProjectOption[];
  readonly currentProjectId: string | undefined;
  readonly currentProjectName: string;
  readonly onOpenSearch: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const trail = breadcrumb(pathname);

  return (
    <div className="border-border flex h-12 flex-none items-center gap-1.5 border-b px-4">
      <OrgSwitcher orgId={orgId} />
      <span className="text-border">/</span>
      <ProjectSwitcher
        projects={projects}
        currentId={currentProjectId}
        currentName={currentProjectName}
      />
      {trail.map((crumb) => (
        <span key={crumb.label} className="flex items-center gap-1.5">
          <span className="text-border">/</span>
          <span className="px-0.5">
            <Crumb crumb={crumb} />
          </span>
        </span>
      ))}

      <button
        type="button"
        onClick={onOpenSearch}
        className="text-muted-foreground border-input hover:bg-muted focus-visible:ring-ring ml-auto flex min-w-[200px] items-center gap-2 rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-2"
      >
        <span>Search</span>
        <span className="border-input ml-auto rounded-sm border px-1 font-mono text-[11px]">
          ⌘K
        </span>
      </button>
    </div>
  );
}
