---
name: fetch-to-epub
disable-model-invocation: true
description: Retrieve authorized web articles/PDFs, convert downloaded documents to EPUB, or shrink existing EPUB files with wordconvert.
---

# Fetch to EPUB

End-to-end: a list of URLs → downloaded source files (PDF/HTML) → validated EPUBs, all in one output
folder. Captures the hard-won bits: getting past bot protection, choosing the best source format,
converting with the `wordconvert` CLI, and verifying the epub actually holds the full article (not
markup noise).
For an existing EPUB, skip retrieval and use the optimization-only workflow
under step 3.

Prereqs: `wordconvert` on PATH, and the `browser-tools` scripts for protected pages.
Set `BROWSER_TOOLS_DIR` to the installed scripts directory (Chrome on `:9222`).
Optional tools: `pandoc`, `curl`, `gs`, `qpdf`, `pdftotext`, and `pdfimages`.

## Privacy and authorized access

Use only sources you are authorized to access and redistribute. Browser captures,
especially `document.documentElement.outerHTML` from signed-in pages, may include
account details, hidden form values, session tokens, or private content. Keep raw
captures local; review and sanitize HTML, PDF/EPUB metadata, and generated EPUB
content before sharing. Publish only intended article content after confirming
that account/session data and identifying metadata have been removed.

## Workflow

### 1. Retrieve each URL into the output folder

Name files `<NN>-<slug>.<ext>` so order is stable. Prefer a **direct PDF** when one exists; otherwise
save HTML.

**Plain HTTP(S) — use curl:**
```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
curl -sL --retry 2 -A "$UA" -o "article.html" "https://site.example/article"
```

**Akamai / Cloudflare "Access Denied" or JS challenge — use Chrome's real network stack.**
Navigate, then `fetch()` from the page (bypasses curl's TLS/UA block). UTF-8 byte handling is
required or `btoa` throws on non-Latin1 chars.

Binary (PDF) — capture as base64 and decode to file:
```bash
BT="${BROWSER_TOOLS_DIR:?Set BROWSER_TOOLS_DIR to the browser-tools scripts directory}"
node "$BT/browser-nav.js" "https://example.org/article.pdf" >/dev/null 2>&1; sleep 2
node "$BT/browser-eval.js" "(async()=>{const r=await fetch(location.href);const b=await r.arrayBuffer();const u=new Uint8Array(b);let s='';for(let i=0;i<u.length;i+=8192){s+=String.fromCharCode.apply(null,u.subarray(i,i+8192))}return btoa(s);})()" \
  | tr -d '\n' | base64 -D > "article.pdf"
```
Text (HTML) — same shape but `await r.text()` then `new TextEncoder().encode(...)` before `btoa`.
Verify with `file <out>` (PDFs must read `PDF document`, not an HTML access-denied page) and
`stat -f%z`.

**JS-rendered / SPA pages — `fetch()` gets a thin shell.** Wait for
hydration (`sleep 3-6` after nav), then capture the **rendered DOM**:
```bash
node "$BT/browser-eval.js" "(()=>{const h=document.documentElement.outerHTML;const bs=new TextEncoder().encode(h);let bin='';for(let i=0;i<bs.length;i++){bin+=String.fromCharCode(bs[i])}return btoa(bin);})()" | tr -d '\n' | base64 -D > "article.html"
```

### 2. Find the article's OWN PDF (don't grab unrelated reference PDFs)

For HTML landing pages, grep for a downloadable PDF — but exclude terms/ethics/counter PDFs:
```bash
grep -oiE 'href="[^"]*\.pdf"' file.html | grep -viE 'terms|condition|disclosure|ethic|cookie|privacy|counter|guide'
```
Some publishers host the full report on a separate static-content domain while
the article page is only a landing stub. Follow the article's own download link
and verify that the PDF title and content match the intended article.

### 3. Convert to EPUB with the `wordconvert` CLI

Standard Kindle-ready recipe — the CLI now downscales **and** JPEG-encodes figures natively, so no
post-processing is needed:

```bash
wordconvert INPUT -f epub --language en --title "Article Title" \
  --max-image-size 1200 --image-quality 70 \
  --output "slug.epub" --force
```
- Image knobs (defaults: `--max-image-size 1600`, `--image-format jpeg`, `--image-quality 80`).
  `--max-image-size N` resizes the longest edge (0 = embed originals, no resize); `--image-format`
  is `jpeg` (default, small) or `preserve` (keep source PNG/format → stays large); `--image-quality`
  is 1-100. Lower dimensions and quality can substantially reduce figure-heavy EPUBs;
  check readability and the current delivery service's size limit.
- First run downloads the Heron layout model (~164 MiB) to the cache; Core ML (Metal) is auto-selected
  on macOS. `--offline` blocks downloads; `--clear-model-cache` removes managed models.
- The CLI reads linearized "Fast Web View" PDFs that make raw `pdf.js` hang — it does **not** need the
  pdftotext fallback for those.
- **Markdown route** — only for content you've genuinely *cleaned* to plain markdown yourself (a
  stripped article, your own notes): `pandoc file.html -t gfm --wrap=none > /tmp/x.md` then
  `wordconvert /tmp/x.md -f epub …`. Do **not** point pandoc at a raw Avada/Fusion/WordPress page —
  it passes the builder's `<div class="avia-…">` wrapper through as reading text (see gotchas).

#### Existing EPUB input

The CLI also shrinks an already-built EPUB without reconstructing the book:

```bash
wordconvert large.epub --max-image-size 1200 --image-quality 70
# Writes large.shrunk.epub; optionally select a different output:
wordconvert large.epub --output compact.epub
# Optional: organize existing XHTML into chapter files:
wordconvert large.epub --split-chapters --output chapters.epub
```

Defaults are the same 1600 px / JPEG quality 80 policy. Keep the native
`runtime/` beside the executable; no models or network are needed. Chapters,
navigation labels, styles, and metadata stay intact. Converted image suffixes,
manifest MIME types, and static book references are updated together, including
CSS, SVG, and percent-encoded paths. Animated and unsupported image formats are
untouched. Only smaller image encodings are used. Read stderr for byte savings
and warnings; codec failures retain the original image rather than dropping it.
Scripted books reject image-path relocation and chapter splitting because
dynamic references cannot be rewritten safely. Retry with `--image-format preserve`
or `--max-image-size 0`, without `--split-chapters`.

Existing TOCs are preserved; a missing TOC is generated from headings, falling
back to spine documents with a warning when no headings are usable.
`--split-chapters` is opt-in: it splits at repeated H1 headings, or repeated H2
headings when H1 is only the book title. Short/OCR-like headings are ignored,
each section needs substantive text, and short spine fragments coalesce with a
neighboring chapter so preamble lines do not become standalone chapters. Spine
order, TOCs, and cross-chapter links are updated. Without recognizable
boundaries the file stays intact. Existing chapter files remain unchanged by
default unless `--split-chapters` is selected.
TOC/chapter changes may make small books larger even when images shrink.

Input limit: 256 MiB, with bounded ZIP expansion. Encrypted, font-obfuscated,
signed, ZIP64, and malformed packages are rejected. EPUB input supports only
EPUB output; metadata/model/formula overrides are rejected. `--max-image-size 0`
disables image changes but still allows missing-TOC repair and chapter splitting.
`--force` replaces an existing output, never the
input or its aliases. Shrinking is not sanitization: review retained private
content, scripts, remote references, and metadata before sharing.

For PDF input, high-confidence repeated page numbers, running headers, and
footers are automatically omitted from extracted text (requires at least four
pages). Review the cleanup warning; medium/low-confidence candidates and text
baked into images remain. EPUB shrinking removes page numbers only when they
are adjacent to explicit page-break markers, and repeated running labels only
when the same text recurs at multiple markers. Ambiguous lines remain.

### 4. Verify — this is the step that catches real defects

A bigger file is **not** more complete. For each epub check three things:

```bash
f="slug.epub"
epub_content() {
  unzip -Z1 "$f" | grep -Ei '\.(xhtml|html|htm)$' |
    while IFS= read -r entry; do unzip -p "$f" "$entry"; done
}
# (a) valid epub
unzip -p "$f" mimetype | grep -q "application/epub+zip" && echo ok
# (b) body present — use passages from the article, not only headings or TOC labels
epub_content | sed 's/<[^>]*>//g' | grep -oE "known phrase|another phrase" | sort -u
# (c) markup-noise scan — literal HTML shown as reading text (the #1 failure mode, see gotchas)
epub_content | grep -oE '&lt;(div|img|span|section|article)[ "^][^&]*&gt;' | wc -l   # must be 0
```
Report word count + image count + chapter count per file.

## Gotchas (learned the hard way)

- **Pandoc pollutes Avada/Fusion/WordPress layouts — raw-HTML CLI is the correct path, not the fallback.**
  These themes embed the page builder's `<div class="avia-…">` wrapper *inside* the content the converter
  sees; `pandoc -t gfm` emits it as `&lt;div …&gt;` reading text — hundreds of noise tokens that *inflate*
  the word count. The trap: a pandoc version looks "more complete" (e.g. 1434 vs 600 words), but stripping
  the literal tags shows the **real** content is the same — the extra words are markup, not report text.
  So **always start from the CLI's raw-HTML semantic extraction** and run the markup-noise scan (step 4c).
  Never reach for pandoc to "fix" apparent under-capture — diff the tag-stripped text first; trust the
  smaller raw-HTML count if its body phrases are all present.
- **`--include-external-images` used to abort on one bad image; it now skips per-image** (403 hotlink
  blocks, 204 reauth challenges, SVG/unsupported types → warning, conversion continues). Still, a page
  whose only images are blocked will produce a text-only epub — that's expected, not an error.
- **Image-format footgun:** `--image-format preserve` can retain large lossless figures, and
  `--max-image-size 0` disables image optimization. For a compact EPUB set `--max-image-size`
  and use JPEG (default).
  Review image warnings and verify that expected figures remain before sharing.
- **`dc:creator` array bug (older CLI):** a PDF with an empty `<rdf:Seq>` author array crashed the CLI
  on `author?.trim`. Fixed in 0.1.4; if it recurs, strip the element via `qpdf --qdf` → perl remove
  `<dc:creator>…</dc:creator>` → `qpdf --object-streams=generate`, or `gs -sDEVICE=pdfwrite` to
  normalise metadata.
- **Paywalled pages may expose only an abstract.** The public page may expose
  only the abstract. Capture what's there, note it — don't fabricate a fuller source.
- **Protected PDFs:** same Chrome `fetch()` trick as step 1; never ship an HTML "Access Denied" page
  masquerading as the PDF — always `file`-check first.

## Reference: what each source type converts best as

| Source | Best path |
| --- | --- |
| Direct PDF (report, paper) | `wordconvert file.pdf -f epub --max-image-size 1200 --image-quality 70` (Heron layout → headings + figures, small JPEG) |
| Existing EPUB | `wordconvert large.epub --max-image-size 1200 --image-quality 70` (writes `large.shrunk.epub`) |
| Landing page with a PDF link | download the PDF (§2), then the PDF path |
| Server-rendered article HTML | `wordconvert file.html -f epub` (raw-HTML semantic extraction) |
| JS/SPA article | Chrome rendered-DOM capture (§1) → `wordconvert file.html` |
| Avada/Fusion/WordPress article HTML | **raw-HTML CLI** (`wordconvert file.html -f epub`) — full report, 0 noise. Never pandoc here |
| Protected (Akamai/Cloudflare) | Chrome `fetch()` capture (§1), `file`-verify, then convert |
