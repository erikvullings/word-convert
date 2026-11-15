import { parseArgs } from 'node:util';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  link,
  mkdtemp,
  open,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  DEFAULT_CHAPTER_DETECTION,
  importStylePreset,
  isConversionError,
  parseTextPatternRules,
  PatternRulesFileError,
  MAX_TEXT_PATTERN_FILE_BYTES,
  validateChapterDetection,
  type ChapterDetectionMode,
  type ChapterDetectionOptions,
  type ChapterHeadingLevel,
  type ChapterMark,
  type DocumentModel,
  type InferredValue,
  type PipelineStageEvent,
  type StyleMapping,
  type TextNormalizationOptions,
} from '@wordconvert/document-model';
import { secureDocxReader } from '@wordconvert/docx-reader';
import { writeHtml, writeHtmlZip } from '@wordconvert/html-writer';
import { writeMarkdown, writeMarkdownZip } from '@wordconvert/markdown-writer';
import {
  DEFAULT_EPUB_IMAGE_QUALITY,
  DEFAULT_EPUB_MAX_CHAPTER_SIZE_BYTES,
  DEFAULT_EPUB_MAX_IMAGE_DIMENSION,
  MAX_EPUB_EXTRA_CSS_BYTES,
  writeEpub,
  type EpubCoverPolicy,
  type EpubImageDimensions,
  type EpubWriterOptions,
} from '@wordconvert/epub-writer';
import type { MathOutputMode } from '@wordconvert/math-converter';
import type { PdfAnalysisSummary } from '@wordconvert/pdf-reader';
import { version } from '../package.json';
import { isExecutionProvider } from './inference-options.ts';
import {
  clearModelCache,
  defaultModelCache,
  ensureModel,
  MODEL_FILES,
} from './model-cache.ts';
import {
  createPipelineDebugDump,
  PipelineDebugUsageError,
} from './pipeline-debug.ts';
import {
  applyMetadataSidecar,
  isValidIsbn,
  MAX_METADATA_FILE_BYTES,
  normalizeIsoDate,
  normalizeLanguageTag,
  parseMetadataSidecar,
} from './metadata-sidecar.ts';

const FORMATS = [
  'html',
  'html-zip',
  'markdown',
  'markdown-zip',
  'epub',
] as const;
type Format = (typeof FORMATS)[number];
const EXTENSIONS: Record<Format, string> = {
  html: '.html',
  'html-zip': '.html.zip',
  markdown: '.md',
  'markdown-zip': '.md.zip',
  epub: '.epub',
};
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const HELP = `WordConvert ${version} - local document conversion and EPUB shrinking

Usage: wordconvert <input.docx|input.pdf|input.md|input.html|input.epub> [options]
       wordconvert --clear-model-cache [--model-cache-dir <dir>]

  -f, --format <format>        epub (default), html, html-zip, markdown, markdown-zip
                              Inferred from --output extension unless explicitly set
  -o, --output <path>          Default: beside input, with the format's extension
                              Use "-" for stdout (including binary ZIP/EPUB)
                              EPUB input: repack only, defaults to <name>.shrunk.epub
      --force                 Replace an existing output, never the input/preset
      --style-preset <path>    Version 1 JSON preset exported by the SPA (DOCX only)
      --chapter-detection <mode> off, automatic (default), or custom (PDF input)
      --chapter-mark <mark>    pagebreak, rule, none (default), or both
      --chapter-split-level <1-6>  Heading level that starts chapters; default 2
      --flow-size <kb>         Maximum serialized EPUB chapter size; default 260,
                              0 or off disables size splitting
      --split-on-page-breaks   Allow page-break blocks as size-split boundaries
      --toc-source <source>    automatic (default), embedded, generated, or off (PDF)
      --use-auto-toc           Force TOC creation from internal links (PDF)
      --no-chapters-in-toc     Disable all TOC entries (PDF)
      --toc-threshold <n>      Add internal-link TOC entries below this chapter count; default 6
      --max-toc-links <n>      Maximum internal-link TOC entries; default 50
      --duplicate-links-in-toc Allow repeated labels only for distinct targets
      --no-toc-embedded        Prefer generated headings over PDF bookmarks
      --toc-filter <pattern>   Bounded case-insensitive TOC label filter (PDF)
      --toc-title <text>       Contents heading; default Contents
      --toc-inline             Add a visible contents page/section
      --toc-at-end             Place visible contents after book content
      --title <text>           Override inferred title
      --subtitle <text>        Override subtitle
      --title-sort <text>      EPUB title sort value
      --author <name>          Override authors (repeat for multiple authors)
      --author-sort <text>     EPUB author sort value
      --publisher <text>       Override publisher
      --description <text>     Override description
      --subject <text>         Add a subject (repeatable)
      --book-version <text>    Override publication version
      --rights <text>          Override rights statement
      --series <text>          Override series name
      --series-index <number>  Series position, greater than 0
      --contributor <name>     Add a contributor (repeatable)
      --book-producer <name>   Book producer contributor
      --source-created-at <ISO> Original document creation date
      --source-modified-at <ISO> Original document modification date
      --pubdate <ISO>          Publication date (ISO 8601 date or timestamp)
      --isbn <number>          ISBN-10 or ISBN-13; warns on checksum errors
      --strict-isbn            Reject ISBNs with an invalid checksum
      --metadata <path>        Bounded v1 JSON sidecar; CLI > sidecar > reader > defaults
      --cover <path>           Bounded JPEG/PNG/WebP or sanitized SVG cover;
                               rasterized as PNG; keeps semantic title page
      --cover-policy <policy>  source, generated, file, or none; default file with --cover
      --no-default-epub-cover  Omit cover image and spine entry, keep title page
      --preserve-cover-aspect-ratio  Letterbox cover images instead of cropping
      --extra-css <path>       Append validated local CSS (maximum 64 KiB)
      --epub-max-image-size <WxH>  Independently cap EPUB image width and height
      --start-reading-at <heading>  Heading label for the EPUB bodymatter landmark
      --frontpage-cover        Use the first PDF page as the EPUB cover and omit
                               its images from the body
      --remove-first-image     Omit a high-confidence source cover image from PDF body content
      --language <tag>         Override language; missing/invalid document tag defaults to en
      --identifier <text>      Override publication identifier
      --conversion-date <ISO>  Fixed conversion/package-modified date
      --formula-mode <mode>   source, mathml, katex, disabled
                              Default: mathml for EPUB, source otherwise
      --max-image-size <px>   Longest image edge in EPUB output; larger JPEG/PNG/WebP
                              images are downscaled. Default 1600, 0 disables
      --image-format <format> EPUB opaque images: jpeg (default) or preserve
      --image-quality <1-100> EPUB JPEG/WebP quality (default 80)
      --split-chapters        EPUB input: split at chapter headings (opt-in)
                              A missing TOC is generated automatically
      --debug-pipeline <dir>   Write bounded, privacy-sensitive stage artifacts
      --debug-pipeline-assets  Include exact stage-4 writer assets; requires --debug-pipeline
      --verbose                Repeat up to twice for stage timings and options
      --rasterize             Render PDF vectors/pages using the native runtime
      --layout-model <path>   Use a local Heron ONNX model instead of the cached default
      --no-layout             Disable default PDF layout analysis (no Heron download)
      --crop-top <0..1>       Omit text above this fraction of each PDF page
      --crop-bottom <0..1>    Omit text below this fraction of each PDF page
      --no-remove-furniture   Retain detected repeated headers, footers, and page numbers
      --header-regex <pattern> Match only each PDF page's first text line as furniture
      --footer-regex <pattern> Match only each PDF page's last text line as furniture
      --remove-furniture <id> Remove a detected furniture candidate (repeatable)
      --keep-furniture <id>   Retain a detected furniture candidate (repeatable)
      --list-furniture        List detected PDF furniture candidates and exit
      --no-images             Skip PDF image extraction, including figure and rendered-
                              equation images; requires --no-layout
      --pdf-tables <list>     PDF table signals: tagged, ruled, borderless (comma
                              separated), or none. Default tagged,ruled; borderless
                              infers tables from aligned columns alone
      --unwrap-factor <0..1>  Keep short PDF lines separate; default 0.45
      --dehyphenate <on|off>  Use document-wide evidence to remove PDF word-break
                              hyphens; default off
      --scene-breaks <on|off> Detect ornament and multi-blank scene breaks; default on
      --blank-paragraphs <on|off> Remove confidently detected blank paragraphs; default on
      --keep-ligatures         Preserve ﬁ-style ligature characters; default normalizes
      --smarten-punctuation    Convert unambiguous quotes, dashes, and ellipses
      --unsmarten-punctuation  Convert typographic quotes, dashes, and ellipses to ASCII
      --search-replace <file> Apply bounded UTF-8 regex/replacement line pairs
      --replace-scene-breaks <marker> Use asterisks, dots, floral, or em-dash instead of rules
      --formula-ocr           Enable TexTeller OCR, downloading missing models once
      --formula-model-dir <dir> Enable TexTeller (encoder.onnx, decoder.onnx,
                              tokenizer.json); overrides cached formula models
      --execution-provider <name> auto (default), cpu, coreml (macOS), webgpu
                              GPU providers require compatible drivers/hardware
      --runtime-dir <dir>     Override native runtime (auto-resolved beside real executable)
      --include-external-images Download public HTTPS raster images in Markdown/HTML
                              Disabled by default; never accesses private networks
      --offline               Never use the network; missing cached models are errors
      --model-cache-dir <dir>  Override OS model cache directory
      --clear-model-cache     Delete only managed cached models, then exit

Metadata sidecars are UTF-8 JSON, at most 32768 bytes, with no unknown keys:
{"schema":"wordconvert.metadata","version":1,"metadata":{"title":"Title","titleSort":"Title sort","subtitle":"Subtitle","authors":["Author"],"authorSort":"Author sort","language":"en","publisher":"Publisher","description":"Description","subjects":["Subject"],"version":"2.0","rights":"Rights","identifier":"urn:id","isbn":"9780306406157","sourceCreatedAt":"2020-01-02","sourceModifiedAt":"2021-02-03","publicationDate":"2022-03-04","series":"Series","seriesIndex":1,"contributors":["Editor"],"bookProducer":"Producer"}}
String fields are limited to 16384 characters; lists hold at most 100 strings.
Dates and BCP 47 languages are validated. --conversion-date is not a sidecar field.
  -h, --help                  Show this help
  -v, --version               Show version

Warnings and errors go to stderr. Exit codes: 0 success, 1 conversion/I/O error,
2 invalid arguments. Local files only; no browser, network, or installed runtime
is required by a compiled executable. PDF layout analysis downloads a pinned,
SHA-256-verified Heron model (~164 MiB) on first use with a warning on stderr.
Formula OCR is optional (~245 MiB). Documents are never uploaded.
Keep runtime/ beside the executable; temporary directories are not needed.
Auto prefers CoreML on macOS, WebGPU elsewhere, with a warning on CPU fallback.
Explicit GPU choices fail rather than silently fall back; unsupported operators use CPU.
Pipeline dumps contain document text and omit asset bytes by default. Use
--debug-pipeline-assets to include exact stage-4 writer assets; choose a private directory.
Stages: raw PDF, PDF analysis, semantic model, and pre-packaged writer artifacts.

Examples:
  wordconvert notes.md -o notes.epub
  wordconvert article.html -o article.epub
  wordconvert article.html --include-external-images -o article.epub
  wordconvert book.pdf -f epub -o book.epub
  wordconvert article.html --max-image-size 1200 -o small.epub
  wordconvert large.epub --max-image-size 1200 --image-quality 70
  wordconvert paper.pdf --formula-ocr -f markdown
  wordconvert book.pdf --no-layout --offline -f html
  wordconvert --clear-model-cache
`;

export interface CliIo {
  stdout(data: string | Uint8Array): Promise<void>;
  stderr(message: string): void;
}

class UsageError extends Error {}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArguments(argv);
    if (values.help) {
      await io.stdout(HELP);
      return 0;
    }
    if (values.version) {
      await io.stdout(`${version}\n`);
      return 0;
    }
    for (const [name, value] of Object.entries(values))
      if (typeof value === 'string' && !value.trim())
        throw new UsageError(`--${name} must not be empty.`);
    const requestedVerbose = parseVerbose(values.verbose);
    const cacheDirectory = resolve(
      values['model-cache-dir'] ?? defaultModelCache(),
    );
    if (values['clear-model-cache']) {
      if (
        positionals.length ||
        Object.keys(values).some(
          (key) => key !== 'clear-model-cache' && key !== 'model-cache-dir',
        )
      )
        throw new UsageError(
          '--clear-model-cache cannot be combined with conversion arguments.',
        );
      io.stderr(
        `Removed ${await clearModelCache(cacheDirectory)} cached model files from ${cacheDirectory}.\n`,
      );
      return 0;
    }
    const input = positionals[0];
    if (!input || positionals.length !== 1)
      throw new UsageError(
        'Provide exactly one local DOCX, PDF, Markdown, HTML, or EPUB input. See --help.',
      );
    if (values['debug-pipeline-assets'] && !values['debug-pipeline'])
      throw new UsageError(
        '--debug-pipeline-assets requires --debug-pipeline <dir>.',
      );
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input))
      throw new UsageError(
        'Only local files are supported; remote URLs are not accepted.',
      );
    const extension = extname(input).toLowerCase();
    if (values['include-external-images'] && values.offline)
      throw new UsageError(
        '--include-external-images cannot be combined with --offline.',
      );
    if (
      values['include-external-images'] &&
      ['.docx', '.pdf', '.epub'].includes(extension)
    )
      throw new UsageError(
        '--include-external-images is supported only for Markdown/HTML input.',
      );
    if (
      ![
        '.docx',
        '.pdf',
        '.md',
        '.markdown',
        '.html',
        '.htm',
        '.xhtml',
        '.epub',
      ].includes(extension)
    )
      throw new UsageError(
        'Only local DOCX, PDF, Markdown (.md/.markdown), HTML (.html/.htm/.xhtml), and EPUB files are supported.',
      );
    if (values['include-external-images'])
      io.stderr(
        'warning: External image downloads are enabled. Image hosts can observe your IP address and requested URLs; documents are not uploaded.\n',
      );
    const format = values.format ?? inferOutputFormat(values.output) ?? 'epub';
    if (!isFormat(format))
      throw new UsageError(`Unknown format. Choose ${FORMATS.join(', ')}.`);
    if (extension === '.pdf' && values['no-images'] && values['split-chapters'])
      throw new UsageError(
        '--no-images applies to PDF input; --split-chapters applies only to existing EPUB input.',
      );
    if (values['split-chapters'] && extension !== '.epub')
      throw new UsageError(
        '--split-chapters applies only to existing EPUB input.',
      );
    if (extension === '.epub') {
      if (format !== 'epub')
        throw new UsageError('EPUB input supports shrinking to EPUB only.');
      const allowed = new Set([
        'format',
        'output',
        'force',
        'max-image-size',
        'image-format',
        'image-quality',
        'split-chapters',
        'runtime-dir',
        'offline',
        'verbose',
        'debug-pipeline',
        'debug-pipeline-assets',
      ]);
      for (const key of Object.keys(values))
        if (!allowed.has(key))
          throw new UsageError(
            `--${key} is not supported when shrinking EPUB input; book content and metadata are preserved.`,
          );
    }
    const formulaMode =
      values['formula-mode'] ?? (format === 'epub' ? 'mathml' : 'source');
    if (!isFormulaMode(formulaMode))
      throw new UsageError(
        'Formula mode must be source, mathml, katex, or disabled.',
      );
    const pdfTables = parsePdfTableSignals(values['pdf-tables']);
    const crop = parsePdfCrop(values['crop-top'], values['crop-bottom']);
    const removedCandidateIds = parseFurnitureIds(values['remove-furniture']);
    const retainedCandidateIds = parseFurnitureIds(values['keep-furniture']);
    const unwrapFactor = parseUnwrapFactor(values['unwrap-factor']);
    const dehyphenate = parseDehyphenate(values.dehyphenate);
    const chapterDetectionMode = parseChapterDetectionMode(
      values['chapter-detection'],
    );
    const chapterDetection: ChapterDetectionOptions = {
      ...DEFAULT_CHAPTER_DETECTION,
      mode: chapterDetectionMode,
    };
    const chapterDetectionResult = validateChapterDetection(chapterDetection);
    if (!chapterDetectionResult.valid)
      throw new UsageError(
        `Invalid chapter detection options: ${chapterDetectionResult.issues[0]?.message ?? 'unknown error'}`,
      );
    const chapterMark = parseChapterMark(values['chapter-mark']);
    const chapterSplitLevel = parseChapterSplitLevel(
      values['chapter-split-level'],
    );
    const tocSource = parseTocSource(
      values['toc-source'],
      values['no-chapters-in-toc'] ?? false,
      values['no-toc-embedded'] ?? false,
    );
    const tocThreshold = parseTocLimit(
      values['toc-threshold'],
      6,
      'toc-threshold',
    );
    const maxTocLinks = parseTocLimit(
      values['max-toc-links'],
      50,
      'max-toc-links',
    );
    const tocFilter = parseTocFilter(values['toc-filter']);
    const tocTitle = values['toc-title'];
    if (tocTitle !== undefined && tocTitle.length > 200)
      throw new UsageError('--toc-title must be at most 200 characters.');
    if (values['toc-at-end'] && !values['toc-inline'])
      throw new UsageError('--toc-at-end requires --toc-inline.');
    const startReadingAt = values['start-reading-at'];
    if (startReadingAt !== undefined && startReadingAt.length > 200)
      throw new UsageError(
        '--start-reading-at must be at most 200 characters.',
      );
    if (startReadingAt !== undefined && !startReadingAt.trim())
      throw new UsageError('--start-reading-at must not be empty.');
    if (
      extension !== '.pdf' &&
      (values['toc-source'] !== undefined ||
        values['use-auto-toc'] ||
        values['no-chapters-in-toc'] ||
        values['toc-threshold'] !== undefined ||
        values['max-toc-links'] !== undefined ||
        values['duplicate-links-in-toc'] ||
        values['no-toc-embedded'] ||
        values['toc-filter'] !== undefined)
    )
      throw new UsageError(
        'PDF TOC source and link options require PDF input.',
      );
    if (values['use-auto-toc'] && tocSource === 'off')
      throw new UsageError(
        '--use-auto-toc cannot be combined with --no-chapters-in-toc or --toc-source off.',
      );
    const maxImageSize = parseMaxImageSize(values['max-image-size']);
    const epubMaxImageDimensions = parseEpubImageDimensions(
      values['epub-max-image-size'],
    );
    const requestedCoverPolicy = parseCoverPolicy(values['cover-policy']);
    if (
      values['no-default-epub-cover'] &&
      requestedCoverPolicy !== undefined &&
      requestedCoverPolicy !== 'none'
    )
      throw new UsageError(
        '--no-default-epub-cover cannot be combined with a non-none --cover-policy.',
      );
    const coverPolicy: EpubCoverPolicy =
      values['no-default-epub-cover'] === true
        ? 'none'
        : (requestedCoverPolicy ??
          (values.cover
            ? 'file'
            : values['frontpage-cover']
              ? 'generated'
              : 'none'));
    const maxChapterSizeBytes = parseFlowSize(values['flow-size']);
    const splitOnPageBreaks = values['split-on-page-breaks'] ?? false;
    if (
      (values['flow-size'] !== undefined || splitOnPageBreaks) &&
      format !== 'epub'
    )
      throw new UsageError(
        '--flow-size and --split-on-page-breaks apply only to EPUB output.',
      );
    if (
      extension === '.epub' &&
      (values['flow-size'] !== undefined || splitOnPageBreaks)
    )
      throw new UsageError(
        '--flow-size and --split-on-page-breaks apply only to semantic EPUB conversion.',
      );
    const imageFormat = values['image-format'] ?? 'jpeg';
    if (imageFormat !== 'jpeg' && imageFormat !== 'preserve')
      throw new UsageError('--image-format must be jpeg or preserve.');
    const imageQuality = Number(
      values['image-quality'] ?? DEFAULT_EPUB_IMAGE_QUALITY,
    );
    if (
      !/^\d+$/.test(values['image-quality'] ?? '80') ||
      !Number.isInteger(imageQuality) ||
      imageQuality < 1 ||
      imageQuality > 100
    )
      throw new UsageError('--image-quality must be an integer from 1 to 100.');
    if (
      (values['max-image-size'] !== undefined ||
        values['epub-max-image-size'] !== undefined ||
        values['image-format'] !== undefined ||
        values['image-quality'] !== undefined) &&
      format !== 'epub'
    )
      throw new UsageError('Image encoding options apply only to EPUB output.');
    if (
      (values.cover !== undefined ||
        values['cover-policy'] !== undefined ||
        values['no-default-epub-cover'] ||
        values['preserve-cover-aspect-ratio'] ||
        values['extra-css'] !== undefined ||
        startReadingAt !== undefined) &&
      format !== 'epub'
    )
      throw new UsageError(
        'EPUB cover and navigation options apply only to EPUB output.',
      );
    if (values.cover && coverPolicy !== 'file')
      throw new UsageError('--cover requires --cover-policy file.');
    if (coverPolicy === 'file' && !values.cover)
      throw new UsageError('--cover-policy file requires --cover <path>.');
    if (coverPolicy === 'source' && extension !== '.pdf')
      throw new UsageError('--cover-policy source requires PDF input.');
    if (
      extension === '.epub' &&
      (values.cover !== undefined ||
        values['epub-max-image-size'] !== undefined ||
        values['cover-policy'] !== undefined ||
        values['no-default-epub-cover'] ||
        values['preserve-cover-aspect-ratio'] ||
        values['extra-css'] !== undefined ||
        startReadingAt !== undefined)
    )
      throw new UsageError(
        'EPUB styling, cover, image-cap, and navigation options apply only to semantic EPUB conversion.',
      );
    if (values['frontpage-cover'] && format !== 'epub')
      throw new UsageError('--frontpage-cover applies only to EPUB output.');
    if (values.cover && values['frontpage-cover'])
      throw new UsageError('--cover and --frontpage-cover cannot be combined.');
    if (
      values['frontpage-cover'] &&
      ((requestedCoverPolicy !== undefined &&
        requestedCoverPolicy !== 'generated') ||
        values['no-default-epub-cover'])
    )
      throw new UsageError(
        '--frontpage-cover cannot be combined with a non-generated cover policy.',
      );
    const conversionDate =
      values['conversion-date'] ?? new Date().toISOString();
    if (!isIsoDate(conversionDate))
      throw new UsageError(
        'Conversion date must be a valid ISO date or UTC timestamp.',
      );
    if (values.language) {
      try {
        values.language = normalizeLanguageTag(values.language);
      } catch {
        throw new UsageError('Language must be a valid BCP 47 language tag.');
      }
    }
    const publicationDate =
      values.pubdate !== undefined
        ? normalizeCliDate(values.pubdate, '--pubdate')
        : undefined;
    const sourceCreatedAt =
      values['source-created-at'] !== undefined
        ? normalizeCliDate(values['source-created-at'], '--source-created-at')
        : undefined;
    const sourceModifiedAt =
      values['source-modified-at'] !== undefined
        ? normalizeCliDate(values['source-modified-at'], '--source-modified-at')
        : undefined;
    const seriesIndex =
      values['series-index'] !== undefined
        ? parseSeriesIndex(values['series-index'])
        : undefined;
    const sceneBreaks = parseToggle(
      values['scene-breaks'],
      true,
      'scene-breaks',
    );
    const blankParagraphs = parseToggle(
      values['blank-paragraphs'],
      true,
      'blank-paragraphs',
    );
    const sceneBreakMarker = parseSceneBreakMarker(
      values['replace-scene-breaks'],
    );
    if (sceneBreakMarker && !sceneBreaks)
      throw new UsageError(
        '--replace-scene-breaks cannot be combined with --scene-breaks off.',
      );
    if (values['smarten-punctuation'] && values['unsmarten-punctuation'])
      throw new UsageError(
        '--smarten-punctuation and --unsmarten-punctuation cannot be combined.',
      );
    const textNormalization: TextNormalizationOptions = {
      sceneBreaks,
      blankParagraphs,
      ligatures: !(values['keep-ligatures'] ?? false),
      smartenPunctuation: values['smarten-punctuation'] ?? false,
      unsmartenPunctuation: values['unsmarten-punctuation'] ?? false,
      ...(sceneBreakMarker ? { sceneBreakMarker } : {}),
      ...(values.language ? { language: values.language } : {}),
    };
    for (const text of [
      values.title,
      values.subtitle,
      values['title-sort'],
      values['author-sort'],
      values.publisher,
      values.description,
      values['book-version'],
      values.rights,
      values.series,
      values['book-producer'],
      values.isbn,
      values.identifier,
      ...(values.author ?? []),
      ...(values.subject ?? []),
      ...(values.contributor ?? []),
    ])
      if (text !== undefined && !text.trim())
        throw new UsageError('Metadata overrides must not be empty.');
    const presetPath = values['style-preset'];
    const provider = values['execution-provider'] ?? 'auto';
    if (provider !== 'auto' && !isExecutionProvider(provider))
      throw new UsageError(
        'Execution provider must be auto, cpu, coreml, or webgpu.',
      );
    if (values['no-layout'] && values['layout-model'])
      throw new UsageError(
        '--no-layout cannot be combined with --layout-model.',
      );
    if (values['no-images'] && extension === '.pdf' && !values['no-layout'])
      throw new UsageError(
        '--no-images cannot be combined with layout analysis; add --no-layout.',
      );
    if (values['no-remove-furniture'] && removedCandidateIds.length > 0)
      throw new UsageError(
        '--no-remove-furniture cannot be combined with --remove-furniture.',
      );
    if (removedCandidateIds.some((id) => retainedCandidateIds.includes(id)))
      throw new UsageError(
        'A furniture candidate cannot be both removed and kept.',
      );
    if (values['list-furniture'] && (values.output || values.format))
      throw new UsageError(
        '--list-furniture writes candidates to stdout and cannot be combined with --output or --format.',
      );
    if (
      values['execution-provider'] &&
      provider !== 'auto' &&
      values['no-layout'] &&
      !values['formula-ocr'] &&
      !values['formula-model-dir']
    )
      throw new UsageError(
        '--execution-provider requires layout analysis or formula OCR.',
      );
    if (
      extension !== '.pdf' &&
      (values.rasterize ||
        values['layout-model'] ||
        values['formula-model-dir'] ||
        values['formula-ocr'] ||
        values['no-layout'] ||
        values['execution-provider'] ||
        values['no-images'] ||
        values['no-remove-furniture'] ||
        values['remove-furniture'] !== undefined ||
        values['keep-furniture'] !== undefined ||
        values['crop-top'] !== undefined ||
        values['crop-bottom'] !== undefined ||
        values['list-furniture'] ||
        values['unwrap-factor'] !== undefined ||
        values.dehyphenate !== undefined ||
        values['header-regex'] !== undefined ||
        values['footer-regex'] !== undefined)
    )
      throw new UsageError(
        'PDF rendering, analysis, and extraction options require PDF input.',
      );
    if (values['frontpage-cover'] && extension !== '.pdf')
      throw new UsageError('--frontpage-cover requires PDF input.');
    if (values['remove-first-image'] && extension !== '.pdf')
      throw new UsageError('--remove-first-image requires PDF input.');
    if (values['chapter-detection'] !== undefined && extension !== '.pdf')
      throw new UsageError('--chapter-detection requires PDF input.');
    if (values['pdf-tables'] && extension !== '.pdf')
      throw new UsageError('--pdf-tables requires PDF input.');
    if (
      values['list-furniture'] &&
      (values['split-chapters'] ||
        values['frontpage-cover'] ||
        values['remove-first-image'] ||
        values.cover !== undefined)
    )
      throw new UsageError(
        '--list-furniture cannot be combined with output, cover, or image-removal options.',
      );
    if (
      (values['unwrap-factor'] !== undefined ||
        values.dehyphenate !== undefined) &&
      extension !== '.pdf'
    )
      throw new UsageError('PDF text-reflow options require PDF input.');
    if (presetPath && extension !== '.docx')
      throw new UsageError('Style presets apply only to DOCX input.');
    const output =
      values.output ??
      join(
        dirname(input),
        `${basename(input, extname(input))}${extension === '.epub' ? '.shrunk' : ''}${EXTENSIONS[format]}`,
      );
    if (output !== '-') {
      await protectSource(input, output);
      if (presetPath) await protectSource(presetPath, output);
      if (values.metadata) await protectSource(values.metadata, output);
      if (values.cover) await protectSource(values.cover, output);
      if (values['search-replace'])
        await protectSource(values['search-replace'], output);
      if (values['layout-model'])
        await protectSource(values['layout-model'], output);
      if (values['formula-model-dir'])
        for (const file of ['encoder.onnx', 'decoder.onnx', 'tokenizer.json'])
          await protectSource(join(values['formula-model-dir'], file), output);
    }
    let stylePreset: Record<string, StyleMapping> | undefined;
    const metadataSidecar = values.metadata
      ? await loadMetadataSidecar(values.metadata)
      : undefined;
    if (presetPath) {
      const preset = importStylePreset(
        new TextDecoder().decode(await readBounded(presetPath, 1024 * 1024)),
      );
      if (!preset.ok || !preset.mappings)
        throw new UsageError(preset.error ?? 'Invalid style preset.');
      stylePreset = preset.mappings;
    }
    if (values['search-replace']) {
      try {
        let rulesBytes: Uint8Array;
        try {
          rulesBytes = await readBounded(
            values['search-replace'],
            MAX_TEXT_PATTERN_FILE_BYTES,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith('File exceeds the ')
          )
            throw new UsageError(
              `Search/replace rules file exceeds ${MAX_TEXT_PATTERN_FILE_BYTES} bytes.`,
            );
          throw error;
        }
        textNormalization.textRules = parseTextPatternRules(
          new TextDecoder('utf-8', { fatal: true }).decode(rulesBytes),
        );
      } catch (error) {
        if (error instanceof PatternRulesFileError)
          throw new UsageError(error.message);
        if (error instanceof TypeError)
          throw new UsageError(
            'Search/replace rules file must be valid UTF-8.',
          );
        throw error;
      }
    }
    const verbose = Math.max(
      requestedVerbose,
      values['debug-pipeline'] ? 1 : 0,
    );
    const pipelineRequest = {
      input: sanitizeBasename(input),
      inputFormat: extension.slice(1),
      output: output === '-' ? '-' : sanitizeBasename(output),
      outputFormat: format,
      options: {
        conversionDate: extension === '.epub' ? null : conversionDate,
        formulaMode: extension === '.epub' ? null : formulaMode,
        maxImageSize,
        epubMaxImageDimensions: epubMaxImageDimensions ?? null,
        imageFormat,
        imageQuality,
        splitChapters: values['split-chapters'] ?? false,
        force: values.force ?? false,
        verbose,
        debugPipeline: Boolean(values['debug-pipeline']),
        debugPipelineAssets: Boolean(values['debug-pipeline-assets']),
        layout:
          extension === '.pdf'
            ? values['no-layout'] ||
              (values['list-furniture'] && !values['layout-model'])
              ? 'disabled'
              : 'automatic'
            : 'not-used',
        layoutModel: values['layout-model']
          ? sanitizeBasename(values['layout-model'])
          : null,
        formulaOcr: Boolean(
          values['formula-ocr'] || values['formula-model-dir'],
        ),
        formulaModelDirectory: values['formula-model-dir']
          ? sanitizeBasename(values['formula-model-dir'])
          : null,
        executionProvider:
          extension === '.pdf'
            ? (values['execution-provider'] ?? 'auto')
            : 'not-used',
        rasterize: values.rasterize ?? false,
        frontPageCover: values['frontpage-cover'] ?? false,
        removeFirstImage: values['remove-first-image'] ?? false,
        crop: extension === '.pdf' ? (crop ?? null) : null,
        removeDetectedFurniture:
          extension === '.pdf'
            ? !(values['no-remove-furniture'] ?? false)
            : null,
        removedCandidateIds: extension === '.pdf' ? removedCandidateIds : [],
        retainedCandidateIds: extension === '.pdf' ? retainedCandidateIds : [],
        extractImages:
          extension === '.pdf' ? !(values['no-images'] ?? false) : null,
        listFurniture: values['list-furniture'] ?? false,
        pdfTables:
          extension === '.pdf'
            ? (pdfTables ?? { tagged: true, ruled: true, borderless: false })
            : null,
        unwrapFactor: extension === '.pdf' ? (unwrapFactor ?? 0.45) : null,
        dehyphenate: extension === '.pdf' ? (dehyphenate ?? false) : null,
        textNormalization: {
          sceneBreaks,
          blankParagraphs,
          ligatures: !(values['keep-ligatures'] ?? false),
          smartenPunctuation: values['smarten-punctuation'] ?? false,
          unsmartenPunctuation: values['unsmarten-punctuation'] ?? false,
          ...(sceneBreakMarker ? { sceneBreakMarker } : {}),
          ...(values.language ? { language: values.language } : {}),
        },
        searchReplaceRuleCount: textNormalization.textRules?.length ?? 0,
        headerPattern: Boolean(values['header-regex']),
        footerPattern: Boolean(values['footer-regex']),
        chapterDetection: extension === '.pdf' ? chapterDetection : null,
        chapterMark,
        chapterSplitLevel,
        toc:
          extension === '.pdf'
            ? {
                source: tocSource,
                threshold: tocThreshold,
                maxLinks: maxTocLinks,
                duplicateLinks: values['duplicate-links-in-toc'] ?? false,
                useAutoToc: values['use-auto-toc'] ?? false,
                ...(tocFilter ? { filter: tocFilter } : {}),
              }
            : null,
        tocTitle: tocTitle ?? null,
        inlineToc: values['toc-inline'] ?? false,
        tocAtEnd: values['toc-at-end'] ?? false,
        coverPolicy,
        preserveCoverAspectRatio:
          values['preserve-cover-aspect-ratio'] ?? false,
        extraCss: values['extra-css']
          ? sanitizeBasename(values['extra-css'])
          : null,
        startReadingAt: sanitizeRequestText(startReadingAt),
        stylePreset: presetPath ? sanitizeBasename(presetPath) : null,
        cover: values.cover ? sanitizeBasename(values.cover) : null,
        title: sanitizeRequestText(values.title),
        authors: (values.author ?? []).map(sanitizeRequestText),
        language: sanitizeRequestText(values.language),
        identifier: sanitizeRequestText(values.identifier),
        includeExternalImages: values['include-external-images'] ?? false,
        offline: values.offline ?? false,
        runtimeConfigured: Boolean(values['runtime-dir']),
      },
    };
    const pipelineDump = values['debug-pipeline']
      ? await createPipelineDebugDump({
          directory: values['debug-pipeline'],
          input,
          output,
          cwd: process.cwd(),
          force: values.force ?? false,
          includeAssets: values['debug-pipeline-assets'] ?? false,
          request: pipelineRequest,
          warn: io.stderr,
        })
      : undefined;
    const diagnostics = new CliStageDiagnostics(verbose);
    const onStage = (event: PipelineStageEvent): void => {
      pipelineDump?.onStage(event);
      diagnostics.record(event);
    };
    if (pipelineDump && extension !== '.pdf') {
      const reason =
        extension === '.epub'
          ? 'Existing EPUB shrinking preserves its archive and does not create a raw reader stage.'
          : extension === '.docx'
            ? 'The DOCX reader does not expose a raw OOXML stage.'
            : 'Text inputs are parsed directly into the semantic model.';
      pipelineDump.onStage({
        stage: 'raw',
        data: { status: 'not-applicable', reason },
      });
      pipelineDump.onStage({
        stage: 'analysis',
        data: {
          status: 'not-applicable',
          reason:
            'This input format does not expose a separate analysis summary.',
        },
      });
    }
    if (extension === '.epub') {
      const { shrinkEpub, MAX_EPUB_INPUT_BYTES } =
        await import('./shrink-epub.ts');
      const bytes = await readBounded(input, MAX_EPUB_INPUT_BYTES);
      const { createImageResizer } = await import('./image-resizer.ts');
      const resize =
        maxImageSize > 0
          ? createImageResizer(values['runtime-dir'])
          : undefined;
      const data = await shrinkEpub(bytes, {
        maxDimension: maxImageSize,
        format: imageFormat,
        quality: imageQuality,
        splitChapters: values['split-chapters'] ?? false,
        ...(resize ? { resize } : {}),
        ...(pipelineDump || verbose ? { onStage } : {}),
        warn: io.stderr,
      });
      if (output === '-') await io.stdout(data);
      else {
        await saveOutput(output, data, values.force ?? false);
        io.stderr(`Written ${output}\n`);
      }
      const percent = Math.abs(100 * (1 - data.length / bytes.length)).toFixed(
        1,
      );
      io.stderr(
        `EPUB size: ${bytes.length} -> ${data.length} bytes (${percent}% ${data.length <= bytes.length ? 'smaller' : 'larger'}).\n`,
      );
      if (pipelineDump)
        pipelineDump.onStage({
          stage: 'model',
          data: {
            status: 'not-applicable',
            reason:
              'Existing EPUB shrinking does not construct a semantic DocumentModel.',
          },
        });
      diagnostics.report(io.stderr, pipelineRequest);
      return 0;
    }
    const bytes = await readBounded(input, MAX_INPUT_BYTES);
    let layoutModel = values['layout-model'];
    let formulaModelDir = values['formula-model-dir'];
    if (extension === '.pdf') {
      const needsLayout =
        !values['no-layout'] &&
        (!values['list-furniture'] || Boolean(layoutModel));
      const needsFormula = values['formula-ocr'] || Boolean(formulaModelDir);
      if (
        needsLayout ||
        needsFormula ||
        values.rasterize ||
        values['frontpage-cover']
      ) {
        // Resolve native libraries before downloading any model assets.
        (await import('./native-runtime.ts')).loadNativeRuntime(
          values['runtime-dir'],
        );
      }
      const downloadOptions = {
        offline: values.offline ?? false,
        warn: io.stderr,
      };
      if (needsLayout && !layoutModel)
        layoutModel = await ensureModel(
          cacheDirectory,
          MODEL_FILES.heron,
          downloadOptions,
        );
      if (needsFormula && !formulaModelDir) {
        for (const file of [
          MODEL_FILES.encoder,
          MODEL_FILES.decoder,
          MODEL_FILES.tokenizer,
        ])
          await ensureModel(cacheDirectory, file, downloadOptions);
        formulaModelDir = cacheDirectory;
      }
      if (output !== '-') {
        if (layoutModel) await protectSource(layoutModel, output);
        if (formulaModelDir)
          for (const file of ['encoder.onnx', 'decoder.onnx', 'tokenizer.json'])
            await protectSource(join(formulaModelDir, file), output);
      }
    }
    const options = { conversionDate, textNormalization };
    const filename = basename(input);
    let model: DocumentModel;
    let coverPng: Uint8Array | undefined;
    if (extension === '.docx')
      model = await secureDocxReader.read(bytes, {
        ...options,
        filename,
        ...(stylePreset ? { stylePreset } : {}),
      });
    else if (extension !== '.pdf')
      model = await (
        await import('./text.ts')
      ).readLocalText(
        bytes,
        input,
        ['.md', '.markdown'].includes(extension) ? 'markdown' : 'html',
        conversionDate,
        output === '-' ? undefined : (path) => protectSource(path, output),
        values['include-external-images'] ?? false,
        io.stderr,
        textNormalization,
      );
    else {
      const pdfResult = await (
        await import('./pdf.ts')
      ).readPdf(bytes, filename, {
        ...options,
        executionProvider: provider,
        onDiagnostic: io.stderr,
        ...(crop ? { crop } : {}),
        ...(values['no-remove-furniture']
          ? { removeDetectedFurniture: false }
          : {}),
        ...(removedCandidateIds.length > 0 ? { removedCandidateIds } : {}),
        ...(retainedCandidateIds.length > 0 ? { retainedCandidateIds } : {}),
        ...(values['no-images'] ? { extractImages: false } : {}),
        ...(values['list-furniture'] ? { listFurniture: true } : {}),
        ...(values.rasterize ? { rasterize: true } : {}),
        ...(values['frontpage-cover'] ? { frontPageCover: true } : {}),
        ...(values['remove-first-image'] ? { removeFirstImage: true } : {}),
        ...(pdfTables ? { pdfTables } : {}),
        ...(unwrapFactor !== undefined ? { unwrapFactor } : {}),
        ...(dehyphenate !== undefined ? { dehyphenate } : {}),
        ...(values['header-regex'] !== undefined
          ? { headerPattern: values['header-regex'] }
          : {}),
        ...(values['footer-regex'] !== undefined
          ? { footerPattern: values['footer-regex'] }
          : {}),
        chapterDetection,
        chapterSplitLevel,
        toc: {
          source: tocSource,
          threshold: tocThreshold,
          maxLinks: maxTocLinks,
          duplicateLinks: values['duplicate-links-in-toc'] ?? false,
          useAutoToc: values['use-auto-toc'] ?? false,
          ...(tocFilter ? { filter: tocFilter } : {}),
        },
        ...(layoutModel ? { layoutModel } : {}),
        ...(formulaModelDir ? { formulaModelDir } : {}),
        ...(values['runtime-dir'] ? { runtimeDir: values['runtime-dir'] } : {}),
        ...(pipelineDump || verbose
          ? {
              onStage: (event) => {
                if (event.stage !== 'model') onStage(event);
              },
            }
          : {}),
      });
      model = pdfResult.model;
      coverPng = pdfResult.coverPng;
      const foundCandidateIds = new Set(
        pdfResult.analysis.candidates.map(({ id }) => id),
      );
      const unknownCandidateIds = [
        ...removedCandidateIds,
        ...retainedCandidateIds,
      ].filter((id) => !foundCandidateIds.has(id));
      if (unknownCandidateIds.length > 0)
        throw new UsageError(
          `Unknown PDF furniture candidate id${unknownCandidateIds.length === 1 ? '' : 's'}: ${unknownCandidateIds.join(', ')}.`,
        );
      diagnostics.setModelSelection({
        provider: pdfResult.executionProvider ?? 'not-initialized',
        layout: layoutModel ? sanitizeBasename(layoutModel) : 'disabled',
        formula: formulaModelDir
          ? sanitizeBasename(formulaModelDir)
          : 'disabled',
      });
      if (values['list-furniture']) {
        for (const warning of model.warnings)
          io.stderr(
            `${warning.severity} [${warning.code}]: ${warning.message}\n`,
          );
        await io.stdout(formatFurnitureCandidates(pdfResult.analysis));
        diagnostics.report(io.stderr, pipelineRequest);
        return 0;
      }
    }
    if (metadataSidecar)
      model.metadata = applyMetadataSidecar(model.metadata, metadataSidecar);
    for (const [option, field] of [
      ['title', 'title'],
      ['subtitle', 'subtitle'],
      ['title-sort', 'titleSort'],
      ['author-sort', 'authorSort'],
      ['language', 'language'],
      ['publisher', 'publisher'],
      ['description', 'description'],
      ['book-version', 'version'],
      ['rights', 'rights'],
      ['series', 'series'],
      ['book-producer', 'bookProducer'],
      ['identifier', 'identifier'],
      ['isbn', 'isbn'],
    ] as const) {
      const value = values[option];
      if (value !== undefined)
        Object.assign(model.metadata, { [field]: userValue(value) });
    }
    if (publicationDate !== undefined)
      model.metadata.publicationDate = userValue(publicationDate);
    if (sourceCreatedAt !== undefined)
      model.metadata.sourceCreatedAt = userValue(sourceCreatedAt);
    if (sourceModifiedAt !== undefined)
      model.metadata.sourceModifiedAt = userValue(sourceModifiedAt);
    if (seriesIndex !== undefined)
      model.metadata.seriesIndex = userValue(seriesIndex);
    if (values.subject !== undefined)
      model.metadata.subjects = values.subject.map((subject) =>
        userValue(subject),
      );
    const authorSort = values['author-sort'];
    if (values.author !== undefined)
      model.metadata.authors = values.author.map((name) =>
        userValue({
          name,
          ...(authorSort !== undefined ? { sortAs: authorSort } : {}),
        }),
      );
    else if (authorSort !== undefined) {
      model.metadata.authors = model.metadata.authors.map(({ value }) =>
        userValue({ ...value, sortAs: authorSort }),
      );
    }
    if (values.contributor !== undefined)
      model.metadata.contributors = values.contributor.map((name) =>
        userValue({ name, role: 'ctb' }),
      );
    if (values.language === undefined) {
      try {
        const language = model.metadata.language?.value;
        if (!language) throw new RangeError();
        const normalized = normalizeLanguageTag(language);
        if (normalized !== language && model.metadata.language)
          model.metadata.language = {
            ...model.metadata.language,
            value: normalized,
          };
      } catch {
        model.metadata.language = {
          value: 'en',
          provenance: {
            source: 'CLI default language',
            method: 'default',
            confidence: 'low',
            reason:
              'Document language is missing or invalid; override with --language.',
          },
        };
        io.stderr(
          'warning: Document language is missing or invalid; using en. Override with --language if needed.\n',
        );
      }
    }
    const isbn = model.metadata.isbn?.value;
    if (isbn && !isValidIsbn(isbn)) {
      const message =
        'ISBN checksum is invalid; verify the ISBN-10 or ISBN-13 value.';
      if (values['strict-isbn']) throw new UsageError(message);
      io.stderr(`warning: ${message}\n`);
    }
    if (
      model.metadata.seriesIndex !== undefined &&
      !model.metadata.series?.value.trim()
    )
      throw new UsageError('--series-index requires a series name.');
    if (model.metadata.authorSort && model.metadata.authors.length === 0)
      throw new UsageError('--author-sort requires at least one author.');
    const cover = values.cover
      ? await readCover(values.cover, model)
      : undefined;
    let extraCss: string | undefined;
    if (values['extra-css']) {
      if (output !== '-') await protectSource(values['extra-css'], output);
      let extraCssBytes: Uint8Array;
      try {
        extraCssBytes = await readBounded(
          values['extra-css'],
          MAX_EPUB_EXTRA_CSS_BYTES,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('File exceeds the ')
        )
          throw new UsageError(
            `Extra CSS file exceeds ${MAX_EPUB_EXTRA_CSS_BYTES} bytes.`,
          );
        throw error;
      }
      try {
        extraCss = new TextDecoder('utf-8', { fatal: true }).decode(
          extraCssBytes,
        );
      } catch {
        throw new UsageError('--extra-css must be a valid UTF-8 file.');
      }
    }
    if (pipelineDump || verbose) onStage({ stage: 'model', data: model });
    const data = await render(model, format, conversionDate, formulaMode, {
      maxImageSize,
      ...(epubMaxImageDimensions
        ? { maxImageDimensions: epubMaxImageDimensions }
        : {}),
      imageFormat,
      imageQuality,
      maxChapterSizeBytes,
      splitOnPageBreaks,
      chapterMark,
      chapterSplitLevel,
      tocTitle,
      inlineToc: values['toc-inline'] ?? false,
      tocAtEnd: values['toc-at-end'] ?? false,
      coverPolicy,
      preserveCoverAspectRatio: values['preserve-cover-aspect-ratio'] ?? false,
      ...(extraCss !== undefined ? { extraCss } : {}),
      ...(startReadingAt ? { startReadingAt } : {}),
      runtimeDir: values['runtime-dir'],
      warn: io.stderr,
      ...(cover ? { cover } : {}),
      ...(coverPng ? { coverPng } : {}),
      ...(pipelineDump || verbose ? { onStage } : {}),
    });
    for (const warning of model.warnings)
      io.stderr(`${warning.severity} [${warning.code}]: ${warning.message}\n`);
    if (output === '-') await io.stdout(data);
    else {
      await saveOutput(output, data, values.force ?? false);
      io.stderr(`Written ${output}\n`);
    }
    diagnostics.report(io.stderr, pipelineRequest);
    return 0;
  } catch (error) {
    const code =
      error instanceof UsageError || error instanceof PipelineDebugUsageError
        ? 2
        : 1;
    const message = isConversionError(error)
      ? `[${error.code}] ${error.message}`
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown conversion failure.';
    io.stderr(`wordconvert: ${message}\n`);
    return code;
  }
}

function parseArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f' },
        output: { type: 'string', short: 'o' },
        force: { type: 'boolean' },
        'style-preset': { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        'title-sort': { type: 'string' },
        'author-sort': { type: 'string' },
        author: { type: 'string', multiple: true },
        publisher: { type: 'string' },
        description: { type: 'string' },
        subject: { type: 'string', multiple: true },
        'book-version': { type: 'string' },
        rights: { type: 'string' },
        series: { type: 'string' },
        'series-index': { type: 'string' },
        contributor: { type: 'string', multiple: true },
        'book-producer': { type: 'string' },
        'source-created-at': { type: 'string' },
        'source-modified-at': { type: 'string' },
        pubdate: { type: 'string' },
        isbn: { type: 'string' },
        'strict-isbn': { type: 'boolean' },
        metadata: { type: 'string' },
        cover: { type: 'string' },
        'cover-policy': { type: 'string' },
        'no-default-epub-cover': { type: 'boolean' },
        'preserve-cover-aspect-ratio': { type: 'boolean' },
        'extra-css': { type: 'string' },
        'epub-max-image-size': { type: 'string' },
        'start-reading-at': { type: 'string' },
        'frontpage-cover': { type: 'boolean' },
        'remove-first-image': { type: 'boolean' },
        'crop-top': { type: 'string' },
        'crop-bottom': { type: 'string' },
        'no-remove-furniture': { type: 'boolean' },
        'remove-furniture': { type: 'string', multiple: true },
        'keep-furniture': { type: 'string', multiple: true },
        'list-furniture': { type: 'boolean' },
        'no-images': { type: 'boolean' },
        'unwrap-factor': { type: 'string' },
        dehyphenate: { type: 'string' },
        'search-replace': { type: 'string' },
        'header-regex': { type: 'string' },
        'footer-regex': { type: 'string' },
        'scene-breaks': { type: 'string' },
        'blank-paragraphs': { type: 'string' },
        'keep-ligatures': { type: 'boolean' },
        'smarten-punctuation': { type: 'boolean' },
        'unsmarten-punctuation': { type: 'boolean' },
        'replace-scene-breaks': { type: 'string' },
        'chapter-detection': { type: 'string' },
        'chapter-mark': { type: 'string' },
        'chapter-split-level': { type: 'string' },
        'flow-size': { type: 'string' },
        'split-on-page-breaks': { type: 'boolean' },
        'toc-source': { type: 'string' },
        'use-auto-toc': { type: 'boolean' },
        'no-chapters-in-toc': { type: 'boolean' },
        'toc-threshold': { type: 'string' },
        'max-toc-links': { type: 'string' },
        'duplicate-links-in-toc': { type: 'boolean' },
        'no-toc-embedded': { type: 'boolean' },
        'toc-filter': { type: 'string' },
        'toc-title': { type: 'string' },
        'toc-inline': { type: 'boolean' },
        'toc-at-end': { type: 'boolean' },
        language: { type: 'string' },
        identifier: { type: 'string' },
        'formula-mode': { type: 'string' },
        'conversion-date': { type: 'string' },
        'max-image-size': { type: 'string' },
        'image-format': { type: 'string' },
        'image-quality': { type: 'string' },
        'split-chapters': { type: 'boolean' },
        rasterize: { type: 'boolean' },
        'pdf-tables': { type: 'string' },
        'no-layout': { type: 'boolean' },
        'formula-ocr': { type: 'boolean' },
        offline: { type: 'boolean' },
        'include-external-images': { type: 'boolean' },
        'model-cache-dir': { type: 'string' },
        'clear-model-cache': { type: 'boolean' },
        'layout-model': { type: 'string' },
        'formula-model-dir': { type: 'string' },
        'execution-provider': { type: 'string' },
        'runtime-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        verbose: { type: 'boolean', multiple: true },
        'debug-pipeline': { type: 'string' },
        'debug-pipeline-assets': { type: 'boolean' },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
}

function isFormat(value: string): value is Format {
  return FORMATS.some((format) => format === value);
}

function inferOutputFormat(output: string | undefined): Format | undefined {
  if (!output || output === '-') return undefined;
  const filename = output.toLowerCase();
  if (filename.endsWith('.html.zip')) return 'html-zip';
  if (filename.endsWith('.md.zip') || filename.endsWith('.markdown.zip'))
    return 'markdown-zip';
  if (filename.endsWith('.epub')) return 'epub';
  if (filename.endsWith('.html') || filename.endsWith('.htm')) return 'html';
  if (filename.endsWith('.md') || filename.endsWith('.markdown'))
    return 'markdown';
  if (filename.endsWith('.zip'))
    throw new UsageError(
      'Use --format html-zip or markdown-zip for an output ending in .zip, or use .html.zip/.md.zip.',
    );
  return undefined;
}
const PDF_TABLE_SIGNALS = ['tagged', 'ruled', 'borderless'] as const;

/**
 * `--pdf-tables` takes a comma-separated subset of the table signals, or
 * `none`. Signals not named are turned off, so the option can narrow as well
 * as widen what the reader is allowed to infer.
 */
function parseUnwrapFactor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    throw new UsageError('--unwrap-factor must be a number from 0 to 1.');
  }
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor < 0 || factor > 1)
    throw new UsageError('--unwrap-factor must be a number from 0 to 1.');
  return factor;
}

function parseDehyphenate(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new UsageError('--dehyphenate must be on or off.');
}

function parseToggle(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new UsageError(`--${name} must be on or off.`);
}

function parseSceneBreakMarker(
  value: string | undefined,
): TextNormalizationOptions['sceneBreakMarker'] {
  if (value === undefined) return undefined;
  if (
    value === 'asterisks' ||
    value === 'dots' ||
    value === 'floral' ||
    value === 'em-dash'
  )
    return value;
  throw new UsageError(
    '--replace-scene-breaks must be asterisks, dots, floral, or em-dash.',
  );
}

function parsePdfCrop(
  topValue: string | undefined,
  bottomValue: string | undefined,
): Partial<{ top: number; bottom: number }> | undefined {
  const crop: Partial<{ top: number; bottom: number }> = {};
  for (const [option, value, edge] of [
    ['--crop-top', topValue, 'top'],
    ['--crop-bottom', bottomValue, 'bottom'],
  ] as const) {
    if (value === undefined) continue;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
      throw new UsageError(`${option} must be a fraction from 0 to 1.`);
    }
    const fraction = Number(value);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
      throw new UsageError(`${option} must be a fraction from 0 to 1.`);
    crop[edge] = fraction;
  }
  if ((crop.top ?? 0) + (crop.bottom ?? 0) >= 0.9)
    throw new UsageError(
      'PDF crop regions must leave at least 10% of each page content.',
    );
  return Object.keys(crop).length > 0 ? crop : undefined;
}

function parseFurnitureIds(values: string[] | undefined): string[] {
  if (!values) return [];
  if (values.some((id) => !id.trim()))
    throw new UsageError('Furniture candidate ids must not be empty.');
  return values;
}

function parsePdfTableSignals(value: string | undefined) {
  if (value === undefined) return undefined;
  const requested = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const none = { tagged: false, ruled: false, borderless: false };
  if (requested.length === 0) return none;
  if (requested.includes('none')) {
    if (requested.length > 1)
      throw new UsageError(
        '--pdf-tables none cannot be combined with table signals.',
      );
    return none;
  }
  for (const signal of requested)
    if (!(PDF_TABLE_SIGNALS as readonly string[]).includes(signal))
      throw new UsageError(
        `--pdf-tables accepts ${PDF_TABLE_SIGNALS.join(', ')}, or none.`,
      );
  return {
    tagged: requested.includes('tagged'),
    ruled: requested.includes('ruled'),
    borderless: requested.includes('borderless'),
  };
}

function formatFurnitureCandidates(analysis: PdfAnalysisSummary): string {
  if (analysis.candidates.length === 0)
    return 'No PDF furniture candidates detected.\n';
  const rows = [
    'id\trule\tkind\tparity\tconfidence\tparity coverage\tpages\tnormalized text\tremoved',
    ...analysis.candidates.map((candidate) =>
      [
        candidate.id,
        candidate.ruleId ?? 'automatic',
        candidate.kind,
        candidate.pageParity,
        candidate.confidence,
        `${(candidate.pageCoverage * 100).toFixed(0)}%`,
        `${candidate.pageNumbers.length}/${analysis.pageCount} [${candidate.pageNumbers.join(',')}]`,
        candidate.normalizedText,
        candidate.removed ? 'yes' : 'no',
      ].join('\t'),
    ),
  ];
  return `${rows.join('\n')}\n`;
}

function isFormulaMode(value: string): value is MathOutputMode {
  return ['source', 'mathml', 'katex', 'disabled'].includes(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value))
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) ===
      (value.length === 10 ? `${value}T00:00:00` : value.slice(0, 19))
  );
}

function normalizeCliDate(value: string, option: string): string {
  try {
    return normalizeIsoDate(value);
  } catch {
    throw new UsageError(
      `${option} must be a valid ISO 8601 date or timestamp.`,
    );
  }
}

function parseSeriesIndex(value: string): number {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    throw new UsageError(
      '--series-index must be a positive number no greater than 1000000.',
    );
  const index = Number(value);
  if (!Number.isFinite(index) || index <= 0 || index > 1_000_000)
    throw new UsageError(
      '--series-index must be a positive number no greater than 1000000.',
    );
  return index;
}

async function loadMetadataSidecar(path: string) {
  try {
    return parseMetadataSidecar(
      await readBounded(path, MAX_METADATA_FILE_BYTES),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'could not be read.';
    throw new UsageError(`Invalid metadata sidecar: ${message}`);
  }
}

function userValue<T>(value: T): InferredValue<T> {
  return {
    value,
    provenance: { source: 'CLI option', method: 'user', confidence: 'certain' },
  };
}

async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Input must be a regular file.');
    if (info.size > limit)
      throw new Error(`File exceeds the ${limit} byte input limit.`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit)
        throw new Error(`File exceeds the ${limit} byte input limit.`);
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    await file.close();
  }
}

async function readCover(
  path: string,
  model: DocumentModel,
): Promise<NonNullable<EpubWriterOptions['cover']>> {
  const mediaTypeByExtension: Record<
    string,
    'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml'
  > = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };
  const mediaType = mediaTypeByExtension[extname(path).toLowerCase()];
  if (!mediaType)
    throw new UsageError('--cover must be a JPEG, PNG, WebP, or SVG image.');
  const data = await readBounded(path, MAX_COVER_BYTES);
  let dimensions: { width?: number; height?: number } = {};
  if (mediaType !== 'image/svg+xml') {
    const { inspectRasterImage } = await import('./image-resizer.ts');
    const { width, height } = inspectRasterImage(data, mediaType);
    if (!width || !height)
      throw new Error('Cover image dimensions could not be read.');
    dimensions = { width, height };
  }
  return {
    width: 1600,
    height: 2560,
    layout: 'image-only',
    title: model.metadata.title?.value ?? '',
    authors: model.metadata.authors?.map(({ value }) => value.name) ?? [],
    alignment: 'center',
    titlePosition: 18,
    authorPosition: 86,
    titleSize: 112,
    authorSize: 54,
    textColor: 'light',
    contrastPanel: 'dark',
    panelOpacity: 0.56,
    imageOpacity: 1,
    margin: 8,
    crop: 'cover',
    image: { mediaType, data, ...dimensions },
  };
}

async function protectSource(source: string, output: string): Promise<void> {
  if (resolve(source) === resolve(output))
    throw new UsageError(
      'Output must not replace the input document or style preset.',
    );
  const sourceInfo = await stat(source);
  try {
    const outputInfo = await stat(output);
    if (sourceInfo.dev === outputInfo.dev && sourceInfo.ino === outputInfo.ino)
      throw new UsageError(
        'Output must not replace the input document or style preset.',
      );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}

async function saveOutput(
  path: string,
  data: string | Uint8Array,
  force: boolean,
): Promise<void> {
  const directory = await mkdtemp(
    join(dirname(resolve(path)), '.wordconvert-'),
  );
  const temporary = join(directory, 'output');
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    if (force) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    });
    await rmdir(directory);
  }
}

function parseMaxImageSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EPUB_MAX_IMAGE_DIMENSION;
  if (!/^\d+$/.test(value) || Number(value) > 32768)
    throw new UsageError(
      '--max-image-size must be a whole number of pixels from 0 to 32768.',
    );
  return Number(value);
}

function parseEpubImageDimensions(
  value: string | undefined,
): EpubImageDimensions | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(value);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !match ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768
  )
    throw new UsageError(
      '--epub-max-image-size must be WIDTHxHEIGHT with whole-number dimensions from 1 to 32768.',
    );
  return { width, height };
}

function parseCoverPolicy(
  value: string | undefined,
): EpubCoverPolicy | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'source' ||
    value === 'generated' ||
    value === 'file' ||
    value === 'none'
  )
    return value;
  throw new UsageError(
    '--cover-policy must be source, generated, file, or none.',
  );
}

function parseFlowSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EPUB_MAX_CHAPTER_SIZE_BYTES;
  if (value.toLowerCase() === 'off' || value === '0') return 0;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1_048_576)
    throw new UsageError(
      '--flow-size must be off or a whole number of KiB from 0 to 1048576.',
    );
  return Number(value) * 1024;
}

function parseChapterDetectionMode(
  value: string | undefined,
): ChapterDetectionMode {
  const mode = value ?? 'automatic';
  if (mode !== 'off' && mode !== 'automatic' && mode !== 'custom')
    throw new UsageError(
      '--chapter-detection must be off, automatic, or custom.',
    );
  return mode;
}

function parseChapterMark(value: string | undefined): ChapterMark {
  const mark = value ?? 'none';
  if (
    mark !== 'pagebreak' &&
    mark !== 'rule' &&
    mark !== 'none' &&
    mark !== 'both'
  )
    throw new UsageError(
      '--chapter-mark must be pagebreak, rule, none, or both.',
    );
  return mark;
}

function parseChapterSplitLevel(
  value: string | undefined,
): ChapterHeadingLevel {
  const level = Number(value ?? 2);
  if (!/^[1-6]$/.test(value ?? '2'))
    throw new UsageError(
      '--chapter-split-level must be an integer from 1 to 6.',
    );
  return level as ChapterHeadingLevel;
}

function parseTocSource(
  value: string | undefined,
  noChapters: boolean,
  noEmbedded: boolean,
): 'automatic' | 'embedded' | 'generated' | 'off' {
  if (noChapters && (value !== undefined || noEmbedded))
    throw new UsageError(
      '--no-chapters-in-toc cannot be combined with --toc-source or --no-toc-embedded.',
    );
  if (noEmbedded && value !== undefined)
    throw new UsageError(
      '--no-toc-embedded cannot be combined with --toc-source.',
    );
  if (noChapters) return 'off';
  if (noEmbedded) return 'generated';
  const source = value ?? 'automatic';
  if (
    source !== 'automatic' &&
    source !== 'embedded' &&
    source !== 'generated' &&
    source !== 'off'
  )
    throw new UsageError(
      '--toc-source must be automatic, embedded, generated, or off.',
    );
  return source;
}

function parseTocLimit(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!/^\d+$/.test(value ?? String(fallback)) || parsed > 500)
    throw new UsageError(`--${name} must be an integer from 0 to 500.`);
  return parsed;
}

function parseTocFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > 128 ||
    /\\[1-9]|[|()]|[+*?]|\{\d+(?:,\d*)?\}/u.test(value)
  )
    throw new UsageError(
      '--toc-filter must be a valid pattern of at most 128 characters without groups, alternation, backreferences, or quantifiers.',
    );
  try {
    new RegExp(value, 'iu');
  } catch {
    throw new UsageError('--toc-filter must be a valid regular expression.');
  }
  return value;
}

async function render(
  model: DocumentModel,
  format: Format,
  conversionDate: string,
  formulaMode: MathOutputMode,
  images: {
    maxImageSize: number;
    maxImageDimensions?: EpubImageDimensions;
    imageFormat: 'jpeg' | 'preserve';
    imageQuality: number;
    maxChapterSizeBytes: number;
    splitOnPageBreaks: boolean;
    chapterMark: ChapterMark;
    chapterSplitLevel: ChapterHeadingLevel;
    tocTitle: string | undefined;
    inlineToc: boolean;
    tocAtEnd: boolean;
    coverPolicy: EpubCoverPolicy;
    preserveCoverAspectRatio: boolean;
    extraCss?: string;
    startReadingAt?: string;
    runtimeDir: string | undefined;
    warn: (message: string) => void;
    cover?: EpubWriterOptions['cover'];
    coverPng?: Uint8Array;
    onStage?: (event: PipelineStageEvent) => void;
  },
): Promise<string | Uint8Array> {
  const options = {
    conversionDate,
    formulaMode,
    chapterMark: images.chapterMark,
    chapterSplitLevel: images.chapterSplitLevel,
    ...(images.tocTitle ? { tocTitle: images.tocTitle } : {}),
    inlineToc: images.inlineToc,
    tocAtEnd: images.tocAtEnd,
    ...(images.onStage ? { onStage: images.onStage } : {}),
  };
  const onWarning = (warning: DocumentModel['warnings'][number]): void => {
    model.warnings.push(warning);
  };
  const markdownOptions = {
    ...options,
    onWarning,
  };
  switch (format) {
    case 'html':
      return writeHtml(model, { ...options, mode: 'standalone', onWarning });
    case 'html-zip':
      return writeHtmlZip(model, { ...options, onWarning });
    case 'markdown':
      return writeMarkdown(model, markdownOptions);
    case 'markdown-zip':
      return writeMarkdownZip(model, markdownOptions);
    case 'epub': {
      const imageResizer =
        images.maxImageSize > 0 || images.maxImageDimensions
          ? (await import('./image-resizer.ts')).createImageResizer(
              images.runtimeDir,
            )
          : undefined;
      const coverRasterizer =
        images.coverPolicy !== 'none'
          ? (await import('./native-runtime.ts')).createCoverRasterizer(
              images.runtimeDir,
            )
          : undefined;
      if (
        (images.maxImageSize > 0 || images.maxImageDimensions) &&
        !imageResizer
      )
        images.warn(
          'warning: Native image runtime unavailable; images are embedded at original size.\n',
        );
      return writeEpub(model, {
        ...options,
        maxImageDimension: images.maxImageSize,
        ...(images.maxImageDimensions
          ? { maxImageDimensions: images.maxImageDimensions }
          : {}),
        imageFormat: images.imageFormat,
        imageQuality: images.imageQuality,
        maxChapterSizeBytes: images.maxChapterSizeBytes,
        splitOnPageBreaks: images.splitOnPageBreaks,
        chapterMark: images.chapterMark,
        chapterSplitLevel: images.chapterSplitLevel,
        ...(images.tocTitle ? { tocTitle: images.tocTitle } : {}),
        inlineToc: images.inlineToc,
        tocAtEnd: images.tocAtEnd,
        coverPolicy: images.coverPolicy,
        preserveCoverAspectRatio: images.preserveCoverAspectRatio,
        ...(images.extraCss !== undefined ? { extraCss: images.extraCss } : {}),
        ...(images.startReadingAt
          ? { startReadingAt: images.startReadingAt }
          : {}),
        onWarning,
        ...(images.cover ? { cover: images.cover } : {}),
        ...(images.coverPng ? { coverPng: images.coverPng } : {}),
        ...(coverRasterizer ? { coverRasterizer } : {}),
        ...(imageResizer ? { imageResizer } : {}),
      });
    }
  }
}

function parseVerbose(value: boolean | boolean[] | undefined): number {
  const count = Array.isArray(value) ? value.length : value ? 1 : 0;
  if (count > 2)
    throw new UsageError('--verbose may be repeated at most twice.');
  return count;
}

function sanitizeBasename(path: string): string {
  return (
    basename(path)
      .replaceAll(/[\\/\p{Cc}]/gu, '_')
      .slice(0, 255) || '[unnamed]'
  );
}

function sanitizeRequestText(value: string | undefined): string | undefined {
  return value
    ?.replaceAll(/[\p{Cc}]/gu, ' ')
    .replaceAll(
      /(?:^|[\s"'=])(?:\/[^\s"'<>]+|[A-Za-z]:[\\/][^\s"'<>]*)/gu,
      ' [path]',
    )
    .slice(0, 2048);
}

interface CliStageSnapshot {
  stage: string;
  at: number;
  counts: string;
}

class CliStageDiagnostics {
  private readonly startedAt = performance.now();
  private readonly snapshots: CliStageSnapshot[] = [];
  private modelSelection = {
    provider: 'not-used',
    layout: 'not-used',
    formula: 'not-used',
  };

  constructor(private readonly verbosity: number) {}

  record(event: PipelineStageEvent): void {
    try {
      const value = isRecord(event.data) ? event.data : {};
      if (value.status === 'not-applicable') return;
      this.snapshots.push({
        stage: event.stage,
        at: performance.now(),
        counts: this.counts(event.stage, value),
      });
    } catch {
      this.snapshots.push({
        stage: event.stage,
        at: performance.now(),
        counts: 'counts unavailable',
      });
    }
  }

  setModelSelection(selection: {
    provider: string;
    layout: string;
    formula: string;
  }): void {
    this.modelSelection = selection;
  }

  report(
    write: (message: string) => void,
    request: Record<string, unknown>,
  ): void {
    if (!this.verbosity) return;
    const options = isRecord(request.options) ? request.options : {};
    for (let index = 0; index < this.snapshots.length; index++) {
      const current = this.snapshots[index]!;
      const previous = this.snapshots[index - 1];
      const duration = Math.max(
        0,
        (index === this.snapshots.length - 1 ? performance.now() : current.at) -
          (previous?.at ?? this.startedAt),
      );
      write(
        `Stage ${current.stage}: ${duration.toFixed(1)} ms; ${current.counts}.\n`,
      );
    }
    if (this.verbosity < 2) return;
    write(
      `Options: format=${String(request.outputFormat)}; formula-mode=${String(options.formulaMode)}; layout=${String(options.layout)}; pdf-tables=${JSON.stringify(options.pdfTables)}; unwrap-factor=${String(options.unwrapFactor)}; dehyphenate=${String(options.dehyphenate)}; rasterize=${String(options.rasterize)}; formula-ocr=${String(options.formulaOcr)}; image-size=${String(options.maxImageSize)}; image-format=${String(options.imageFormat)}; image-quality=${String(options.imageQuality)}; split-chapters=${String(options.splitChapters)}; style-preset=${options.stylePreset ? 'provided' : 'none'}; cover=${options.cover ? 'provided' : 'none'}; metadata-overrides=${Boolean(options.title || array(options.authors).length || options.language || options.identifier)}.\n`,
    );
    write(
      `Models: provider=${this.modelSelection.provider}; layout=${this.modelSelection.layout}; formula=${this.modelSelection.formula}.\n`,
    );
  }

  private counts(stage: string, value: Record<string, unknown>): string {
    if (stage === 'raw') {
      const pages = array(value.pages);
      return `pages=${pages.length}, spans=${pages.reduce<number>((count, page) => count + array(record(page).spans).length, 0)}, images=${pages.reduce<number>((count, page) => count + array(record(page).images).length, 0)}, links=${pages.reduce<number>((count, page) => count + array(record(page).links).length, 0)}`;
    }
    if (stage === 'analysis')
      return `pages=${array(value.analysedPages).length}, furniture=${array(value.candidates).length}, formulas=${array(value.formulaCandidates).length}, formula-images=${array(value.formulaImageRegions).length}`;
    if (stage === 'model')
      return `blocks=${countBlocks(value.blocks)}, styles=${array(value.styles).length}, assets=${Object.keys(record(value.assets)).length}, equations=${Object.keys(record(value.equations)).length}, warnings=${array(value.warnings).length}`;
    if (stage === 'output') {
      const artifacts = record(value);
      return `files=${Object.keys(artifacts).length}, bytes=${Object.values(artifacts).reduce<number>((sum, item) => sum + (item instanceof Uint8Array ? item.byteLength : 0), 0)}`;
    }
    return 'objects=0';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countBlocks(value: unknown): number {
  const pending = [...array(value)];
  let count = 0;
  while (pending.length && count < 100_000) {
    const block = record(pending.pop());
    count++;
    if (block.type === 'list')
      for (const item of array(block.items))
        pending.push(...array(record(item).blocks));
    else if (block.type === 'table')
      for (const row of array(block.rows))
        for (const cell of array(record(row).cells))
          pending.push(...array(record(cell).blocks));
    else if (block.type === 'blockquote') pending.push(...array(block.blocks));
  }
  return count;
}
