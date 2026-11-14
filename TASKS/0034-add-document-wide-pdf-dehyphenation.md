# 0034 Add document-wide PDF de-hyphenation

Status: open
Priority: medium
Owner: unassigned
Agent: pi
Subsystem: pdf-reader
Depends on: 0031, 0033

## Context

Calibre's de-hyphenation is on by default and `--disable-dehyphenate` turns it off. As
verified in the `Dehyphenator` docstring in `ebooks/conversion/preprocess.py`, the
document itself is the dictionary, so any language and any technical or invented
vocabulary is handled correctly; the documented drawback is that a word appearing only
in hyphenated form is left alone.

WordConvert currently handles exactly one case: soft-hyphen continuation at line ends
in the OCR path (`isSoftOcrHyphenContinuation()`, `removeOcrTextSuffix()` in
`packages/pdf-reader/src/index.ts`). Nothing else:

- hard-hyphen line breaks inside words (`Eu-\nropean`, `dynamic-\nprogramming`) are
  carried into every output format as stray hyphens;
- soft hyphens (U+00AD) appearing in extracted text are never stripped, so they leak
  into Markdown/HTML/EPUB and break word-level search in readers;
- hyphenated compounds inside a single line are untouched even when the unhyphenated
  form is used elsewhere in the same book.

This matters most for hyphenation-heavy sources (German, Dutch, French, Spanish,
justified academic PDFs) where a reflowable EPUB shows the artefact on every line.

## Acceptance Criteria

- A deterministic two-pass pass runs after line merging and before block construction:
  pass one resolves hyphens at line-continuation boundaries, pass two resolves
  in-line-hyphenated words whose unhyphenated form occurs elsewhere in the document.
- Word evidence is collected over the whole retained document (all pages, body text
  only), case-insensitively with case of the surviving form preserved, and is bounded
  by an explicit limit with a deterministic warning when the budget is reached.
- Hyphens are kept — never guessed — when evidence is ambiguous: single-occurrence
  words, hyphenated forms that are also attested unhyphenated *with different meaning*
  (e.g. `re-cover`/`recover` are reported, not silently joined when both unhyphenated
  and hyphenated forms are common), script/RTL boundaries, and words inside `code`
  inline nodes, code blocks, URLs/link destinations, and TeX equation sources.
- Soft hyphens (U+00AD) are removed at join points and elsewhere in body text without
  requiring dictionary evidence; no other control character is altered.
- Behaviour is opt-out (`--dehyphenate off` / typed reader option) and reports
  `joined: n, kept: m` through a deterministic warning; `--dehyphenate on` is required
  for a default flip, which stays out of scope here.
- Fixture coverage: hard-hyphen line break, soft hyphen, unhyphenated-elsewhere word,
  single-occurrence word left alone, code/URL/TeX preservation, and a non-English
  (German) sample; corpus output unchanged while the feature is default-off.

## Implementation Notes

- Add a new module (for example `packages/pdf-reader/src/text/dehyphenate.ts`) or a
  shared text-normalization module if 0038 lands first; operate on `PdfLine`/
  `InlineNode` text only, never on asset data, and keep it free of browser globals so
  the CLI and worker share it.
- Build the evidence map from tokenized `\p{L}+` runs (already used by
  `isNoisyOcrPage()`), excluding furniture/cropped spans and heading-mapped lines so a
  hyphenated title cannot legitimize a body-text join.
- Ordering is deliberate and matches calibre: `punctuation_unwrap()` documents that it
  leaves hyphenated words for "the dehyphenate routine in a separate step", and
  `HeuristicProcessor.process()` runs cleanup mode then individual-words mode after
  unwrapping. That is why this task depends on 0033: joining `dynamic-` + `programming`
  into one line first makes the join point and the evidence visible to one pass.
- Verified against calibre v9.18.0 (`ebooks/conversion/preprocess.py::Dehyphenator`),
  worth reproducing in behaviour while keeping our own implementation:
  - it runs in **three** modes, not two: `html` (line-ending joins, limited by the
    unwrap line length), `html_cleanup` (fixing what earlier stages missed), and
    `individual_words` (hyphens anywhere in a line); the heuristic stage calls cleanup
    then individual-words after unwrapping;
  - before the document lookup it strips a curated **suffix list** (`(ed)?ly`,
    `(i|a)ty`, `(e|a)nce`, `ness`, `ble`, `ment`, `ism`, …) and **prefix list**
    (`dis|re|un|in|ex`) so `dyn-amic` is found as `dynamic` even when only the suffixed
    form occurs; prefixes are only stripped when the fragment is long enough to not be
    the hyphenation point itself;
  - conservative short-fragment guards: fragments of 2 characters or fewer, and joined
    words of 6 characters or fewer in individual-word mode, keep their hyphen;
  - evidence is a substring search of the whole document, case-insensitive.
- Explicitly **do not** copy calibre's cleanup fallback: when neither form is found it
  replaces the hyphen with an em dash (`firsthalf + '—' + secondhalf`), which corrupts
  text. Our rule is to keep the original hyphen and count it as `kept`.
- Join decisions must run on the *same* line pairs that 0033 merged: a hyphen at a
  boundary that was judged a paragraph break stays a real hyphen.
- Unicode care: handle combining marks and precomposed input consistently by comparing
  in one normalization form (document which one) and never reorder marks;
  preserve `TextMark` offsets through joins and suffix removal.
- Determinism: evidence counting is order-independent (map of normalized word →
  count); ties resolve by first occurrence in reading order.
- Update `documentation/hardening.md` performance budget if the extra passes move
  measured conversion time on the corpus, and cap evidence work with the existing
  per-document limits.

## Agent Notes

- 2026-11-13 pi: Split out of 0031; depends on 0033 because de-hyphenation must see the
  final line-merge decisions (calibre runs it during unwrapping for the same reason).
  Keep default-off until the fixture corpus shows the false-positive rate is acceptable
  for both English and one hyphenation-heavy language.
- 2026-11-13 pi: Verified this task against the calibre v9.18.0 source tree (kovidgoyal/calibre, tag v9.18.0) rather than only the CLI help and online manual; Implementation Notes now cite the implementing file for each adopted behaviour, and the notes above record where the source contradicts calibre's own documentation.
