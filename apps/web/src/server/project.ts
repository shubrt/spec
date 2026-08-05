import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { projectNameInput, validateProjectName } from "~/lib/project";
import { createApiClient } from "./api";

export interface CreateProjectInput {
  readonly name: string;
}

export type CreateProjectResult =
  | {
      readonly ok: true;
      readonly project: { readonly id: string; readonly name: string };
    }
  | {
      readonly ok: false;
      readonly error:
        | "invalid_name"
        | "project_name_taken"
        | "signed_out"
        | "no_workspace"
        | "unavailable";
      readonly message: string;
    };

const UNAVAILABLE = {
  ok: false,
  error: "unavailable",
  message: "The project could not be created. Try again in a moment.",
} as const satisfies CreateProjectResult;

/**
 * Creates a project container in the active Clerk organization.
 *
 * This is the web app's one write. The API still owns tenant scope: this
 * function forwards only the trimmed name and a Clerk session token, never a
 * workspace id supplied by the browser. Epic, stream and task writes continue
 * to go exclusively through MCP change sets.
 */
export const createProject = createServerFn({ method: "POST" })
  // The parameter annotation is the typed client contract. The return value is
  // intentionally unknown-safe so a hand-written request cannot make the
  // handler throw before it returns its `invalid_name` branch.
  .validator((input: CreateProjectInput) => projectNameInput(input))
  .handler(async ({ data }): Promise<CreateProjectResult> => {
    const validated = validateProjectName(data.name);
    if (!validated.ok) {
      return { ok: false, error: "invalid_name", message: validated.message };
    }

    let sessionToken: string | null;
    try {
      const { getToken } = await auth();
      sessionToken = await getToken();
    } catch {
      return UNAVAILABLE;
    }

    if (!sessionToken) {
      return {
        ok: false,
        error: "signed_out",
        message: "Your session has expired. Sign in again to create a project.",
      };
    }

    try {
      const response = await createApiClient(sessionToken).workspace.projects.post({
        name: validated.name,
      });

      if (!response.error) {
        return { ok: true, project: response.data.project };
      }

      switch (response.error.status) {
        case 409:
          if (
            typeof response.error.value === "object" &&
            response.error.value !== null &&
            "error" in response.error.value &&
            response.error.value.error === "project_name_taken"
          ) {
            return {
              ok: false,
              error: "project_name_taken",
              message: "A project with this name already exists in this workspace.",
            };
          }
          return UNAVAILABLE;
        case 422:
          return {
            ok: false,
            error: "invalid_name",
            message: "Enter a project name between 1 and 120 characters.",
          };
        case 401:
          return {
            ok: false,
            error: "signed_out",
            message: "Your session has expired. Sign in again to create a project.",
          };
        case 403:
          return {
            ok: false,
            error: "no_workspace",
            message: "Select an organization before creating a project.",
          };
        default:
          return UNAVAILABLE;
      }
    } catch {
      return UNAVAILABLE;
    }
  });
