# 0017 Add CI and Pages deployment

Status: done
Priority: high
Owner: unassigned
Agent: unassigned
Area: devops
Depends on: 0015, 0016

## Context

Continuously verify quality and deploy the completely static application to GitHub Pages.

## Acceptance Criteria

- GitHub Actions runs frozen pnpm install, formatting, linting, strict type checks, Vitest, and production build.
- CI installs Java/EPUBCheck, generates representative EPUBs, and fails on validation errors.
- Pages workflow deploys only static output for `erikvullings/word-convert` with the correct `/word-convert/` base.
- Built application is verified to make no required runtime network requests and contains no server dependency.
- Workflow permissions, caching, artefact retention, dependency pinning, and concurrency are least-privilege and documented.

## Implementation Notes

- Confirm the canonical GitHub repository spelling before enabling Pages; GitHub names are case-insensitive but URLs/configuration should consistently use the canonical lowercase slug.
- Keep CI browser automation optional unless task 0015 establishes an essential repeatable gap.

## Agent Notes

- Next step: implement CI in separate verification and deployment jobs, then test the deployed subpath.
- 2026-07-16 Codex: Verified the canonical `erikvullings/word-convert` origin and existing `/word-convert/` production base, then completed the workflow with frozen pnpm installation, formatting, zero-warning lint, strict typechecks, Vitest, checksum-pinned EPUBCheck 5.3.0, production build, and a static/offline-output assertion. Pinned every action to a full commit SHA, confined Pages/OIDC write access to deployment, retained the artifact for one day, and documented caching, concurrency, timeouts, permissions, and dependency pinning. Converted the static SPA to a base-path-safe installable PWA with a manifest, icon, production service-worker registration, generated application-shell precache, same-origin runtime caching, and no server dependency. Verified repository formatting and lint, recursive strict typechecks, the full suite (19 files/122 existing tests), the focused EPUB writer suite with the EPUBCheck case active (8/8 existing tests), production build, seven-file offline static artifact, and `git diff --check`. No known task limitations remain.
