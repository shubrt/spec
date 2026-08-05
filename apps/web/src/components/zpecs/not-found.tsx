import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-16 text-center">
      <div className="text-5xl font-bold tracking-tight">404</div>
      <p className="text-sm text-muted-foreground">This page doesn’t exist.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}
