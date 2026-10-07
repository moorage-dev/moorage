# Moorage monorepo: conventions for agents and contributors

This public repository contains only Moorage plugin and theme code for EmDash. Nothing else belongs here:
no company website, no private services, no secrets, no customer data.

## Layout

- `apps/demo-site` (package name `demo-site`, private): a copy of the EmDash `templates/marketing` site (Node adapter, SQLite, local uploads) with `sandboxRunner` and the forms plugin added. Installs every package for manual and Playwright testing. It is a test fixture with fixed seed content, never a real site; real sites consume published versions from their own repos. First run: `pnpm --filter demo-site exec emdash secrets generate --write .env`, then add `EMDASH_SITE_URL=http://localhost:4321` to `apps/demo-site/.env`. `pnpm dev` serves it; `/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` signs in as a dev admin. Plugin routes under `/_emdash/api/plugins/<slug>/` need that session and the `X-EmDash-Request: 1` header. To reset, delete `data.db*` and `uploads/`. Add each new package as `workspace:*` and register it in `astro.config.mjs`. Its pages, seed, public assets, `AGENTS.md` and `.agents/skills` are EmDash template code under MIT (`apps/demo-site/LICENSE`, copyright Cloudflare); the FSL header rule below does not apply there.
- `packages/plugin-*`: one EmDash plugin per package. Exists today: `plugin-seo` (scaffold). Sandbox-capable plugins (seo, lead-delivery, site-health, restore, approvals) are scaffolded with `@emdash-cms/plugin-cli` and tested with `@emdash-cms/plugin-test`. Native plugins (analytics, popups) are built with tsdown and tested with Vitest plus Playwright on the demo site.
- `packages/theme-marketing` (NOT created yet): Astro components plus a copyable site template.
- `packages/kit`: does not exist yet. Create it only when two packages need the same code; until then keep helpers inside each package.
- `packages/typescript-config`: shared tsconfig presets (`base.json`, `library.json`).

Build order: seo, theme-marketing, analytics, lead-delivery, site-health, popups, restore, approvals.

## Commands

- `pnpm check` runs everything CI runs: build, typecheck, test, validate, lint, format check.
- Per package: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm validate` (sandbox-capable only).
- `pnpm changeset` for every change to a publishable package.
- Version pins live in the `catalog` of `pnpm-workspace.yaml`; use `"catalog:"` in package manifests. Native build scripts are allowed in `allowBuilds` there.
- Scaffolding a sandbox-capable plugin: run `pnpm dlx @emdash-cms/plugin-cli init <slug> --dir packages/plugin-<slug> --yes` with the publisher, author and security flags, then delete the nested `pnpm-workspace.yaml` it writes, and rewrite `package.json` (name `@moorage/plugin-<slug>`, `catalog:` versions, FSL licence) and `tsconfig.json` (extend `@moorage/typescript-config/library.json`). The CLI's template targets a standalone repo, not a workspace.

## Rules

- Licence is FSL-1.1-MIT. Every source file starts with `// Copyright <year> Moorage. Licensed under FSL-1.1-MIT; see LICENSE.` followed by a blank line (the import sorter leaves it on line 1 only when a blank line follows). Every package has `"license": "FSL-1.1-MIT"` and a copy of `LICENSE`.
- Depend only on EmDash core, official `@emdash-cms/*` packages and our own packages. No third-party EmDash plugins. Extend official plugins by configuration, wrapping, or an upstream PR, never a fork.
- Every plugin must solve its whole problem on a self-hosted EmDash site with no Moorage account and no key. No Moorage-specific fields in registry builds. The word "Moorage" never appears inside the EmDash admin UI.
- One admin page per plugin, few settings, nothing a non-technical editor can break.
- Formatting: tabs, oxfmt. Linting: oxlint. TypeScript strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- Commit messages: imperative, one line, no attribution lines.
- A package is done when: manifest validates, tests are green, it runs on the demo site, Playwright covers any public-page output, README has install, settings, FAQ and changelog, a changeset exists.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
