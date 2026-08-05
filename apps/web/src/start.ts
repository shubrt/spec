import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createStart } from "@tanstack/react-start";
import { env } from "~/lib/env";

// TanStack Start picks this file up automatically. `auth()` reads the auth
// object out of the global start context, which only exists once
// clerkMiddleware() has run — without this registration every server function
// that calls auth() throws "clerkMiddleware not configured".
//
// secretKey is passed explicitly rather than left to Clerk's own process.env
// lookup so the validated value in ~/lib/env is the single source, and
// signInUrl points Clerk's own redirects at this app's sign-in route instead of
// Clerk's hosted page.
export const startInstance = createStart(() => ({
  // `createStart` asks for these options during client hydration too. Reading a
  // server env property in that pass is intentionally rejected by `@t3-oss/env`,
  // so construct the request middleware only in the server runtime. The browser
  // neither needs the middleware nor receives the secret.
  requestMiddleware:
    typeof window === "undefined"
      ? [
          clerkMiddleware({
            secretKey: env.CLERK_SECRET_KEY,
            signInUrl: "/sign-in",
          }),
        ]
      : [],
}));
