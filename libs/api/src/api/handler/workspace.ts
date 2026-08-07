import Elysia from "elysia";
import { z } from "zod";
import { projectNameSchema } from "../../domain/projectName";
import { workspaceRepository } from "../../domain/repository/workspace";
import { authScope } from "../plugin/authScope";

/**
 * The authenticated Elysia route surface the web UI calls in-process.
 *
 * Epic, stream and task writes still go exclusively through an MCP change-set,
 * which owns document validation, readiness, revision history and destructive
 * confirmation. `POST /workspace/projects` is the one narrow exception: a
 * project is an unversioned container with none of those fields, and the session
 * scope is its only tenant input. It cannot write a planning entity.
 *
 * Three properties hold for every route in this file and are the reason it is
 * safe to make available to server functions:
 *
 *  - the only tenant key is `scope`, produced by `authScope` from a verified
 *    session — no route accepts a workspace id, a project id's owner, or any
 *    other tenant hint from the request;
 *  - every data access is a `workspaceRepository` call taking that `scope` as its
 *    first argument, so the tenant filter is the repository's business and this
 *    file never assembles one;
 *  - responses are mapped through an explicit Zod v4 DTO rather than returned as
 *    rows. That keeps `clerkOrgId` (an auth-provider identifier that has no place
 *    in a UI payload) off the wire, keeps `Date` columns from silently becoming
 *    whatever `JSON.stringify` felt like, and gives Eden Treaty a response type
 *    precise enough that a field rename breaks the consumer's build.
 */

/** The signed-in user's own workspace. `id` is zpecs' uuid, never the Clerk org id. */
const WorkspaceDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string().nullable(),
});

/**
 * Enough of a project for the UI to list it and open it. The key counters on the
 * row are the change-set engine's bookkeeping and are deliberately not exposed.
 */
const ProjectDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
});

/**
 * Wrapped in an object rather than returned as a bare array: a top-level array
 * has nowhere to put the next field this endpoint needs (a cursor, a count) other
 * than a breaking change.
 */
const ProjectListDto = z.strictObject({
  projects: z.array(ProjectDto),
});

/** The only accepted project-create input. Unknown keys are a 422. */
const CreateProjectBody = z.strictObject({ name: projectNameSchema });

const CreatedProjectDto = z.strictObject({ project: ProjectDto });

const ProjectNameTakenDto = z.strictObject({
  error: z.literal("project_name_taken"),
});

const WorkspaceNotFoundDto = z.strictObject({
  error: z.literal("workspace_not_found"),
  message: z.string(),
});

export const workspaceHandler = new Elysia({ prefix: "/workspace" })
  .use(authScope)
  .get(
    "/",
    async ({ scope, status }) => {
      const row = await workspaceRepository.find(scope);
      // The scope came from a verified session, so the row existed moments ago.
      // Reachable only if the workspace was deleted mid-session — a 404 rather
      // than a 500 because the correct client reaction is "stop and re-resolve
      // your identity", not "retry".
      if (!row) {
        return status(404, {
          error: "workspace_not_found" as const,
          message: "This session's workspace no longer exists. Sign out and sign in again.",
        });
      }
      return { id: row.id, name: row.name, slug: row.slug };
    },
    { response: { 200: WorkspaceDto, 404: WorkspaceNotFoundDto } },
  )
  .get(
    "/projects",
    async ({ scope }) => {
      const projects = await workspaceRepository.listProjects(scope);
      return { projects: projects.map((row) => ({ id: row.id, name: row.name })) };
    },
    { response: { 200: ProjectListDto } },
  )
  .post(
    "/projects",
    async ({ scope, body, status }) => {
      const result = await workspaceRepository.ensureProject(scope, body.name);
      if (result.status === "existing") {
        return status(409, { error: "project_name_taken" as const });
      }

      return status(201, {
        project: { id: result.project.id, name: result.project.name },
      });
    },
    {
      body: CreateProjectBody,
      response: { 201: CreatedProjectDto, 409: ProjectNameTakenDto },
    },
  );
