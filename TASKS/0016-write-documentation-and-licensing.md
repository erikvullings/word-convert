# 0016 Write documentation and licensing

Status: done
Priority: medium
Owner: unassigned
Agent: unassigned
Area: documentation
Depends on: 0015

## Context

Document WordConvert for users, contributors, deployers, and future Rust/WASM work.

## Acceptance Criteria

- README covers every documentation topic listed in `REQUIREMENTS.md` with accurate limitations.
- MIT licence is included with the correct copyright holder/year.
- Dependency licences and required attributions are generated/reviewed and included appropriately.
- Architecture documentation describes privacy boundaries, model/reader/writer contracts, security limits, and WASM integration path.
- Development, fixture generation, browser testing, EPUBCheck, and Pages deployment instructions are reproducible.

## Implementation Notes

- Confirm the desired copyright-holder text before finalizing `LICENSE` if repository identity is insufficient.

## Agent Notes

- Next step: write documentation from verified behavior, not intended behavior.
- 2026-07-16 Codex: Expanded README and contributor documentation with verified purpose, privacy, inputs/outputs, limitations, formulas, heading/metadata inference, covers, security limits, development, deterministic fixtures, browser testing, EPUBCheck, Pages deployment, and Rust/WASM guidance. Added the 2026 Erik Vullings MIT licence and reviewed bundled-runtime notices, including complete MIT and Apache-2.0 terms. Documented privacy/security ownership and the WASM boundary in core contracts. Per user direction, added no documentation tests; verified the focused EPUB writer/EPUBCheck suite (8 existing tests), full suite (19 files/122 existing tests), deterministic fixture regeneration, strict typecheck before and after verification, lint, formatting, and production build. No known task limitations remain; direct Firefox/Safari and assistive-technology checks remain the documented release gates from task 0015.
