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
