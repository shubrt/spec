import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

// A splat route, not a plain "/sign-in": Clerk's <SignIn> owns sub-paths of its
// own (verification steps, SSO callbacks) and navigates to them itself. A
// non-splat route would 404 the moment a sign-in needs a second factor.
export const Route = createFileRoute("/sign-in/$")({
  component: SignInPage,
});

function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <SignIn />
    </div>
  );
}
