# 0015 Harden and browser test

Status: done
Priority: high
Owner: unassigned
Agent: unassigned
Area: quality
Depends on: 0014

## Context

Verify resilience, privacy, accessibility, browser compatibility, performance, and the complete interactive workflow.

## Acceptance Criteria

- Security tests cover all limits and injection/resource threats in `REQUIREMENTS.md`, including cleanup after failure/cancellation.
- Determinism and representative performance fixtures have documented budgets and regression checks.
- Codex's in-app browser verifies the full workflow, downloads, responsiveness, keyboard use, themes, and zero unexpected network requests.
- Current and previous major Chrome, Edge, Firefox, and Safari support is documented and compatibility issues are resolved or clearly noted.
- No sensitive document data appears in logs, storage, analytics, URLs, or network traffic.

## Implementation Notes

- Use the available in-app browser skill for interactive checks; add Playwright only if an essential repeatable CI smoke test remains impossible otherwise.
- Include manual assistive-technology and reduced-motion/contrast checks where automation is insufficient.

## Agent Notes

- Next step: maintain a requirement-to-test matrix and record browser evidence/screenshots.
- Added a configurable 25 MiB per-image reader limit and regressions for every package limit, representative-fixture determinism/performance, privacy, and failure/cancellation cleanup.
- Added `documentation/hardening.md` with the requirement-to-test matrix, default budgets, browser policy, accessibility caveats, and Chromium evidence from the 16 July 2026 in-app browser run.
- Verified style and metadata editing, formula-bearing content, HTML/Markdown standalone and ZIP modes, EPUB cover/layout, previews, downloads, keyboard theme activation, light/dark styling, and responsive widths. Firefox and Safari direct runs remain an explicit human release gate because those engines were unavailable.
- Full verification: 19 test files / 122 tests, strict typecheck, lint, and production build pass.
