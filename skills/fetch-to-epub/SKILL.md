---
name: fetch-to-epub
disable-model-invocation: true
description: Retrieve web articles/PDFs and save them as source documents plus EPUBs. Use when the user wants to download papers/articles from URLs, archive them as PDF or HTML, and/or convert them to epub — especially paywalled, Akamai-, Cloudflare-, or JS-rendered pages that a plain curl fetch can't get.
---

# Fetch to EPUB

End-to-end: a list of URLs → downloaded source files (PDF/HTML) → validated EPUBs, all in one output
folder. Captures the hard-won bits: getting past bot protection, choosing the best source format,
converting with the `wordconvert` CLI, and verifying the epub actually holds the full article (not
markup noise).

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
- **Markdown route** for content that only exists as HTML you've already cleaned: `pandoc file.html -t gfm
  --wrap=none > /tmp/x.md` then `wordconvert /tmp/x.md -f epub …`.

### 4. Verify — this is the step that catches real defects

A bigger file is **not** more complete. For each epub check three things:

```bash
f="slug.epub"
# (a) valid epub
unzip -p "$f" mimetype | grep -q "application/epub+zip" && echo ok
# (b) body present — grep for phrases you KNOW are in the article
for x in $(unzip -l "$f"|grep -oE 'EPUB/chapter-[0-9]+\.xhtml'); do unzip -p "$f" "$x"; done \
  | sed 's/<[^>]*>//g' | grep -oE "known phrase|another phrase" | sort -u
# (c) markup-noise scan — literal HTML shown as reading text (the #1 failure mode, see gotchas)
for x in $(unzip -l "$f"|grep -oE 'EPUB/chapter-[0-9]+\.xhtml'); do unzip -p "$f" "$x"; done \
  | grep -oE '&lt;(div|img|span|section|article)[ "^][^&]*&gt;' | wc -l   # must be 0
```
Report word count + image count + chapter count per file.

## Gotchas (learned the hard way)

- **Pandoc can pass page-wrapper markup through as visible text.** Avada/Fusion/WordPress layouts
  can embed the builder's `<div class="avia-…">` wrapper inside the content the
  converter sees; `pandoc -t gfm` then emits it as `&lt;div …&gt;` reading text — hundreds of noise
  tokens inflating the word count. **Prefer the CLI's raw-HTML semantic extraction** and run the
  markup-noise scan (step 4c). Only fall back to pandoc/`/tmp/x.md` if raw-HTML *under*-captures, and
  re-scan. When raw-HTML and pandoc disagree, diff the actual text — don't trust the larger number.
- **`--include-external-images` used to abort on one bad image; it now skips per-image** (403 hotlink
  blocks, 204 reauth challenges, SVG/unsupported types → warning, conversion continues). Still, a page
  whose only images are blocked will produce a text-only epub — that's expected, not an error.
- **Image-format footgun:** `--image-format preserve` can retain large lossless figures, and
  `--max-image-size 0` disables image optimization. For a compact EPUB set `--max-image-size`
  and use JPEG (default).
  A corrupt/unreadable source image can't be embedded — the CLI drops it and notes it in stderr.
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
| Landing page with a PDF link | download the PDF (§2), then the PDF path |
| Server-rendered article HTML | `wordconvert file.html -f epub` (raw-HTML semantic extraction) |
| JS/SPA article | Chrome rendered-DOM capture (§1) → `wordconvert file.html` |
| Avada/Fusion HTML that under-captures | `pandoc → /tmp/x.md → wordconvert`, then markup-noise scan |
| Protected (Akamai/Cloudflare) | Chrome `fetch()` capture (§1), `file`-verify, then convert |
