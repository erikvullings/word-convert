# PDF fixture corpus

Run `pnpm fixtures:pdf` to regenerate the synthetic PDF corpus. The fixtures
exercise text-native books and articles, one- and two-column reading order,
running odd/even headers, page-number footers, links, tagged content, an
image-only page, and malformed input.

`qpdf` is used when available to regenerate `encrypted.pdf`; the committed
fixture lets the test suite run without requiring qpdf.

The corpus is synthetic and contains no private or third-party document
content. Generation uses fixed metadata timestamps; tests assert conversion
determinism rather than byte-identical regeneration because PDF object IDs may
vary between generator versions.
