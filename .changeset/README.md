# Changesets

Every change to a publishable package needs a changeset: `pnpm changeset`.
Releases are cut from `main` by `pnpm version-packages` then `pnpm release`.
Packages under `apps/*` and `@moorage/kit` are never published.
