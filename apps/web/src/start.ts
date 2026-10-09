import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
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
//
// Supplying request middleware replaces TanStack Start's default list, which
// is where its CSRF check lives, so it is registered again here. Server
// functions answer only same-origin requests; deleting a Project is one of them.
export const startInstance = createStart(() => ({
  // `createStart` asks for these options during client hydration too. Reading a
  // server env property in that pass is intentionally rejected by `@t3-oss/env`,
  // so construct the request middleware only in the server runtime. The browser
  // neither needs the middleware nor receives the secret.
  requestMiddleware:
    typeof window === "undefined"
      ? [
          createCsrfMiddleware({
            filter: (ctx) => ctx.handlerType === "serverFn",
            // Only consulted without Sec-Fetch-Site. Behind the TLS-terminating
            // proxy the request URL is http://, so compare with the public origin.
            origin: env.SPEC_PUBLIC_URL,
          }),
          clerkMiddleware({
            secretKey: env.CLERK_SECRET_KEY,
            signInUrl: "/sign-in",
          }),
        ]
      : [],
}));
