# 0017 Add CI and Pages deployment

Status: open
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
