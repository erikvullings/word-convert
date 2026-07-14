# 0016 Write documentation and licensing

Status: open
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
