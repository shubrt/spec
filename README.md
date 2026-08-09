<div align="center">

  <h1>zpecs</h1>

  <p>
    Keeps project context structured and gives coding agents one safe MCP
    interface for reading plans and applying reviewed changes.
  </p>

  <h4>
    <a href="./docs/zpecs-kontext.md">Project context</a>
    <span> · </span>
    <a href="./libs/api/src/integration/clerk/SETUP.md">MCP setup</a>
    <span> · </span>
    <a href="https://github.com/shubrt/zpecs/issues/">Bug</a>
    <span> · </span>
    <a href="https://github.com/shubrt/zpecs/issues/">Feature</a>
  </h4>
</div>

<br />

<!-- Table of Contents -->

# :notebook_with_decorative_cover: Table of Contents

- [About the Project](#star2-about-the-project)
  - [Architecture](#building_construction-architecture)
  - [Tech Stack](#space_invader-tech-stack)
  - [Environment Variables](#key-environment-variables)
  - [Database Setup](#card_file_box-database-setup)
- [Getting Started](#toolbox-getting-started)
  - [Prerequisites](#bangbang-prerequisites)
  - [Run Locally](#running-run-locally)
- [Usage](#eyes-usage)

<!-- About the Project -->

## :star2: About the Project

Zpecs stores a workspace's project hierarchy as Projects → Epics → Streams →
Tasks. Coding agents read that context through MCP resources and focused tools;
all writes pass through the same validated, atomic change-set pipeline. The web
app presents the project board, entity detail pages, workspace selection, and
the client connection instructions.

Two workspaces make up one deployable service:

| Package      | Path       | What it is                                                        |
| ------------ | ---------- | ----------------------------------------------------------------- |
| `@zpecs/web` | `apps/web` | TanStack Start web app and the unified Elysia/MCP production host |
| `@zpecs/api` | `libs/api` | Domain, repositories, auth, schemas, Elysia routes, and MCP tools |

### :building_construction: Architecture

The web app and API library run in one process. TanStack server functions call
the shared Elysia app in-process through Eden Treaty, so there is no separate
API application, internal URL, or service-to-service hop. Only `/mcp` and its
OAuth discovery endpoints are exposed from Elysia on the public web origin.

Clerk Organizations are Zpecs workspaces. The active organization scopes both
the web session and the MCP access token, while PostgreSQL remains the source of
truth for projects and their immutable revision history.

<!-- TechStack -->

### :space_invader: Tech Stack

<details>
  <summary>Core</summary>
  <ul>
    <li><a href="https://www.typescriptlang.org/">TypeScript</a></li>
    <li><a href="https://tanstack.com/start">TanStack Start</a> + React</li>
    <li><a href="https://elysiajs.com/">Elysia</a> + Eden Treaty</li>
    <li><a href="https://modelcontextprotocol.io/">Model Context Protocol</a></li>
    <li><a href="https://www.postgresql.org/">PostgreSQL</a> + Drizzle ORM</li>
    <li><a href="https://clerk.com/">Clerk</a> for web sessions and MCP OAuth</li>
    <li><a href="https://vite.plus/">Vite Plus</a> (<code>vp</code>) for package management, tasks, linting, formatting, and builds</li>
  </ul>
</details>

### :key: Environment Variables

Environment variables live in one file at the repository root:

```bash
cp .env.example .env
```

| Variable                     | Required | Purpose                                                       |
| ---------------------------- | -------- | ------------------------------------------------------------- |
| `ZPECS_DATABASE_URL`         | yes      | PostgreSQL connection; deployments may use `DATABASE_URL`     |
| `ZPECS_PUBLIC_URL`           | yes      | Canonical public origin used by MCP and OAuth discovery       |
| `VITE_CLERK_PUBLISHABLE_KEY` | yes      | Clerk tenant used by the browser and shared API runtime       |
| `CLERK_SECRET_KEY`           | yes      | Server-only Clerk credential                                  |
| `ZPECS_AXIOM_DATASET`        | no       | Optional structured-event dataset; `AXIOM_DATASET` also works |
| `ZPECS_AXIOM_TOKEN`          | no       | Optional structured-event token; `AXIOM_TOKEN` also works     |

`ZPECS_PUBLIC_URL` must be an origin without a path or trailing slash. Local
loopback development may use HTTP; deployed instances must use HTTPS.

### :card_file_box: Database Setup

The Drizzle schema owns tables, indexes, constraints, and generated search
columns. Two PostgreSQL details live in
[`manual.sql`](./libs/api/src/integration/drizzle/setup/manual.sql): enable
`pg_trgm` before the first schema push, then install the append-only revision
trigger afterward. The file is intentionally ordered and idempotent.

```bash
vp run db:deploy
```

Railway runs the same three phases automatically before each deployment through
`railway.json`: create `pg_trgm`, push the Drizzle schema, then install the
append-only trigger. All phases are idempotent.

<!-- Getting Started -->

## :toolbox: Getting Started

### :bangbang: Prerequisites

Install [Vite Plus](https://vite.plus/) (`vp`):

```bash
# macOS / Linux
curl -fsSL https://vite.plus | bash
```

```powershell
# Windows
irm https://vite.plus/ps1 | iex
```

`vp` drives the package manager pinned in `package.json` (`pnpm@11.1.1`). The
workspace expects Node.js 22 or newer and Bun 1.3.10 or newer.

### :running: Run Locally

Install dependencies, create the root environment file, and start the unified
service:

```bash
vp install
cp .env.example .env
vp run dev
```

The default local origin is `http://localhost:3003`; its MCP endpoint is
`http://localhost:3003/mcp`.

<!-- Usage -->

## :eyes: Usage

| Script             | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `vp install`       | Install workspace dependencies                        |
| `vp run dev`       | Start the unified web and MCP service                 |
| `vp run build`     | Build production outputs                              |
| `vp run start`     | Start the built service                               |
| `vp run typecheck` | Type-check both packages                              |
| `vp run db:deploy` | Apply the complete idempotent database setup          |
| `vp run db:push`   | Push the Drizzle schema                               |
| `vp check`         | Run lint and format checks                            |
| `vp check --fix`   | Apply lint and format fixes                           |
| `vp run sherif`    | Check workspace dependency consistency                |
| `vp run qa`        | Run static checks, workspace checks, and schema drift |
| `vp run clean`     | Remove generated package and toolchain output         |

`railway.json` builds and starts only `@zpecs/web`, applies the API library's
complete database setup before deployment, and watches both workspaces plus the
shared toolchain configuration.
