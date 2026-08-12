# Repository Instructions

## Scope and precedence

- These instructions apply to the entire repository.
- System instructions and explicit user instructions take precedence over this file.
- `AGENTS.md` is the canonical source of repository instructions. Client-specific files may only import or point to it; do not duplicate its contents.
- A nested `AGENTS.md` may refine instructions only for its own subtree.
- Do not write to external databases, MCP services, project-management systems, or paid APIs unless the user explicitly asks for that action.

## Test policy

This repository intentionally has no automated test suite. Do not create, restore, or run tests, test snapshots, test-only fixtures, test runner configuration, or test-only dependencies unless the user explicitly requests tests in the current task. Requests to implement, fix, validate, verify, review, or build do not count as an explicit request for tests.

- Normally verify work with static checks, schema drift checks, builds, and focused offline benchmarks.

## Plans

When a task calls for a written plan, publish it via [postplan.dev](https://postplan.dev) — but only if it is available and authenticated locally. Check with `npx postplan whoami`; a configured account (credentials live in `~/.postplan/credentials.json`) means use it. If that check fails, write the plan into the conversation instead and do not attempt to authenticate.

- Write the plan as a self-contained static HTML file, then upload it:
  `npx postplan upload ./plan.html`
- Report the returned URL back to the user as the plan.
- Use `--draft <draft-id>` to update an existing plan rather than creating a duplicate; `--new` forces a fresh draft.
- If you are missing information or context needed for the plan, ask before uploading. A plan built on guesses is worse than a question.

## A note from the author

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
- If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong - fix the code.
