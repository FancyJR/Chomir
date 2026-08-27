# AGENTS.md

This file provides guidance on how to work with the n8n repository.

## Project Overview

n8n is a workflow automation platform written in TypeScript, using a monorepo
structure managed by pnpm workspaces. It consists of a Node.js backend, Vue.js
frontend, and extensible node-based workflow engine.

## General Guidelines

- Always use pnpm
- **Secrets on the command line:** if a developer opted into anonymous dev
  metrics (`scripts/dev-metrics`), pnpm command arguments are recorded. Arguments
  of secret-carrying words (`config`, `login`, `publish`, `token`) — whether a
  subcommand or baked into a flag — are dropped, and the home dir is stripped from
  paths, but other args are sent as-is — so never put secrets in a command. Pass
  sensitive values via environment variables, which are never captured.
- When adding comments, keep them concise and to the point - explain the "why"
  in a line or two; don't be overly verbose. Comments should be scoped and
  relevant to the surrounding code, not just to the current task
- We use Linear as a ticket tracking system
- We use Posthog for feature flags
- To find registered telemetry events (names, descriptions, properties), run
  `pnpm --filter @n8n/telemetry catalog` (`--json` for structured output). The
  registry is being adopted incrementally, so search call sites if the catalog
  has no match. The `n8n:telemetry` skill covers adding or changing events
- When starting to work on a new ticket – create a new branch from fresh
  master with the name specified in Linear ticket
- When creating a new branch for a ticket in Linear - use the branch name
  suggested by Linear, **unless it is a security fix** (see Security Fix
  Hygiene below)
- Use mermaid diagrams in MD files when you need to visualise something
- **Developing v3 features:** land normal feature work on `master` behind an
  opt-in flag; introduce breaking changes only on the `3.x` branch. See
  [.github/DEVELOPING_V3.md](.github/DEVELOPING_V3.md).

## Agent Skills and Claude Code Plugin

n8n shared skills live in `.agents/skills/`. Claude Code consumes them through
symlinks in `.claude/plugins/n8n/skills/`; OpenCode reads `.agents/skills/`
directly. Harness-specific overrides remain real directories in the harness
path, such as `.opencode/skills/setup-mcps/`. See
[skills README](.agents/skills/AGENTS.md) for editing and sync guidance.

n8n-specific Claude Code commands and agents live in `.claude/plugins/n8n/` and
are namespaced under `n8n:`. Use `n8n:` prefix when invoking them (e.g.
`/n8n:create-pr`, `/n8n:plan`, `n8n:developer` agent). See
[plugin README](.claude/plugins/n8n/README.md) for structure and details.

## Essential Commands

### Fresh checkout / agent setup

For a fresh checkout (cat-bot, a new hire, any agent verifying the repo
builds), prefer `pnpm agent:setup` over running install + build + tests by
hand. It chains them in one process, caps per-process memory and turbo
concurrency so a 6GB box doesn't OOM, streams all output to
`.agent-setup/<step>.log` (gitignored), and surfaces only a one-line summary
per step plus the tail of the failing log. A machine-readable
`.agent-setup/summary.json` is always written so a backgrounded run is
readable in a single shot — no polling, no scrolling logs.

```bash
pnpm agent:setup                 # install → build → test (full suite)
pnpm agent:setup install         # one step at a time
pnpm agent:setup --json          # JSON summary on stdout (for scripts/agents)
```

### Building
Use `pnpm build` to build all packages. ALWAYS redirect the output of the
build command to a file:

```bash
pnpm build > build.log 2>&1
```

You can inspect the last few lines of the build log file to check for errors:
```bash
tail -n 20 build.log
```

If build outputs or the turbo cache are stale (e.g. after switching branches
or worktrees) but dependencies haven't changed, use `pnpm reset` (lightweight
by default) for a fast recovery: it cleans build outputs and force-rebuilds
(keeping `node_modules` and untracked files). If that doesn't fix your issue,
use `pnpm reset --full`, which also wipes untracked files and reinstalls
dependencies.

### Testing
- `pnpm test` - Run all tests
- `pnpm test:affected` - Runs tests based on what has changed since the last
  commit

Running a particular test file requires going to the directory of that test
and running: `pnpm test <test-file>`.

When changing directories, use `pushd` to navigate into the directory and
`popd` to return to the previous directory. When in doubt, use `pwd` to check
your current directory.

### Code Quality
- `pnpm lint` - Lint code
- `pnpm typecheck` - Run type checks

Always run lint and typecheck before committing code to ensure quality.
Execute these commands from within the specific package directory you're
working on (e.g., `cd packages/cli && pnpm lint`). Run the full repository
check only when preparing the final PR. When your changes affect type
definitions, interfaces in `@n8n/api-types`, or cross-package dependencies,
build the system before running lint and typecheck.

## Architecture Overview

**Monorepo Structure:** pnpm workspaces with Turbo build orchestration

### Package Structure

The monorepo is organized into these key packages:

- **`packages/@n8n/api-types`**: Shared TypeScript interfaces between frontend and backend
- **`packages/workflow`**: Core workflow interfaces and types
- **`packages/core`**: Workflow execution engine
- **`packages/cli`**: Express server, REST API, and CLI commands
- **`packages/frontend/editor-ui`**: Vue 3 frontend application
- **`packages/frontend/@n8n/i18n`**: Internationalization for UI text
- **`packages/nodes-base`**: Built-in nodes for integrations
- **`packages/@n8n/nodes-langchain`**: AI/LangChain nodes
- **`packages/@n8n/instance-ai`**: "AI Assistant" in the UI, "Instance AI" in code — AI assistant backend. See its `CLAUDE.md` for architecture docs.
- **`@n8n/design-system`**: Vue component library for UI consistency
- **`@n8n/config`**: Centralized configuration management

## Technology Stack

- **Frontend:** Vue 3 + TypeScript + Vite + Pinia + Storybook UI Library
- **Backend:** Node.js + TypeScript + Express + TypeORM
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Database:** TypeORM with SQLite/PostgreSQL support
- **Code Quality:** Biome (for formatting) + ESLint + lefthook git hooks

### Key Architectural Patterns

1. **Dependency Injection**: Uses `@n8n/di` for IoC container
2. **Controller-Service-Repository**: Backend follows MVC-like pattern
3. **Event-Driven**: Internal event bus for decoupled communication
4. **Context-Based Execution**: Different contexts for different node types
5. **State Management**: Frontend uses Pinia stores
6. **Design System**: Reusable components and design tokens are centralized in
   `@n8n/design-system`, where all pure Vue components should be placed to
   ensure consistency and reusability

## Key Development Patterns

- Each package has isolated build configuration and can be developed independently
- Hot reload works across the full stack during development
- Node development uses dedicated `node-dev` CLI tool
- Workflow tests are JSON-based for integration testing
- AI features have dedicated development workflow (`pnpm dev:ai`)

### Workflow Traversal Utilities

The `n8n-workflow` package exports graph traversal utilities from
`packages/workflow/src/common/`. Use these instead of custom traversal logic.

**Key concept:** `workflow.connections` is indexed by **source node**.
To find parent nodes, use `mapConnectionsByDestination()` to invert it first.

```typescript
import { getParentNodes, getChildNodes, mapConnectionsByDestination } from 'n8n-workflow';

// Finding parent nodes (predecessors) - requires inverted connections
const connectionsByDestination = mapConnectionsByDestination(workflow.connections);
const parents = getParentNodes(connectionsByDestination, 'NodeName', 'main', 1);

// Finding child nodes (successors) - uses connections directly
const children = getChildNodes(workflow.connections, 'NodeName', 'main', 1);
```

### TypeScript Best Practices
- **NEVER use `any` type** - use proper types or `unknown`
- **Avoid type casting with `as`** - use type guards or type predicates instead (except in test code where `as` is acceptable)
- **Define shared interfaces in `@n8n/api-types`** package for FE/BE communication
- **Lazy-load heavy modules** — if a module is only used in a specific code
  path (not every request), use `await import()` at point of use instead of
  top-level `import`. Applies especially to native modules and large parsers.

### Error Handling
- Don't use the deprecated `ApplicationError` class anywhere — it's a
  compatibility shim kept only so community nodes keep resolving. Use one of
  these instead, picking by cause:
  - `UserError` — the user caused it (invalid input, unauthorized action,
    business-rule violation).
  - `OperationalError` — a transient, expected issue (network request failing,
    DB query timing out) that should be handled gracefully.
  - `UnexpectedError` — a bug in the code (logic mistake, unhandled case,
    failed assertion) that developers need to fix.
- Import from appropriate error classes in each package

### Persistence layer & the TypeORM boundary

TypeORM (`@n8n/typeorm`) must stay in the **persistence layer** — the `@n8n/db`
package or a backend module's own `database/` folder (entity/repository files).
Business logic — services, controllers, handlers, commands, factories — must not
import from `@n8n/typeorm` (including `@n8n/typeorm/...` subpaths). In
`packages/cli` this is enforced by the `misplaced-n8n-typeorm-import` lint rule;
a new import (or an inline `eslint-disable` of the rule) fails CI.

- **Pattern:** when a query needs operators (`In`, `IsNull`, `LessThan`,
  `FindOptionsWhere`, …), put it behind a **use-case-named repository method**
  that takes plain parameters and returns domain-shaped values — not a generic
  `find(options)` passthrough.
- **Transactions:** transaction orchestration belongs in the persistence layer.
  Don't reach for `.manager` / `.manager.transaction(...)` or
  `createQueryBuilder(...)` in business logic. Use the sanctioned primitive in
  `@n8n/db`: inject the abstract `TransactionRunner` and wrap the unit of work in
  `txRunner.run(ctx, async (ctx) => …)`. The callback receives an
  `OperationContext` carrying the active transaction; thread that `ctx` into the
  repository methods you call. `run` **requires** a context — pass an empty `{}`
  at the operation entry point, and reuse the one you were handed everywhere
  below it (a context that already carries a transaction is joined, not nested).
  Repositories extend `BaseRepository` and resolve the right `EntityManager` with
  `this.managerFor(ctx)`; the `Transaction` handle is opaque and never exposes a
  driver type to business logic. See `oauth-token.service.ts` +
  `oauth-*-token.repository.ts` for a worked example.
- **Anti-patterns reviewers reject** — they hide the dependency instead of
  removing it:
  - String-matching TypeORM errors, e.g. `error.name === 'QueryFailedError'`.
  - Relabeling the import from `@n8n/typeorm` to `@n8n/db` to silence the rule
    (`@n8n/db` re-exports several operators/types, but this relabels the
    dependency rather than removing it).
  - Pushing `.manager` / `createQueryBuilder` into business logic to avoid an
    operator import — trades a visible leak for an invisible one.

### Frontend Development
- Refer to `packages/frontend/AGENTS.md`
- **All UI text must use i18n** - add translations to `@n8n/i18n` package
- **Use CSS variables directly** - never hardcode spacing as px values
- **data-testid must be a single value** (no spaces or multiple values)
- Always use `design-system-rules` skill in reviews

### Testing Guidelines
- **Always work from within the package directory** when running tests
- **Mock all external dependencies** in unit tests
- **Prefer r