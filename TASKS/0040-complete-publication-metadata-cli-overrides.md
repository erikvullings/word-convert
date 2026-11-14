# 0040 Complete publication metadata and add CLI overrides with a sidecar file

Status: open
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: epub-writer
Depends on: 0031

## Context

Calibre's metadata panel writes a full OPF: `--title`, `--title-sort`, `--authors`,
`--author-sort`, `--publisher`, `--comments`, `--series`, `--series-index`, `--isbn`,
`--language`, `--pubdate`, `--cover`, `--book-producer`, plus
`--read-metadata-from-opf` to overlay a complete sidecar metadata document.

WordConvert's document model is already richer than its output:

- `DocumentMetadata` (`packages/document-model/src/index.ts`) carries `publisher`,
  `description`, `subjects`, `version`, `rights`, and four separate dates;
- `packageXml()` in `packages/epub-writer/src/index.ts` writes only
  `dc:identifier`, `dc:title`, `dc:language`, `dc:creator`, and `dcterms:modified`, so
  everything else the user edits in the SPA is silently dropped from the EPUB;
- the PDF reader's `metadata()` maps PDF info/XMP into the model, so much of this data
  already exists per document with provenance and simply disappears;
- the CLI can override only `--title`, `--author`, `--language`, `--identifier`
  (`apps/cli/src/cli.ts`), so batch users cannot set publisher, series, or publication
  date without a browser.

## Acceptance Criteria

- Every populated `DocumentMetadata` field is emitted in the OPF with correct EPUB 3
  elements and properties: `dc:publisher`, `dc:description`, repeated `dc:subject`,
  `dc:rights`, `dc:date` with the right `opf:event` for publication/creation/
  modification, version, and a scheme-qualified `dc:identifier` for ISBN.
- The model gains the minimum fields calibre exposes that the model lacks — at least
  series and series index, contributor/book producer, and title/author sort values —
  with `InferredValue` provenance, and the SPA metadata editor shows and edits them the
  same way as existing fields (`REQUIREMENTS.md` "Metadata" already demands provenance
  display for every inferred field).
- The CLI accepts overrides for every model field it can express
  (`--publisher`, `--description`, `--subject` repeatable, `--rights`, `--series`,
  `--series-index`, `--contributor`, `--title-sort`, `--author-sort`, `--pubdate`,
  `--isbn`, `--cover <file>`), each producing `source: 'user'` provenance, and rejects
  malformed values with actionable messages: dates normalized to the ISO-8601 form the
  EPUB writer already requires, BCP 47 for language, ISBN-10/13 checksum validated
  (invalid values warn rather than fail unless a strict flag is given).
- A sidecar metadata file (`--metadata <file>`, calibre's `--read-metadata-from-opf`
  equivalent) is supported with a versioned, validated JSON schema, a size limit, no
  free-form XML/HTML, and a documented precedence chain: CLI flag > sidecar > reader
  inference > filename/derived defaults, asserted by tests.
- `--cover <file>` feeds the existing cover generator path rather than bypassing it:
  signature-checked, bounded, declared as `cover-image`, and still leaving the semantic
  title page intact.
- `documentation/cli.md`, CLI `--help`, and `README.md` document every flag and the
  sidecar schema together; EPUB validity tests cover the new OPF content and an
  empty-metadata document.

## Implementation Notes

- Resolve the metadata in one place — `resolveMetadata()` in
  `packages/epub-writer/src/index.ts` plus the existing `metadata()` builder in
  `packages/pdf-reader/src/index.ts` — so no writer invents defaults; keep
  `dcterms:modified` independent from fixed ZIP timestamps per `CLAUDE.md`.
- Map `version` deliberately (document the chosen property) rather than leaving a dead
  model field, and do not invent calibre-namespace properties; prefer EPUB 3 /
  DCMES-qualified output.
- Escape all new values through the existing `escapeXml`/`escapeAttribute` helpers;
  metadata must never be interpolated into the OPF raw, and length bounds must be
  enforced before serialization.
- Sidecar parsing belongs in the CLI (or a shared module) and must reuse the SPA's
  versioned-validation discipline: reject unknown keys, never persist source data, and
  never let a sidecar supply asset bytes, file paths outside the input directory, or
  remote URLs (cover images follow the existing local-image containment rules).
- Coordinate the cover part with 0042/0043 so cover policy has exactly one owner.
- Tests: OPF snapshot for a fully populated model, sidecar schema fixtures (valid,
  unknown-key, oversized, malformed date, bad ISBN checksum), CLI precedence tests in
  `apps/cli/src/cli.test.ts`, and SPA editor round-trip tests.
- Verified against calibre v9.18.0: the metadata option surface lives in
  `ebooks/conversion/cli.py` / `plumber.py`, `--insert-metadata` is implemented in
  `ebooks/oeb/transforms/jacket.py` (rendered into the generated metadata jacket, which
  0031 rejects on jacket policy grounds), and `--read-metadata-from-opf` reads a whole
  OPF document. Our sidecar stays a small bounded JSON instead, per the hardening rule
  above.

## Agent Notes

- 2026-11-13 pi: Split out of 0031. Cheapest visible win in the epic — the model and the
  SPA already carry publisher/description/subjects/rights/dates, so a large part of this
  is emitting what is already there plus CLI reach. Watch the fixed-timestamp/
  `dcterms:modified` rule and the deterministic-identifier behaviour when adding
  scheme-qualified identifiers.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
