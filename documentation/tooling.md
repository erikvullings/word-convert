# Tooling

WordConvert is a pnpm workspace using modern ESM throughout.

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer (the workspace pins pnpm 11.7.0)

Install dependencies with `pnpm install`. Run the development server with
`pnpm dev`. The root quality gates are:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Use `pnpm install --frozen-lockfile` in a clean checkout or CI. The development
server prints the local application URL; stop it with Ctrl-C.

TypeScript is configured strictly and checked with TypeScript 7. Core packages
use only the ES library; the web application and worker are separate TypeScript
programs so browser DOM globals cannot leak into worker or core code.

## Browser and deployment targets

The support policy is the current and previous major releases of Chrome, Edge,
Firefox, and Safari. Production JavaScript targets ES2022, a conservative syntax
floor for that matrix, and `.browserslistrc` records the rolling policy for tools
that consume Browserslist.

Development uses `/` as the Vite base. Production defaults to
`/word-convert/` for `erikvullings/word-convert` on GitHub Pages. Override either
with `WORDCONVERT_BASE_PATH`, including both leading and trailing slashes.

## Fixture generation

Run `pnpm fixtures:generate` to reproduce the synthetic DOCX corpus and its
manifests. Verify deterministic regeneration with:

```sh
git diff --exit-code -- tests/fixtures/docx
```

Large entry-count and expanded-size attacks are generated in memory by tests and
are intentionally not committed. See `tests/fixtures/docx/README.md` and
`corpus.json` for the requirements mapping.

## Browser verification

Start `pnpm dev`, load the standard comprehensive fixture through the development
fixture route, and follow every item under “Interactive browser evidence” in
`documentation/hardening.md`. Exercise all output modes, previews, downloads,
keyboard navigation, themes, and narrow/wide layouts while checking that
conversion produces no external requests. The route exists only in development.
Direct Firefox and Safari runs remain a human release gate.

## EPUBCheck

Install the `epubcheck` executable for your platform and put it on `PATH`. Confirm
availability with `epubcheck --version`, then run:

```sh
pnpm exec vitest run packages/epub-writer/src/index.test.ts
```

The suite runs its EPUBCheck case only when the executable is detected. It creates
and removes the validation EPUB in the operating-system temporary directory.

## GitHub Pages

Build the default repository-path deployment with `pnpm build`. For a fork or a
different Pages path, include both leading and trailing slashes:

```sh
WORDCONVERT_BASE_PATH=/my-repository/ pnpm build
```

In GitHub repository settings, select **GitHub Actions** as the Pages source. The
`Deploy SPA to GitHub Pages` workflow installs the frozen lockfile, builds
`apps/web/dist`, uploads it, and deploys on pushes to `main` or manual dispatch.
No application secret or server component is required.

## Dependency licence review

`THIRD_PARTY_NOTICES.md` records the installed direct runtime packages and their
reviewed versions, licence expressions, attribution, and upstream source. Update
it whenever `pnpm-lock.yaml` changes by inspecting installed `package.json`,
`LICENSE*`, and `NOTICE*` files and following transitive runtime dependencies.
