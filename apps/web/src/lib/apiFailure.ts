/**
 * The three ways a read can fail that the UI has to say something different
 * about. Everything else collapses into `unavailable`, because the user's next
 * action is the same for all of it: wait, or tell someone.
 *
 * Pure and free of any server import on purpose — the loader classifies a
 * failure here, and the components that render it are client code.
 */
export interface ApiFailure {
  readonly status: "signed_out" | "no_workspace" | "unavailable";
  readonly message: string;
  /** Whether an HTTP response, as opposed to a transport failure, was observed. */
  readonly apiReachable: boolean;
}

function messageFrom(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null) {
    const body = value as Record<string, unknown>;
    // The 403/500 bodies carry `message`; the 401 body carries `reason`.
    if (typeof body.message === "string") return body.message;
    if (typeof body.reason === "string") return body.reason;
  }
  return fallback;
}

/**
 * Maps Eden's error side onto {@link ApiFailure}.
 *
 * Eden returns HTTP errors in `error` instead of throwing, as a union
 * discriminated on `status`. Only 401 and 403 are given their own meaning, and
 * the split matters: 401 means there is no usable session, 403 means the
 * session is fine but carries no organization — so the remedy is "sign in"
 * versus "create or join a workspace". Treating 403 as a crash would tell a
 * perfectly valid user that the app is broken.
 */
export function toApiFailure(
  error: { status: number; value: unknown } | null | undefined,
): ApiFailure {
  if (!error) {
    return {
      status: "unavailable",
      message: "The zpecs API did not answer.",
      apiReachable: false,
    };
  }

  switch (error.status) {
    case 401:
      return {
        status: "signed_out",
        message: messageFrom(error.value, "Your session has expired."),
        apiReachable: true,
      };
    case 403:
      return {
        status: "no_workspace",
        message: messageFrom(error.value, "This session has no workspace."),
        apiReachable: true,
      };
    default:
      return {
        status: "unavailable",
        message: messageFrom(error.value, `The zpecs API answered ${String(error.status)}.`),
        apiReachable: true,
      };
  }
}
