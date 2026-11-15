# 0038 Add scene break blank paragraph and punctuation normalization

Status: done
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: conversion
Depends on: 0031

## Context

Calibre's optional heuristic stage fixes text-level artefacts that survive extraction:

- "Delete blank lines between paragraphs" drops blank paragraphs that alternate with
  every paragraph, while keeping runs of several blank lines as scene breaks;
- "Ensure scene breaks are consistently formatted" centres detected break markers and
  turns whitespace-only breaks into rules, with `--replace-scene-breaks` for a
  substitution;
- `--smarten-punctuation` / `--unsmarten-punctuation` convert straight quotes, dashes,
  and ellipses to typographic forms (Smartypants rules) and back;
- ligature glyphs (`ﬁ`, `ﬂ`, `ﬀ`) are normalized to plain letter pairs by default —
  `--keep-ligatures` opts out — because most reading systems cannot render them.

WordConvert has none of these:

- a centred `* * *` ornament survives as a literal asterisk paragraph, while the page
  transition it often sits next to is invisible (`canMergeAcrossPage()` merges across
  pages), so scene structure is either noisy or absent;
- whitespace-only paragraphs from OCR'd or vector-text pages reach all writers;
- ligature codepoints extracted from PDF fonts are written verbatim into EPUB/HTML/
  Markdown, where they render as tofu or break text search, and `U+00AD`-style control
  artefacts have no general cleanup home (0034 owns only soft hyphens);
- there is no typographic normalization, so OCR'd books keep `"quoted"` and `--` in
  otherwise well-formed prose.

## Acceptance Criteria

- A shared, deterministic text-normalization pass runs on model inline text with
  individually toggleable transforms and a per-document summary warning carrying counts
  per transform.
- Scene breaks: centred ornament-only lines (`* * *`, `***`, `· · ·`, similar curated
  set) and multi-blank-line runs become `thematicBreak` blocks; single blank lines and
  every page boundary never do. `--replace-scene-breaks` equivalent substitutes a
  configured marker from a curated list (no raw HTML accepted).
- Blank paragraphs that merely alternate with content paragraphs are removed; a run of
  blank paragraphs becomes one scene break rather than being deleted, mirroring calibre's
  documented distinction between content-modifying heuristics and styling options.
- Ligature normalization is on by default (calibre's default) with `keepLigatures`
  opt-out, covers the `U+FB00–U+FB06` block plus `U+0132/U+0133`-style ligature
  codepoints, and never touches code spans, code blocks, link destinations, TeX
  equation sources, or asset bytes.
- Punctuation smartening is opt-in, locale-aware (uses the resolved document language),
  handles nesting, apostrophes in contractions, quotes containing nested quotes,
  en/em dash context, ellipsis, and prime-vs-inch ambiguity conservatively; ambiguous
  cases are left unchanged rather than guessed. Unsmartening is the documented inverse.
- Every transform preserves `TextMark` offsets and inline node identity, is stable under
  a second pass (idempotent), and produces byte-identical output for repeated runs.
- Fixtures cover: ornament scene breaks, whitespace-only paragraphs, ligature text,
  quote/dash/ellipsis smartening with known traps (numbers with apostrophes, code
  samples, URLs), and one non-English language sample.

## Implementation Notes

- Prefer one new shared module (for example
  `packages/document-model/src/normalization/` or a small `@wordconvert/text-normalize`
  package) applied from the readers' final stage, so DOCX/HTML/Markdown imports benefit
  and writers stay renderers; keep it free of browser globals and dependencies.
- Do not add a Markdown/HTML-parsing dependency for this; implement the rules directly
  over `InlineNode[]` so emphasis boundaries and existing marks are never re-derived
  from serialized text.
- Scene-break detection must run *before* paragraph merging decisions are lost and
  before chapter splitting, and must consult page numbers so a page-boundary artefact is
  never mistaken for a scene break.
- Keep every rule list (ornaments, latin-phrase italics candidates, dash context
  exceptions) as a data table with a comment pointing at its fixture, and keep rule
  evaluation linear in text length; add a wall-clock/character budget consistent with
  existing reader limits.
- Verified against calibre v9.18.0 (`HeuristicProcessor` in
  `ebooks/conversion/utils.py`), which gives concrete thresholds to start from:
  - `detect_scene_breaks()` marks a paragraph a scene break when its whole content is
    **1 to 10 non-word characters** (whitespace allowed between them), and it first
    excludes lines that begin like continued prose or end like common sentence endings —
    our ornament table should carry the same two exclusions so an elliptical or
    abbreviation-heavy line is not promoted;
  - blank-paragraph handling is separate: `detect_whitespace()` converts blank
    paragraphs sitting around headings or scene breaks into `margin-top` /
    `margin-bottom` in `em` derived from the blank count, labels remaining
    punctuation-free blanks `whitespace`, and `detect_soft_breaks()` renders blank runs
    between two real paragraphs as centred `softbreak` paragraphs with
    `page-break-before:avoid`. Our `SpacerBlockNode`/`thematicBreak` mapping should keep
    that three-way distinction (real break, soft break, spacing) instead of collapsing
    it;
  - `delete_blank_paragraphs` only runs when blank lines exceed **40%** of lines
    (`analyze_blanks()`) or the document is confirmed to use blank-line separation —
    exactly the confidence gate this task requires;
  - ligature decoding is unconditional in the preprocess stage unless `keep_ligatures`
    is set (`preprocess.py`: `_ligpat.sub(... LIGATURES ...)`), confirming that decoding
    by default with an opt-out is the right shape for us.
- Documented deviation: all of the above runs as regex over an HTML *string* in calibre.
  We implement equivalents over `InlineNode[]`/block nodes, which is why our tables must
  encode the same intent rather than be transliterated from those regexes.
- Explicitly out of scope here (see 0031 non-goals): calibre's
  "Italicize common words and patterns" word-list guessing, `--asciiize`, and
  `--keep-ligatures` semantics beyond a pass-through opt-out.
- Update `documentation/hardening.md` budgets and `REQUIREMENTS.md` only for preserved
  behaviour that changes (e.g. thematicBreak emission rules for PDF).

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Land ligature normalization first — it is
  mechanical, default-on-safe, and visibly fixes EPUB rendering; treat punctuation
  smartening as the risky part and keep it opt-in until trap fixtures are convincing.
  Coordinate the shared-module location with 0034 (dehyphenation) so the two do not
  create parallel text-rewrite passes.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
