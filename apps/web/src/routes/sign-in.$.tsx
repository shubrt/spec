import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { SignedOutFrame } from "~/components/zpecs/states";

/**
 * The signed-out surface.
 *
 * A splat route rather than a plain `/sign-in`: Clerk's `<SignIn>` owns sub-paths
 * of its own — verification steps, SSO callbacks — and navigates to them itself. A
 * non-splat route would 404 the moment a sign-in needs a second factor.
 *
 * The frame around it is the product's, and the box inside it is Clerk's. That
 * split is the honest one: signing in is a Clerk call, and zpecs stores no session
 * of its own — it reads the organization id off yours and matches it to a workspace
 * row, which the frame says out loud.
 */
export const Route = createFileRoute("/sign-in/$")({ component: SignInPage });

function SignInPage() {
  return (
    <SignedOutFrame>
      <SignIn
        appearance={{
          elements: {
            // The card chrome is the frame's job; Clerk supplies the form.
            rootBox: "w-full",
            cardBox: "shadow-none border-0 w-full",
            card: "shadow-none border-0 px-0 py-0",
            footer: "hidden",
          },
        }}
      />
    </SignedOutFrame>
  );
}
