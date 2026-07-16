# Hardening and browser verification

This document is the release checklist for security, privacy, performance, and browser compatibility. The automated checks are the source of truth; the interactive evidence records the exploratory run performed on 16 July 2026.

## Security requirement-to-test matrix

| Requirement | Limit or policy | Regression coverage |
| --- | --- | --- |
| ZIP bombs and extreme compression ratios | `maxCompressionRatio: 100` | `docx-reader/src/index.test.ts` hostile `compression-ratio.docx` fixture |
| Excessive package size | `maxCompressedBytes: 50 MiB`, `maxUncompressedBytes: 200 MiB` | Configurable compressed/expanded-size assertions in `docx-reader/src/index.test.ts` |
| Excessive entry count | `maxEntries: 1,000` | Generated entry-count fixture in `docx-reader/src/index.test.ts` |
| Path traversal and malformed/encrypted ZIPs | Reject before extraction | Hostile fixtures and encrypted-entry assertions in `docx-reader/src/index.test.ts` |
| Malformed XML and entity expansion | Reject unsafe XML | Malformed and `xml-entity-expansion.docx` fixtures in `docx-reader/src/index.test.ts` |
| Unsafe hyperlinks and remote resources | Allow local/passive resources and safe schemes only | Reader hostile fixture; HTML, Markdown, EPUB writer tests; preview DOMPurify policy test |
| Active SVG and unsafe HTML | Quarantine scripts, handlers, remote references, CSS imports, and processing instructions | Parameterized SVG tests, writer tests, cover-generator sanitization test, and preview policy test |
| Unexpectedly large images | `maxImageBytes: 25 MiB` per image | Configurable oversized-image assertion in `docx-reader/src/index.test.ts` |
| Memory exhaustion | Bound package, expanded content, entry count, compression ratio, and each image; transfer output buffers and release them after download | Reader limit tests, worker runtime cleanup tests, and download lifecycle tests |
| Script injection through metadata, formulas, or filenames | Escape semantic text and generate safe output paths | HTML/Markdown/EPUB writer hostile-input tests, math-converter injection test, cover-generator escaping test |
| Failure and cancellation cleanup | Remove every operation in `finally`; stale cancellation creates no retained state | Worker runtime cancellation and actual reader-failure tests assert zero active operations and private errors |
| Sensitive-data disclosure | No document logging, analytics, conversion fetches, URL parameters, or document persistence | Worker test spies on console and `fetch`; state tests restrict storage to preferences and validated mapping presets |

All reader limits are configurable through `DocxReaderOptions.limits`. Raising them increases peak memory exposure and should be a deliberate host-application decision.

## Determinism and performance budget

The representative `standard-comprehensive.docx` fixture is parsed twice and both `DocumentModel` values must be deeply equal. The two reads share a 1,000 ms regression budget in Vitest. The 16 July 2026 local run completed the pair in approximately 2 ms; the generous CI threshold is intended to catch large regressions without making shared runners flaky. Writer suites separately assert byte-identical deterministic HTML, Markdown ZIP, EPUB, and cover output.

## Browser support policy

WordConvert targets the current and immediately previous major releases of Chrome, Edge, Firefox, and Safari on desktop, plus the corresponding current mobile engines. The production build targets ES2022 and relies on standards available in those releases: Web Workers, transferable `ArrayBuffer`, `Blob`, `File`, object URLs, structured cloning, CSS Grid/Flexbox, and module scripts.

The in-app browser run directly verified the Chromium path, which also exercises the engine used by Chrome and Edge. Firefox and Safari were not available in this environment, so direct two-version engine runs remain a release gate rather than a claimed result. No engine-specific API is used in conversion packages; any discovered browser-specific issue should be recorded here with the affected version and workaround.

## Interactive browser evidence

The 16 July 2026 in-app Chromium run used the standard comprehensive DOCX fixture and verified:

- file selection through the development-only fixture route, style mapping edits, metadata title edits, formula-bearing content, and navigation across all eight stages;
- standalone and ZIP HTML, single-file and ZIP Markdown, and EPUB generation;
- semantic HTML preview, rendered/source Markdown switching, EPUB package inspection, and a generated typographic EPUB cover;
- all download actions and immediate removal of output buffers/object URLs from application state;
- keyboard activation of the theme control, accessible named form controls and landmarks, light/dark themes, and no horizontal overflow at 398 CSS px or 1,417 CSS px;
- no surfaced application error in the completed workflow and no unexpected external requests. The development fixture request and Vite module requests are expected local-only traffic; the worker privacy regression test independently asserts zero conversion-time fetches and console output.

Screenshots:

- [Mobile document picker](browser-evidence/mobile-document-picker.png)
- [Mobile output-format screen](browser-evidence/mobile-output-formats.png)
- [Desktop document picker](browser-evidence/desktop-document-picker.png)

The UI defines no motion animation or transition that needs a reduced-motion alternative. Light and dark palettes were visually checked for readable text, focus controls, and status contrast. The browser accessibility tree and keyboard controls were inspected; a full VoiceOver/NVDA reading-order pass was not available and remains part of a human release check.

The browser fixture endpoint is registered only by the Vite development server and is enabled in application code only when `import.meta.env.DEV` is true. It is absent from the static production deployment.
