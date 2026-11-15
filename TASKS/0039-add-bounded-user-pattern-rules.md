# 0039 Add bounded user pattern rules for furniture and text cleanup

Status: done
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0031

## Context

Calibre documents Search & Replace as the escape hatch for PDF conversions: "These
options are useful primarily for conversion of PDF documents or OCR conversions… some
conversions can leave behind page headers and footers in the text." It provides
`--sr1-search/--sr1-replace` (through `--sr3`), a `--search-replace` file of alternating
Python regex/replacement lines, and PDF-input `--pdf-header-regex` /
`--pdf-footer-regex` which test only the first/last line of each page.

WordConvert's automatic furniture detection is confidence-gated and refuses to delete
low-confidence content (correctly), so any book whose running title varies slightly,
uses decorative ornaments, or has section-specific headers keeps that junk in every
output format with no user recourse short of editing the output by hand. There is no
user-pattern mechanism anywhere in the pipeline.

## Acceptance Criteria

- Typed reader/writer options accept user patterns in two clearly separated scopes:
  - **page-furniture patterns** (PDF only) tested against only the first and last line of
    each page (calibre's `--pdf-header-regex` / `--pdf-footer-regex` semantics);
  - **general rules** applied to inline text across the document (calibre's
    `--search-replace` semantics), each pair `{ search, replace }` with `replace`
    permitted to be empty.
- A rules file format is specified and documented: UTF-8, alternating
  pattern/replacement lines, a hard pair limit, a per-pattern length limit, comments
  ignored, over-budget files rejected with a structured error before any page is parsed.
- Pattern execution is bounded and cannot hang a conversion: input is matched per line
  (never one giant string), the number of candidate lines per page and total matches is
  capped, work is checked against `CancellationSignal` and a wall-clock budget, and
  pathological patterns are reported as a deterministic warning naming the rule instead
  of crashing or stalling.
- Rejected pattern features are documented and rejected up front (no replacement-string
  expansion into markup, no patterns applied to link destinations, asset data, TeX
  equation sources, or code spans/code blocks unless explicitly allowed).
- Removed text never leaves an empty paragraph, an orphan list bullet, or an empty table
  cell behind; blocks emptied entirely by a rule are dropped and counted.
- Furniture-pattern matches are reported as reviewable candidates in
  `PdfAnalysisSummary` (with kind, page parity, page coverage, confidence) and follow
  the existing automatic-removal confidence rules rather than bypassing them, so a
  one-off page is never deleted by a too-broad pattern.
- CLI flags (for example `--search-replace <file>`, `--header-regex <pattern>`,
  `--footer-regex <pattern>`) land with `--help`, `documentation/cli.md`, and README
  updates, and invalid/blocked combinations fail with actionable messages.
- Fixtures/tests: a repeated running title that automatic detection keeps, a first-line
  and last-line furniture pattern, a rule that would match inside a URL or TeX source
  (must not apply), an over-budget rules file, and a hostile pattern
  (`(?:a+)+$`-style) proving the work budget fires.

## Implementation Notes

- Keep matching in the reader/analysis stage for furniture patterns (next to
  `detectFurniture()` / `furnitureKind()` in `packages/pdf-reader/src/index.ts`) and in
  the shared text pass for general rules (coordinate the module with 0034/0038 so there
  is one text-rewrite path).
- Compile patterns once per conversion, in a fixed order, with a stable rule id used in
  warnings and diagnostics; document whether flags (`u`, `i`, `m`) are set and never
  set `g` implicitly in a way that changes user expectations.
- Bound the pre-compile check too: length cap plus a conservative structural check
  (reject nested quantifiers and backreferences) before ever constructing a `RegExp`, and
  treat "pattern rejected" as a warning with the rule id rather than a fatal error.
- Replacements are plain text. Writers already escape output; never build HTML/EPUB
  strings from a user replacement.
- Persist nothing user-supplied in the SPA; if a UI is added later, validate before
  storage the way style presets are validated.
- Document the whole feature in `documentation/hardening.md` (untrusted-input matrix and
  budget table) because it is the first user-regex surface in the product.
- Verified against calibre v9.18.0, mostly as justification for the hardening in this
  task rather than as behaviour to copy:
  - `ebooks/conversion/search_replace.py` compiles user patterns with the third-party
    `regex` module (`VERSION1 | WORD | FULLCASE | MULTILINE`) and sets **no** match
    timeout or work budget, and the file has no length or complexity cap — the two
    protections this task adds are deliberate deviations;
  - the `--search-replace` value reaching the pipeline is **JSON pairs**
    (`json.loads(search_replace)` in `preprocess.py`); the alternating
    expression/replacement text file is an editor/GUI format, so choose one canonical
    on-disk format here and say so in `documentation/cli.md`;
  - rules are applied in reverse list order with each `--srN` inserted at the front, so
    ordering is observable and must be pinned by a test;
  - a pattern that fails to compile is logged as an error and skipped, not fatal —
    matching this task's warning-plus-rule-id policy;
  - `pdftohtml_rules()` are input-specific built-in cleanup rules applied for PDF input
    only; a curated built-in set per input format is worth adopting alongside user rules,
    as long as each built-in rule has a fixture;
  - `--pdf-header-regex`/`--pdf-footer-regex` are applied in `create_page_format()`
    *before* automatic header/footer detection, confirming the precedence rule that
    explicit user patterns run before heuristics;
  - calibre's `markup_user_break()` accepts raw `<hr>`/`<img>` markup in a replacement
    string. We reject markup in replacements (plain text only), which is another
    documented deviation to record in `documentation/hardening.md`.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Two deliberate constraints that differ from calibre:
  replacements cannot contain markup (calibre accepts `<hr/>` and `<img>` in
  `--replace-scene-breaks`, which is fine for a desktop tool and not fine here), and
  patterns are structurally pre-screened because a CLI/browser conversion has no
  supervisor to kill a hung worker. Furniture patterns should feed the existing
  candidate/confidence machinery rather than becoming a second deletion path.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
