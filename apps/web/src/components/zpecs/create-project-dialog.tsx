import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { validateProjectName } from "~/lib/project";
import { projectChangedSearch } from "~/lib/search";
import { createProject } from "~/server/project";

interface CreateProjectDialogProps {
  readonly trigger: ReactElement;
  readonly workspaceName: string;
}

/** A single, reusable project-create flow for the header and empty state. */
export function CreateProjectDialog({ trigger, workspaceName }: CreateProjectDialogProps) {
  const navigate = useNavigate();
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const pendingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // React state is not synchronous, so the ref closes the tiny window in
    // which two Enter presses or clicks could otherwise send two requests.
    if (pendingRef.current) return;

    const validated = validateProjectName(name);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setError(undefined);

    let result;
    try {
      result = await createProject({ data: { name: validated.name } });
    } catch {
      setError("The project could not be created. Try again in a moment.");
      pendingRef.current = false;
      setPending(false);
      return;
    }
    if (!result.ok) {
      setError(result.message);
      pendingRef.current = false;
      setPending(false);
      return;
    }

    setOpen(false);
    try {
      await navigate({
        to: "/",
        search: (previous) => projectChangedSearch(previous, result.project.id),
      });
    } finally {
      // The root header survives route navigation, so make the successful dialog
      // pristine for the next project rather than leaving its trigger disabled.
      setName("");
      setError(undefined);
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Create an empty project in {workspaceName}. You can add epics, streams and tasks through
            MCP afterwards.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate>
          <div className="grid gap-2">
            <label htmlFor={fieldId} className="text-sm font-medium">
              Name
            </label>
            <Input
              id={fieldId}
              autoFocus
              autoComplete="off"
              value={name}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
              {pending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
