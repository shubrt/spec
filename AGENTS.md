# Agent notes

Applies to every agent working in this repository (Claude Code, Codex, ...).
`README.md` has the project layout and setup, this file only holds what an
agent must do differently from a human.

## Preview URL after every change to apps/web

The dev server runs through portless, so each git worktree gets its own stable
URL derived from the branch name: `https://<branch-suffix>.spec.localhost`
(main checkout: `https://spec.localhost`). `SPEC_PUBLIC_URL` follows that URL
automatically, so the MCP endpoint is `<url>/mcp`.

1. Check whether this worktree's server is already up: the URL from
   `portless get spec` (run inside the repo) appears in `portless list`.
2. If not, start `vp run dev` as a background process owned by your session.
   Do not detach it (no `nohup`, no `setsid`), the session must stay its parent.
3. Wait until the URL answers, then put it as the last line of your final
   message so the user can click it.
4. Never stop the server yourself. It dies with the session, and portless then
   removes the route. Starting it again in the same worktree replaces the old
   instance, so there is never more than one server per worktree.

`PORTLESS=0 vp run dev` bypasses the proxy and serves plain http://localhost:3005
with `SPEC_PUBLIC_URL` from `.env`.
