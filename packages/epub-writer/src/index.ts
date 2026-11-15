import {
  createTocFromHeadings,
  isChapterMark,
  nestTocEntries,
} from '@wordconvert/document-model';
import type {
  BlockNode,
  ConversionWarning,
  DocumentAsset,
  DocumentModel,
  InlineNode,
  TextMark,
  WriterOptions,
  ChapterMark,
  ChapterHeadingLevel,
  TocEntry,
} from '@wordconvert/document-model';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  createCoverSvg,
  type CoverImage,
  type CoverComposition,
} from '@wordconvert/cover-generator';
import {
  KATEX_STYLES,
  renderEquation as renderMathEquation,
  type MathOutputMode,
} from '@wordconvert/math-converter';
import parseCss from 'css-tree/parser';
import type { CssLocation, CssNode } from 'css-tree';
import { ident as cssIdent } from 'css-tree/utils';
import walkCss from 'css-tree/walker';

export type EpubCoverPolicy = 'source' | 'generated' | 'file' | 'none';

export interface EpubImageDimensions {
  width: number;
  height: number;
}

export interface EpubWriterOptions extends WriterOptions {
  identifier?: string;
  title?: string;
  language?: string;
  /** EPUB 3 package modification time, in UTC second precision. */
  modified?: string;
  cover?: CoverComposition;
  coverPng?: Uint8Array;
  coverPolicy?: EpubCoverPolicy;
  preserveCoverAspectRatio?: boolean;
  /** Bounded user CSS appended after the generated stylesheet. */
  extraCss?: string;
  /** Match a heading label exactly to choose the bodymatter landmark. */
  startReadingAt?: string;
  formulaMode?: MathOutputMode;
  sourceXhtml?: string;
  sourceCss?: string;
  /** Longest image edge in pixels; larger raster images are downscaled. Default 1600. */
  maxImageDimension?: number;
  /** Independent width and height caps applied in addition to maxImageDimension. */
  maxImageDimensions?: EpubImageDimensions;
  /** Opaque raster encoding. Default jpeg; preserve keeps the source format. */
  imageFormat?: 'jpeg' | 'preserve';
  /** JPEG/WebP quality from 1 to 100. Default 80. */
  imageQuality?: number;
  /** Injected raster resizer; without it images are embedded unchanged. */
  imageResizer?: EpubImageResizer;
  /** Heading level that begins an EPUB chapter. Defaults to level 2. */
  chapterSplitLevel?: ChapterHeadingLevel;
  /** Maximum serialized chapter XHTML size in bytes. Zero disables size splitting. */
  maxChapterSizeBytes?: number;
  /** Split after page-break blocks when size splitting is enabled. Defaults to false. */
  splitOnPageBreaks?: boolean;
  /** Explicit visual marker at chapter file boundaries. Defaults to none. */
  chapterMark?: ChapterMark;
  /** Emit an additional visible contents document in the spine. */
  inlineToc?: boolean;
  /** Place the visible contents document after the book chapters. */
  tocAtEnd?: boolean;
  /** Visible contents heading. Defaults to Contents. */
  tocTitle?: string;
  onWarning?: (warning: ConversionWarning) => void;
}

export const DEFAULT_EPUB_MAX_IMAGE_DIMENSION = 1600;
export const DEFAULT_EPUB_IMAGE_QUALITY = 80;
export const DEFAULT_EPUB_MAX_CHAPTER_SIZE_BYTES = 260 * 1024;
export const MAX_EPUB_EXTRA_CSS_BYTES = 64 * 1024;

/** Byte-only results retain the source type; typed results may change encoding. */
export type EpubImageResizer = (
  data: Uint8Array,
  mediaType: string,
  maxDimension: number,
  encoding: { format: 'jpeg' | 'preserve'; quality: number },
  maxDimensions?: EpubImageDimensions,
) => Promise<Uint8Array | { data: Uint8Array; mediaType: string } | undefined>;

const RESIZABLE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

async function shrinkAssets(
  model: DocumentModel,
  options: EpubWriterOptions,
): Promise<DocumentModel> {
  const resize = options.imageResizer;
  const max = options.maxImageDimension ?? DEFAULT_EPUB_MAX_IMAGE_DIMENSION;
  const maxDimensions = options.maxImageDimensions;
  const quality = options.imageQuality ?? DEFAULT_EPUB_IMAGE_QUALITY;
  if (!Number.isInteger(max) || max < 0 || max > 32768)
    throw new TypeError(
      'EPUB image dimension must be an integer from 0 to 32768.',
    );
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new TypeError('EPUB image quality must be an integer from 1 to 100.');
  if (
    maxDimensions !== undefined &&
    (!Number.isInteger(maxDimensions.width) ||
      maxDimensions.width < 1 ||
      maxDimensions.width > 32768 ||
      !Number.isInteger(maxDimensions.height) ||
      maxDimensions.height < 1 ||
      maxDimensions.height > 32768)
  )
    throw new TypeError(
      'EPUB image width and height caps must be integers from 1 to 32768.',
    );
  if (
    options.imageFormat !== undefined &&
    options.imageFormat !== 'jpeg' &&
    options.imageFormat !== 'preserve'
  )
    throw new TypeError('EPUB image format must be jpeg or preserve.');
  if (!resize || (!(max > 0) && !maxDimensions)) return model;
  const assets: DocumentModel['assets'] = {};
  for (const [key, asset] of Object.entries(model.assets)) {
    const mediaType = asset.mediaType.toLowerCase();
    let next = asset;
    if (RESIZABLE_MEDIA_TYPES.has(mediaType)) {
      const result = await resize(
        asset.data,
        mediaType,
        max,
        {
          format: options.imageFormat ?? 'jpeg',
          quality,
        },
        maxDimensions,
      );
      const data = result instanceof Uint8Array ? result : result?.data;
      const outputType =
        result instanceof Uint8Array ? mediaType : result?.mediaType;
      const needsDimensionCap =
        (max > 0 &&
          asset.width !== undefined &&
          asset.height !== undefined &&
          Math.max(asset.width, asset.height) > max) ||
        (maxDimensions !== undefined &&
          asset.width !== undefined &&
          asset.height !== undefined &&
          (asset.width > maxDimensions.width ||
            asset.height > maxDimensions.height));
      if (
        data &&
        outputType &&
        RESIZABLE_MEDIA_TYPES.has(outputType) &&
        (needsDimensionCap || data.byteLength < asset.data.byteLength)
      )
        next = { ...asset, data, mediaType: outputType };
    }
    assets[key] = next;
  }
  return { ...model, assets };
}

interface Chapter {
  id: string;
  path: string;
  blocks: BlockNode[];
  markBefore: boolean;
}

interface HeadingEntry {
  id: string;
  label: string;
  path: string;
  level: number;
}

interface TocRenderEntry extends HeadingEntry {
  children: TocRenderEntry[];
}

interface AssetEntry {
  asset: DocumentAsset;
  id: string;
  path: string;
  mediaType: string;
}

interface RenderContext {
  model: DocumentModel;
  assetPaths: ReadonlyMap<string, string>;
  headings: HeadingEntry[];
  headingIndex: number;
  chapterPath: string;
  referencedNotes: string[];
  formulaMode: MathOutputMode;
  pageMarkers: ReadonlyMap<string, string>;
}

const ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');
const STYLES = [
  /* Base */
  'body{font-family:Georgia,"Times New Roman",Times,serif;font-size:1em;line-height:1.6;color:#1a1a1a;margin:0 auto;max-width:36em;padding:1.5em 1em;-epub-hyphens:auto;hyphens:auto}',
  /* Headings */
  'h1,h2,h3,h4,h5,h6{clear:both;font-family:inherit;font-weight:bold;line-height:1.25;margin-top:1.5em;margin-bottom:.5em;color:#111;-epub-hyphens:none;hyphens:none}',
  'h1{font-size:1.875em;page-break-before:always}',
  'h1:first-child{page-break-before:avoid}',
  'h2{font-size:1.5em}h3{font-size:1.25em}h4{font-size:1.125em}h5,h6{font-size:1em}',
  /* Paragraphs */
  'p{margin:0 0 .75em}',
  /* Links */
  'a{color:#0645ad;text-decoration:underline}',
  /* Images */
  'img{max-width:100%;height:auto;display:block;margin:1em auto}',
  'img.equation-image{display:inline-block;margin:0 .12em;vertical-align:middle}',
  'figure{margin:1.5em 0;text-align:center}',
  '.image-block>img{width:100%;margin:0}',
  '.image-center{margin-left:auto;margin-right:auto}',
  '.image-left{float:left;margin:0 1.25em 1em 0}',
  '.image-right{float:right;margin:0 0 1em 1.25em}',
  ...Array.from(
    { length: 20 },
    (_, index) => `.image-width-${(index + 1) * 5}{width:${(index + 1) * 5}%}`,
  ),
  'figcaption{font-size:.875em;color:#555;margin-top:.4em;font-style:italic}',
  /* Tables */
  'table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9em}',
  'th,td{border:1px solid #bbb;padding:.4em .6em;text-align:left;vertical-align:top}',
  'th{background:#f0f0f0;font-weight:bold}',
  'caption{caption-side:top;font-weight:bold;margin-bottom:.5em;text-align:center}',
  /* Code */
  'code,kbd,samp{font-family:"Courier New",Courier,monospace;font-size:.875em;background:#f5f5f5;padding:.1em .3em}',
  'pre{background:#f5f5f5;border:1px solid #ddd;padding:.75em 1em;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font-size:.875em;margin:1em 0}',
  'pre code{background:none;padding:0;font-size:1em}',
  /* Blockquotes */
  'blockquote{margin:1em 0 1em 1em;padding:.5em 0 .5em 1em;border-left:4px solid #ccc;color:#555}',
  ...Array.from({ length: 10 }, (_, index) => {
    const magnitude = index + 1;
    return `.indent-first-line-${magnitude}{text-indent:${magnitude}%}.indent-hanging-${magnitude}{margin-left:${magnitude}%;text-indent:-${magnitude}%}`;
  }),
  /* Lists */
  'ul,ol{margin:.75em 0;padding-left:2em}li{margin:.25em 0}',
  /* HR */
  'hr{border:none;border-top:1px solid #ccc;margin:2em 0}',
  /* Equations — MathML display */
  '.equation{margin:1em 0;text-align:center;overflow-x:auto}',
  'math{display:inline}math[display="block"]{display:block;margin:1em auto;overflow-x:auto}',
  /* Footnotes */
  '.footnotes{font-size:.875em;border-top:1px solid #ccc;margin-top:2em;padding-top:1em}',
  'a.footnote-ref{font-size:.75em;vertical-align:super;text-decoration:none}',
  'a.footnote-backref{text-decoration:none}',
  /* Page breaks */
  '.page-break{break-after:page;page-break-after:always;height:0;display:block}',
  /* Title page */
  '.subtitle{font-size:1.25em;font-style:italic;color:#444;margin-top:.5em}',
  '.author{font-size:1.125em;margin-top:.75em;color:#333}',
].join('');
const SOURCE_HTML_STYLES =
  '.source-html .ltx_document{max-width:52rem;margin-left:auto;margin-right:auto}.source-html .ltx_title.ltx_title_document{margin-top:0;margin-bottom:1.5rem;text-align:center;font-size:1.7rem;font-weight:400}.source-html .ltx_abstract{margin:2rem auto;font-size:1em;line-height:1.6}.source-html .ltx_title_abstract{margin:0 0 .75rem;text-align:center;font-size:1.25em}.source-html .ltx_abstract .ltx_p{font-size:1em}.source-html .ltx_authors{text-align:center}.source-html .ltx_creator{display:inline-flex;flex-direction:column;width:16rem;max-width:calc(100% - 2rem);margin:.75rem 1rem;vertical-align:top}.source-html .ltx_personname{font-weight:600}.source-html .ltx_author_notes{font-size:.875em}.source-html .ltx_itemize,.source-html .ltx_enumerate{list-style:none}.source-html .ltx_itemize>.ltx_item,.source-html .ltx_enumerate>.ltx_item{list-style:none}.source-html .ltx_graphics{display:block;max-width:100%;height:auto;margin-left:auto;margin-right:auto}.source-html .ltx_figure{max-width:100%;margin-left:auto;margin-right:auto;text-align:center}.source-html .ltx_equation,.source-html .ltx_equationgroup{display:table;width:100%;margin:.75rem auto;border:0}.source-html .ltx_eqn_row{display:table-row}.source-html .ltx_equation tbody,.source-html .ltx_equationgroup tbody,.source-html .ltx_equation tr{border:0}.source-html .ltx_equation td,.source-html .ltx_equationgroup td{display:table-cell;border:0;padding:.3rem .2rem;vertical-align:middle}.source-html .ltx_eqn_cell{width:100%;text-align:center}.source-html .ltx_eqn_eqno{width:3em;padding-left:1em;white-space:nowrap;text-align:right}.source-html math{vertical-align:baseline}.source-html math[display="block"]{display:block;margin:0 auto}.source-html .ltx_Math{white-space:nowrap}';
const SOURCE_HTML_EQUATION_LAYOUT_STYLES =
  '.source-html table.ltx_equation>tbody,.source-html table.ltx_equationgroup>tbody{display:block}.source-html table.ltx_equation>tbody>.ltx_eqn_row,.source-html table.ltx_equationgroup>tbody>.ltx_eqn_row{display:grid;width:100%;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center}.source-html .ltx_eqn_center_padleft,.source-html .ltx_eqn_center_padright{display:none!important}.source-html .ltx_eqn_row>.ltx_eqn_cell:not(.ltx_eqn_eqno):not(.ltx_eqn_center_padleft):not(.ltx_eqn_center_padright){grid-column:2;width:auto;justify-self:center;text-align:center}.source-html .ltx_eqn_row>.ltx_eqn_eqno{grid-column:3;grid-row:1;width:auto;justify-self:end;text-align:right}';
const SOURCE_HTML_PARAGRAPH_TITLE_STYLES =
  '.source-html .ltx_title.ltx_title_paragraph{font-size:1.15em;font-weight:600}';
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export async function writeEpub(
  model: DocumentModel,
  options: EpubWriterOptions,
): Promise<Uint8Array> {
  const chapterSplitLevel = options.chapterSplitLevel ?? 2;
  const maxChapterSizeBytes =
    options.maxChapterSizeBytes ?? DEFAULT_EPUB_MAX_CHAPTER_SIZE_BYTES;
  const chapterMark = options.chapterMark ?? 'none';
  if (
    !Number.isInteger(chapterSplitLevel) ||
    chapterSplitLevel < 1 ||
    chapterSplitLevel > 6
  )
    throw new TypeError(
      'EPUB chapter split level must be an integer from 1 to 6.',
    );
  if (!isChapterMark(chapterMark))
    throw new TypeError(
      'EPUB chapter mark must be pagebreak, rule, none, or both.',
    );
  if (!Number.isSafeInteger(maxChapterSizeBytes) || maxChapterSizeBytes < 0)
    throw new TypeError(
      'EPUB maximum chapter size must be a non-negative safe integer.',
    );
  model = await shrinkAssets(model, options);
  const generatedToc = createTocFromHeadings(model.blocks);
  const toc = model.toc ?? generatedToc;
  const metadata = resolveMetadata(model, options);
  let chapters = options.sourceXhtml
    ? [
        {
          id: 'chapter-001',
          path: 'chapter-001.xhtml',
          blocks: [],
          markBefore: false,
        },
      ]
    : splitChapters(model.blocks, chapterSplitLevel);
  const assets = createAssetRegistry(model);
  const assetPaths = new Map(
    assets.map(({ asset, path }) => [asset.id, path.replace('EPUB/', '')]),
  );
  if (!options.sourceXhtml && maxChapterSizeBytes > 0) {
    const result = splitOversizedChapters(
      chapters,
      maxChapterSizeBytes,
      metadata,
      model,
      assetPaths,
      options.formulaMode ?? 'mathml',
      chapterMark,
      options.splitOnPageBreaks ?? false,
    );
    chapters = result.chapters;
    if (result.addedFiles > 0)
      options.onWarning?.({
        code: 'epub-chapter-size-split',
        severity: 'warning',
        message: `Added ${result.addedFiles} EPUB chapter file(s) by serialized-size splitting.`,
        details: {
          addedFiles: result.addedFiles,
          maxChapterSizeBytes,
        },
      });
    if (result.oversizedFiles > 0)
      options.onWarning?.({
        code: 'epub-chapter-oversize',
        severity: 'warning',
        message: `${result.oversizedFiles} EPUB chapter file(s) exceed the ${maxChapterSizeBytes}-byte limit because they contain unbreakable content.`,
        details: {
          oversizedFiles: result.oversizedFiles,
          maxChapterSizeBytes,
        },
      });
  }
  options.onWarning?.({
    code: 'epub-chapter-count',
    severity: 'info',
    message: `EPUB output contains ${chapters.length} chapter file(s).`,
    details: {
      chapters: chapters.length,
      splitLevel: chapterSplitLevel,
    },
  });
  const headings = options.sourceXhtml ? [] : collectHeadings(chapters);
  const navigation = options.sourceXhtml
    ? []
    : createTocRenderEntries(toc, [
        ...headings,
        ...collectPageAnchors(chapters),
      ]);
  const coverPolicy =
    options.coverPolicy ??
    (options.cover || options.coverPng ? 'generated' : 'none');
  if (
    coverPolicy !== 'source' &&
    coverPolicy !== 'generated' &&
    coverPolicy !== 'file' &&
    coverPolicy !== 'none'
  )
    throw new TypeError(
      'EPUB cover policy must be source, generated, file, or none.',
    );
  let cover = resolveCoverComposition(model, metadata, coverPolicy, options);
  let coverPng =
    coverPolicy === 'generated' || coverPolicy === 'file'
      ? options.coverPng
      : undefined;
  if (options.preserveCoverAspectRatio && coverPng) {
    if (!options.cover)
      cover = {
        ...defaultCoverComposition(metadata, {
          mediaType: 'image/png',
          data: coverPng,
        }),
        crop: 'contain',
      };
    coverPng = undefined;
  }
  const coverPath = coverPng ? 'cover.png' : cover ? 'cover.svg' : undefined;
  const startHeading = resolveStartReadingHeading(
    headings,
    options.startReadingAt,
  );
  const startTarget: { path: string; id?: string } = startHeading
    ? startHeading
    : { path: chapters[0]?.path ?? 'chapter-001.xhtml' };
  const pageTargets = [...headings, ...collectPageAnchors(chapters)];
  const pageList = resolvePageList(model, pageTargets, options.onWarning);
  const pageMarkerMarkup = new Map(
    pageList.map(({ targetId, id, label }) => [
      targetId,
      `<span epub:type="pagebreak" id="${escapeAttribute(id)}" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}"/>`,
    ]),
  );
  const extraCss = sanitizeExtraCss(options.extraCss, options.onWarning);
  const files: Zippable = {};
  files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(containerXml());
  files['EPUB/package.opf'] = strToU8(
    packageXml(
      metadata,
      chapters,
      assets,
      coverPath,
      options.sourceXhtml?.includes('<math') === true,
      options.inlineToc ? 'contents.xhtml' : undefined,
      options.tocAtEnd ?? false,
    ),
  );
  files['EPUB/nav.xhtml'] = strToU8(
    navXhtml(
      metadata,
      navigation,
      options.tocTitle ?? 'Contents',
      coverPath !== undefined,
      startTarget,
      pageList,
    ),
  );
  files['EPUB/styles.css'] = strToU8(
    `${options.formulaMode === 'katex' ? KATEX_STYLES : ''}${STYLES}${options.sourceXhtml ? SOURCE_HTML_STYLES + SOURCE_HTML_EQUATION_LAYOUT_STYLES + SOURCE_HTML_PARAGRAPH_TITLE_STYLES : ''}${options.sourceCss ?? ''}${extraCss}`,
  );
  if (coverPath) {
    if (coverPng) files['EPUB/cover.png'] = coverPng;
    else if (cover) files['EPUB/cover.svg'] = strToU8(createCoverSvg(cover));
    files['EPUB/cover.xhtml'] = strToU8(coverXhtml(metadata, coverPath));
  }
  files['EPUB/title.xhtml'] = strToU8(titleXhtml(metadata, model));
  if (options.inlineToc)
    files['EPUB/contents.xhtml'] = strToU8(
      contentsXhtml(metadata, navigation, options.tocTitle ?? 'Contents'),
    );
  for (const chapter of chapters) {
    files[`EPUB/${chapter.path}`] = strToU8(
      options.sourceXhtml
        ? xhtmlDocument(
            metadata,
            metadata.title,
            `<div class="source-html">${resolveSourceAssetPaths(options.sourceXhtml, assetPaths)}</div>`,
            ' xmlns:epub="http://www.idpf.org/2007/ops"',
          )
        : chapterXhtml(
            chapter,
            metadata,
            model,
            assetPaths,
            headings,
            options.formulaMode ?? 'mathml',
            chapterMark,
            pageMarkerMarkup,
          ),
    );
  }
  for (const entry of assets) files[entry.path] = entry.asset.data;
  if (options.onStage) {
    const artifacts: Record<string, Uint8Array> = {};
    for (const [path, value] of Object.entries(files))
      artifacts[path] = artifactBytes(value);
    options.onStage({ stage: 'output', data: artifacts });
  }
  return zipSync(files, { level: 9, mtime: ZIP_TIME });
}

function resolveCoverComposition(
  model: DocumentModel,
  metadata: PublicationMetadata,
  policy: EpubCoverPolicy,
  options: EpubWriterOptions,
): CoverComposition | undefined {
  let cover: CoverComposition | undefined;
  if (policy === 'none') return undefined;
  if (policy === 'file') {
    if (!options.cover?.image)
      throw new TypeError(
        'EPUB cover policy file requires a validated cover image.',
      );
    cover = options.cover;
  } else if (policy === 'source') {
    const candidate = model.coverCandidates?.find(
      ({ confidence }) => confidence === 'high',
    );
    const asset = candidate ? model.assets[candidate.assetId] : undefined;
    const mediaType = asset?.mediaType.toLowerCase();
    if (!candidate || !asset || !mediaType || !isCoverMediaType(mediaType)) {
      options.onWarning?.({
        code: 'epub-source-cover-unavailable',
        severity: 'warning',
        message:
          'No supported high-confidence source cover candidate was available; the EPUB cover was omitted.',
      });
      return undefined;
    }
    cover = defaultCoverComposition(metadata, {
      mediaType,
      data: asset.data,
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
    });
  } else {
    cover = options.cover ?? defaultCoverComposition(metadata);
  }
  if (options.preserveCoverAspectRatio && cover.image)
    return { ...cover, crop: 'contain' };
  return cover;
}

function defaultCoverComposition(
  metadata: PublicationMetadata,
  image?: CoverImage,
): CoverComposition {
  return {
    width: 1600,
    height: 2560,
    layout: image ? 'image-only' : 'typographic',
    title: metadata.title,
    ...(metadata.subtitle ? { subtitle: metadata.subtitle } : {}),
    authors: metadata.creators.map(({ name }) => name),
    alignment: 'center',
    titlePosition: 20,
    authorPosition: 85,
    titleSize: 112,
    authorSize: 54,
    textColor: 'light',
    contrastPanel: image ? 'none' : 'dark',
    panelOpacity: 0.5,
    imageOpacity: 1,
    margin: 8,
    crop: 'cover',
    ...(image ? { image } : {}),
  };
}

function isCoverMediaType(value: string): value is CoverImage['mediaType'] {
  return (
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/webp' ||
    value === 'image/svg+xml'
  );
}

function resolveStartReadingHeading(
  headings: readonly HeadingEntry[],
  startReadingAt: string | undefined,
): { path: string; id: string } | undefined {
  if (startReadingAt === undefined) return undefined;
  if (startReadingAt.length > 200)
    throw new TypeError(
      'EPUB start-reading-at heading must be at most 200 characters.',
    );
  const label = startReadingAt.trim().toLocaleLowerCase();
  if (!label)
    throw new TypeError('EPUB start-reading-at heading must not be empty.');
  const heading = headings.find(
    ({ label: headingLabel }) =>
      headingLabel.trim().toLocaleLowerCase() === label,
  );
  if (!heading)
    throw new TypeError(
      `EPUB start-reading-at heading was not found: ${startReadingAt}.`,
    );
  return { path: heading.path, id: heading.id };
}

interface PageListEntry {
  page: number;
  label: string;
  id: string;
  targetId: string;
  path: string;
}

function resolvePageList(
  model: DocumentModel,
  targets: readonly HeadingEntry[],
  onWarning: EpubWriterOptions['onWarning'],
): PageListEntry[] {
  const pageMarkers = model.pageMarkers;
  if (!pageMarkers) return [];
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const valid =
    pageMarkers.confidence === 'high' &&
    pageMarkers.markers.length >= 2 &&
    pageMarkers.markers.every(
      ({ confidence, targetId }) =>
        confidence === 'high' && targetById.has(targetId),
    );
  if (!valid) {
    onWarning?.({
      code: 'epub-page-list-confidence',
      severity: 'warning',
      message:
        'Printed page-number evidence did not meet the high-confidence threshold; no EPUB page list was emitted.',
    });
    return [];
  }
  return [...pageMarkers.markers]
    .sort((left, right) => left.page - right.page)
    .map(({ page, label, id, targetId }) => ({
      page,
      label,
      id,
      targetId,
      path: targetById.get(targetId)!.path,
    }));
}

function sanitizeExtraCss(
  css: string | undefined,
  onWarning: EpubWriterOptions['onWarning'],
): string {
  if (css === undefined || css === '') return '';
  if (utf8ByteLength(css) > MAX_EPUB_EXTRA_CSS_BYTES)
    throw new TypeError(
      `EPUB extra CSS must be no larger than ${MAX_EPUB_EXTRA_CSS_BYTES} bytes.`,
    );
  let ast;
  try {
    ast = parseCss(css, {
      positions: true,
      onParseError: (error: unknown) => {
        throw error;
      },
    });
  } catch {
    onWarning?.({
      code: 'epub-extra-css-invalid',
      severity: 'warning',
      message: 'Invalid EPUB extra CSS was omitted. Rule: syntax.',
      details: { rule: 'syntax' },
    });
    return '';
  }
  const rejected: Array<{ start: number; end: number; rule: string }> = [];
  walkCss(ast, {
    enter(node: CssNode) {
      if (
        node.type === 'Atrule' &&
        cssIdent.decode(node.name).toLowerCase() === 'import'
      ) {
        addCssRange(node, '@import', rejected);
        return;
      }
      if (node.type !== 'Declaration') return;
      let rule: string | undefined;
      walkCss(node, {
        enter(child: CssNode) {
          if (
            child.type === 'Function' &&
            child.name.toLowerCase() === 'expression'
          )
            rule = 'expression()';
          else if (child.type === 'Url' && isExternalCssUrl(child.value))
            rule = 'remote url()';
          else if (
            child.type === 'Function' &&
            ['image-set', '-webkit-image-set'].includes(
              child.name.toLowerCase(),
            )
          ) {
            walkCss(child, {
              enter(candidate: CssNode) {
                if (
                  candidate.type === 'String' &&
                  isExternalCssUrl(candidate.value)
                )
                  rule = 'remote image-set()';
              },
            });
          }
        },
      });
      if (rule) addCssRange(node, `${rule} in ${node.property}`, rejected);
    },
  });
  if (rejected.length === 0) return css;
  const ranges = rejected.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const accepted: typeof ranges = [];
  for (const range of ranges) {
    const previous = accepted.at(-1);
    if (previous && range.start < previous.end) continue;
    accepted.push(range);
  }
  for (const { rule } of accepted)
    onWarning?.({
      code: 'epub-extra-css-rule-rejected',
      severity: 'warning',
      message: `Removed unsafe EPUB CSS declaration or rule. Rule: ${rule}.`,
      details: { rule },
    });
  let result = '';
  let offset = 0;
  for (const { start, end } of accepted) {
    result += css.slice(offset, start);
    offset = end;
  }
  return result + css.slice(offset);
}

function addCssRange(
  node: { loc?: CssLocation | undefined },
  rule: string,
  ranges: Array<{ start: number; end: number; rule: string }>,
): void {
  if (!node.loc) return;
  ranges.push({
    start: node.loc.start.offset,
    end: node.loc.end.offset,
    rule,
  });
}

function isExternalCssUrl(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value.trim());
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

function artifactBytes(value: Zippable[string]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value[0] instanceof Uint8Array) return value[0];
  throw new TypeError('Writer artifact is not a byte array.');
}

function resolveSourceAssetPaths(
  sourceXhtml: string,
  assetPaths: ReadonlyMap<string, string>,
): string {
  let resolved = sourceXhtml;
  for (const [id, path] of assetPaths)
    resolved = resolved.replaceAll(`wordconvert-asset:${id}`, path);
  return resolved.replaceAll(/wordconvert-asset:[^"'\s>]+/g, '');
}

interface PublicationMetadata {
  identifier: string;
  title: string;
  language: string;
  modified: string;
  subtitle?: string;
  titleSort?: string;
  authorSort?: string;
  publisher?: string;
  description?: string;
  subjects: string[];
  version?: string;
  rights?: string;
  sourceCreatedAt?: string;
  sourceModifiedAt?: string;
  publicationDate?: string;
  conversionDate?: string;
  isbn?: string;
  series?: string;
  seriesIndex?: number;
  creators: { name: string; sortAs?: string; role?: string }[];
  contributors: { name: string; sortAs?: string; role: string }[];
  bookProducer?: string;
}

function resolveMetadata(
  model: DocumentModel,
  options: EpubWriterOptions,
): PublicationMetadata {
  const identifier = boundedText(
    options.identifier ?? model.metadata.identifier?.value,
    'identifier',
    4096,
  );
  const title = boundedText(
    options.title ?? model.metadata.title?.value,
    'title',
  );
  const language = boundedText(
    options.language ?? model.metadata.language?.value,
    'language',
    128,
  );
  let modified: string;
  try {
    modified = normalizeMetadataDate(
      options.modified ?? options.conversionDate,
    );
  } catch {
    throw new TypeError(
      'EPUB modified timestamp must be UTC ISO 8601 with second precision.',
    );
  }
  if (!identifier?.trim()) throw new TypeError('EPUB identifier is required.');
  if (!title?.trim()) throw new TypeError('EPUB title is required.');
  if (!language || !isLanguageTag(language))
    throw new TypeError('EPUB language must be a valid BCP 47 language tag.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(modified))
    throw new TypeError(
      'EPUB modified timestamp must be UTC ISO 8601 with second precision.',
    );
  return {
    identifier: identifier.trim(),
    title: title.trim(),
    language,
    modified,
    ...optionalText('subtitle', model.metadata.subtitle?.value, 'subtitle'),
    ...optionalText('titleSort', model.metadata.titleSort?.value, 'title sort'),
    ...optionalText(
      'authorSort',
      model.metadata.authorSort?.value,
      'author sort',
    ),
    ...optionalText('publisher', model.metadata.publisher?.value, 'publisher'),
    ...optionalText(
      'description',
      model.metadata.description?.value,
      'description',
      16_384,
    ),
    subjects: boundedList(
      model.metadata.subjects.map(({ value }) => value),
      'subject',
      100,
    ),
    ...optionalText('version', model.metadata.version?.value, 'version'),
    ...optionalText('rights', model.metadata.rights?.value, 'rights'),
    ...optionalDate('sourceCreatedAt', model.metadata.sourceCreatedAt?.value),
    ...optionalDate('sourceModifiedAt', model.metadata.sourceModifiedAt?.value),
    ...optionalDate('publicationDate', model.metadata.publicationDate?.value),
    ...optionalDate('conversionDate', model.metadata.conversionDate?.value),
    ...optionalText('isbn', model.metadata.isbn?.value, 'ISBN', 64),
    ...optionalText('series', model.metadata.series?.value, 'series'),
    ...(model.metadata.seriesIndex
      ? {
          seriesIndex: boundedSeriesIndex(model.metadata.seriesIndex.value),
        }
      : {}),
    creators: boundedList(
      model.metadata.authors.map(({ value }) => value),
      'author',
      100,
    ).map((author) => {
      const role = marcRelator(author.role);
      return {
        name: boundedText(author.name, 'author name'),
        ...optionalText('sortAs', author.sortAs, 'author sort'),
        ...(role ? { role } : {}),
      };
    }),
    contributors: boundedList(
      model.metadata.contributors?.map(({ value }) => value) ?? [],
      'contributor',
      100,
    ).map((contributor) => ({
      name: boundedText(contributor.name, 'contributor name'),
      ...optionalText('sortAs', contributor.sortAs, 'contributor sort'),
      role: marcRelator(contributor.role) ?? 'ctb',
    })),
    ...optionalText(
      'bookProducer',
      model.metadata.bookProducer?.value,
      'book producer',
    ),
  };
}

function marcRelator(role: string | undefined): string | undefined {
  if (!role) return undefined;
  const aliases: Readonly<Record<string, string>> = {
    author: 'aut',
    editor: 'edt',
    illustrator: 'ill',
    translator: 'trl',
    contributor: 'ctb',
    'book producer': 'bkp',
  };
  const normalized = role.trim().toLowerCase();
  return (
    aliases[normalized] ??
    (/^[a-z]{3}$/.test(normalized) ? normalized : undefined)
  );
}

function optionalText<K extends string>(
  field: K,
  value: string | undefined,
  label: string,
  maxLength = 4096,
): Partial<Record<K, string>> {
  if (value === undefined || value.trim() === '') return {};
  return { [field]: boundedText(value, label, maxLength) } as Partial<
    Record<K, string>
  >;
}

function boundedText(
  value: string | undefined,
  label: string,
  maxLength = 4096,
): string {
  if (value === undefined) return '';
  if (value.length > maxLength)
    throw new TypeError(
      `EPUB ${label} must be no longer than ${maxLength} characters.`,
    );
  return value.trim();
}

function boundedList<T>(
  values: readonly T[],
  label: string,
  limit: number,
): T[] {
  if (values.length > limit)
    throw new TypeError(
      `EPUB metadata supports at most ${limit} ${label} values.`,
    );
  return [...values];
}

function boundedSeriesIndex(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000)
    throw new TypeError(
      'EPUB series index must be greater than 0 and at most 1000000.',
    );
  return value;
}

function optionalDate<K extends string>(
  field: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  if (value === undefined || value.trim() === '') return {};
  return { [field]: normalizeMetadataDate(value) } as Partial<
    Record<K, string>
  >;
}

function normalizeMetadataDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!isValidCalendarDate(value))
      throw new TypeError(
        'EPUB dates must be valid ISO 8601 dates or timestamps.',
      );
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime())) return `${value}T00:00:00Z`;
  } else {
    const match =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
        value,
      );
    if (
      !match ||
      !isValidCalendarDate(match[1] ?? '') ||
      Number(match[2]) > 23 ||
      Number(match[3]) > 59 ||
      Number(match[4]) > 59 ||
      (match[6] !== undefined &&
        (Number(match[6]) > 23 || Number(match[7]) > 59))
    )
      throw new TypeError(
        'EPUB dates must be valid ISO 8601 dates or timestamps.',
      );
    const date = new Date(value);
    if (Number.isFinite(date.getTime()))
      return date.toISOString().slice(0, 19) + 'Z';
  }
  throw new TypeError('EPUB dates must be valid ISO 8601 dates or timestamps.');
}

function isValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 100) date.setUTCFullYear(year);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function splitChapters(
  blocks: BlockNode[],
  splitLevel: ChapterHeadingLevel,
): Chapter[] {
  const groups: BlockNode[][] = [];
  let current: BlockNode[] = [];
  let hasChapterHeading = false;
  let wordsSinceHeading = 0;
  const startsAtHeading: boolean[] = [false];
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === splitLevel) {
      if (hasChapterHeading && wordsSinceHeading >= 50) {
        groups.push(current);
        current = [];
        startsAtHeading.push(true);
      }
      hasChapterHeading = true;
      wordsSinceHeading = 0;
    } else if (hasChapterHeading) {
      wordsSinceHeading += wordCount(blockText(block));
    }
    current.push(block);
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) groups.push([]);
  return groups.map((chapterBlocks, index) => {
    const number = String(index + 1).padStart(3, '0');
    return {
      id: `chapter-${number}`,
      path: `chapter-${number}.xhtml`,
      blocks: chapterBlocks,
      markBefore: startsAtHeading[index] ?? false,
    };
  });
}

function splitOversizedChapters(
  input: Chapter[],
  maxChapterSizeBytes: number,
  metadata: PublicationMetadata,
  model: DocumentModel,
  assetPaths: ReadonlyMap<string, string>,
  formulaMode: MathOutputMode,
  chapterMark: ChapterMark,
  splitOnPageBreaks: boolean,
): { chapters: Chapter[]; addedFiles: number; oversizedFiles: number } {
  let chapters = renumberChapters(input);
  let addedFiles = 0;
  const unsplittable = new Set<BlockNode[]>();
  let splitInPass: boolean;

  do {
    splitInPass = false;
    let headings = collectHeadings(chapters);
    let index = 0;
    while (index < chapters.length) {
      const chapter = chapters[index]!;
      if (
        unsplittable.has(chapter.blocks) ||
        measureChapter(chapter, headings) <= maxChapterSizeBytes
      ) {
        index++;
        continue;
      }
      const boundary = findSizeSplitBoundary(
        chapter,
        headings,
        maxChapterSizeBytes,
      );
      if (boundary === undefined) {
        unsplittable.add(chapter.blocks);
        index++;
        continue;
      }
      const split = [
        { ...chapter, blocks: chapter.blocks.slice(0, boundary) },
        {
          ...chapter,
          blocks: chapter.blocks.slice(boundary),
          markBefore: true,
        },
      ];
      chapters.splice(index, 1, ...split);
      chapters = renumberChapters(chapters);
      headings = collectHeadings(chapters);
      addedFiles++;
      splitInPass = true;
    }
  } while (splitInPass);

  const headings = collectHeadings(chapters);
  const oversizedFiles = chapters.filter(
    (chapter) =>
      strToU8(
        chapterXhtml(
          chapter,
          metadata,
          model,
          assetPaths,
          headings,
          formulaMode,
          chapterMark,
        ),
      ).byteLength > maxChapterSizeBytes,
  ).length;
  return { chapters, addedFiles, oversizedFiles };

  function measureChapter(
    chapter: Chapter,
    headingEntries: HeadingEntry[],
  ): number {
    return strToU8(
      chapterXhtml(
        chapter,
        metadata,
        model,
        assetPaths,
        headingEntries,
        formulaMode,
        chapterMark,
      ),
    ).byteLength;
  }

  function findSizeSplitBoundary(
    chapter: Chapter,
    headingEntries: HeadingEntry[],
    limit: number,
  ): number | undefined {
    const blocks = chapter.blocks;
    const candidates = [
      blocks.flatMap((block, index) =>
        index > 0 && block.type === 'heading' ? [index] : [],
      ),
      splitOnPageBreaks
        ? blocks.flatMap((_, index) =>
            index > 0 && blocks[index - 1]?.type === 'pageBreak' ? [index] : [],
          )
        : [],
      blocks.flatMap((block, index) =>
        index > 0 &&
        (block.type === 'paragraph' || blocks[index - 1]?.type === 'paragraph')
          ? [index]
          : [],
      ),
    ];

    for (const boundaries of candidates) {
      let low = 0;
      let high = boundaries.length - 1;
      let fittingBoundary: number | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const boundary = boundaries[middle]!;
        const prefix = {
          ...chapter,
          blocks: blocks.slice(0, boundary),
        };
        if (measureChapter(prefix, headingEntries) <= limit) {
          fittingBoundary = boundary;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (fittingBoundary !== undefined) return fittingBoundary;
    }

    const nextBoundary = candidates
      .flat()
      .sort((left, right) => left - right)[0];
    return nextBoundary;
  }
}

function renumberChapters(chapters: Chapter[]): Chapter[] {
  return chapters.map((chapter, index) => {
    const number = String(index + 1).padStart(3, '0');
    return {
      ...chapter,
      id: `chapter-${number}`,
      path: `chapter-${number}.xhtml`,
    };
  });
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function blockText(block: BlockNode): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return plainText(block.children);
    case 'list':
      return block.items
        .flatMap((item) => item.blocks.map(blockText))
        .join(' ');
    case 'table':
      return [
        ...(block.caption ? [plainText(block.caption)] : []),
        ...block.rows.flatMap((row) =>
          row.cells.flatMap((cell) => cell.blocks.map(blockText)),
        ),
      ].join(' ');
    case 'blockquote':
      return block.blocks.map(blockText).join(' ');
    case 'codeBlock':
      return block.text;
    case 'equationBlock':
    case 'imageBlock':
    case 'thematicBreak':
    case 'pageBreak':
      return '';
  }
}

function createAssetRegistry(model: DocumentModel): AssetEntry[] {
  let imageNumber = 0;
  let fontNumber = 0;
  return Object.keys(model.assets)
    .sort()
    .flatMap((key) => {
      const asset = model.assets[key];
      if (!asset) return [];
      const mediaType = asset.mediaType.toLowerCase();
      const extension = MEDIA_EXTENSIONS[mediaType];
      if (!extension) return [];
      const isFont = mediaType.startsWith('font/');
      const number = isFont ? ++fontNumber : ++imageNumber;
      const base = isFont ? 'font' : 'image';
      const directory = isFont ? 'fonts' : 'images';
      const serial = String(number).padStart(3, '0');
      return [
        {
          asset,
          id: `${base}-${serial}`,
          path: `EPUB/${directory}/${base}-${serial}.${extension}`,
          mediaType,
        },
      ];
    });
}

function collectHeadings(chapters: Chapter[]): HeadingEntry[] {
  const output: HeadingEntry[] = [];
  const visit = (blocks: BlockNode[], path: string): void => {
    for (const block of blocks) {
      if (block.type === 'heading') {
        const text = plainText(block.children);
        const label = block.numbering ? `${block.numbering} ${text}` : text;
        output.push({
          id: block.id ?? slug(text),
          label: label || 'Untitled section',
          path,
          level: block.level,
        });
      } else if (block.type === 'list') {
        for (const item of block.items) visit(item.blocks, path);
      } else if (block.type === 'table') {
        for (const row of block.rows)
          for (const cell of row.cells) visit(cell.blocks, path);
      } else if (block.type === 'blockquote') visit(block.blocks, path);
    }
  };
  for (const chapter of chapters) visit(chapter.blocks, chapter.path);
  return output;
}

function collectPageAnchors(chapters: Chapter[]): HeadingEntry[] {
  const output: HeadingEntry[] = [];
  const visit = (blocks: BlockNode[], path: string): void => {
    for (const block of blocks) {
      if (block.type === 'paragraph' && block.id)
        output.push({ id: block.id, label: '', path, level: 6 });
      else if (block.type === 'list') {
        for (const item of block.items) visit(item.blocks, path);
      } else if (block.type === 'table') {
        for (const row of block.rows)
          for (const cell of row.cells) visit(cell.blocks, path);
      } else if (block.type === 'blockquote') visit(block.blocks, path);
    }
  };
  for (const chapter of chapters) visit(chapter.blocks, chapter.path);
  return output;
}

function createTocRenderEntries(
  entries: readonly TocEntry[],
  headings: readonly HeadingEntry[],
): TocRenderEntry[] {
  const headingById = new Map(headings.map((heading) => [heading.id, heading]));
  const visit = (nodes: ReturnType<typeof nestTocEntries>): TocRenderEntry[] =>
    nodes.flatMap((node) => {
      const heading = headingById.get(node.target);
      if (!heading) return [];
      return [
        {
          ...heading,
          label: node.label,
          level: node.level,
          children: visit(node.children),
        },
      ];
    });
  return visit(nestTocEntries(entries));
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
}

function packageXml(
  metadata: PublicationMetadata,
  chapters: Chapter[],
  assets: AssetEntry[],
  coverPath: 'cover.png' | 'cover.svg' | undefined,
  hasSourceMathml: boolean,
  inlineTocPath: string | undefined,
  tocAtEnd: boolean,
): string {
  const creators = metadata.creators
    .map(({ name, sortAs }, index) => {
      const id = `creator-${index + 1}`;
      const sort = metadata.authorSort ?? sortAs;
      const role = metadata.creators[index]?.role;
      return `<dc:creator id="${id}">${escapeXml(name)}</dc:creator>${sort ? `<meta refines="#${id}" property="file-as">${escapeXml(sort)}</meta>` : ''}${role ? `<meta refines="#${id}" property="role" scheme="marc:relators">${escapeXml(role)}</meta>` : ''}`;
    })
    .join('');
  const contributors = metadata.contributors
    .map(
      ({ name, role, sortAs }, index) =>
        `<dc:contributor id="contributor-${index + 1}">${escapeXml(name)}</dc:contributor>${sortAs ? `<meta refines="#contributor-${index + 1}" property="file-as">${escapeXml(sortAs)}</meta>` : ''}<meta refines="#contributor-${index + 1}" property="role" scheme="marc:relators">${escapeXml(role)}</meta>`,
    )
    .join('');
  const bookProducer = metadata.bookProducer
    ? `<dc:contributor id="book-producer">${escapeXml(metadata.bookProducer)}</dc:contributor><meta refines="#book-producer" property="role" scheme="marc:relators">bkp</meta>`
    : '';
  const dates = [
    metadata.sourceCreatedAt
      ? `<dc:date id="source-created">${escapeXml(metadata.sourceCreatedAt)}</dc:date><meta refines="#source-created" property="event">creation</meta>`
      : '',
    metadata.sourceModifiedAt
      ? `<dc:date id="source-modified">${escapeXml(metadata.sourceModifiedAt)}</dc:date><meta refines="#source-modified" property="event">modification</meta>`
      : '',
    metadata.publicationDate
      ? `<dc:date id="publication-date">${escapeXml(metadata.publicationDate)}</dc:date><meta refines="#publication-date" property="event">publication</meta>`
      : '',
    metadata.conversionDate
      ? `<dc:date>${escapeXml(metadata.conversionDate)}</dc:date>`
      : '',
  ].join('');
  const subtitle = metadata.subtitle
    ? `<dc:title id="subtitle">${escapeXml(metadata.subtitle)}</dc:title><meta refines="#subtitle" property="title-type">subtitle</meta>`
    : '';
  const titleSort = metadata.titleSort
    ? `<meta refines="#title" property="file-as">${escapeXml(metadata.titleSort)}</meta>`
    : '';
  const isbn = metadata.isbn
    ? `<dc:identifier id="isbn-id">${escapeXml(metadata.isbn)}</dc:identifier><meta refines="#isbn-id" property="identifier-type" scheme="onix:codelist5">15</meta>`
    : '';
  const series = metadata.series
    ? `<meta property="belongs-to-collection" id="series">${escapeXml(metadata.series)}</meta><meta refines="#series" property="collection-type">series</meta>${metadata.seriesIndex !== undefined ? `<meta refines="#series" property="group-position">${metadata.seriesIndex}</meta>` : ''}`
    : '';
  if (metadata.seriesIndex !== undefined && !metadata.series)
    throw new TypeError('EPUB series index requires a series name.');
  if (metadata.authorSort && metadata.creators.length === 0)
    throw new TypeError('EPUB author sort requires at least one author.');
  const subjects = metadata.subjects
    .map((subject) => `<dc:subject>${escapeXml(subject)}</dc:subject>`)
    .join('');
  const additionalMetadata = [
    subtitle,
    titleSort,
    metadata.publisher
      ? `<dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`
      : '',
    metadata.description
      ? `<dc:description>${escapeXml(metadata.description)}</dc:description>`
      : '',
    subjects,
    metadata.version
      ? `<meta property="dcterms:hasVersion">${escapeXml(metadata.version)}</meta>`
      : '',
    metadata.rights
      ? `<dc:rights>${escapeXml(metadata.rights)}</dc:rights>`
      : '',
    dates,
    isbn,
    series,
    contributors,
    bookProducer,
  ].join('');
  const chapterProperties = hasSourceMathml ? ' properties="mathml"' : '';
  const chapterItems = chapters
    .map(
      ({ id, path }) =>
        `<item id="${id}" href="${path}" media-type="application/xhtml+xml"${chapterProperties}/>`,
    )
    .join('');
  const inlineTocItem = inlineTocPath
    ? `<item id="inline-toc" href="${inlineTocPath}" media-type="application/xhtml+xml"/>`
    : '';
  const assetItems = assets
    .map(
      ({ id, path, mediaType }) =>
        `<item id="${id}" href="${escapeAttribute(path.replace('EPUB/', ''))}" media-type="${mediaType}"/>`,
    )
    .join('');
  const spine = chapters.map(({ id }) => `<itemref idref="${id}"/>`).join('');
  const inlineTocSpine = inlineTocPath ? `<itemref idref="inline-toc"/>` : '';
  const contentsSpine = tocAtEnd
    ? `${spine}${inlineTocSpine}`
    : `${inlineTocSpine}${spine}`;
  const coverItems = coverPath
    ? `<item id="cover-image" href="${coverPath}" media-type="${coverPath === 'cover.png' ? 'image/png' : 'image/svg+xml'}" properties="cover-image"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`
    : '';
  const coverSpine = coverPath ? '<itemref idref="cover-page"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeAttribute(metadata.language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${escapeXml(metadata.identifier)}</dc:identifier><dc:title id="title">${escapeXml(metadata.title)}</dc:title><dc:language>${escapeXml(metadata.language)}</dc:language>${creators}${additionalMetadata}<meta property="dcterms:modified">${escapeXml(metadata.modified)}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="styles" href="styles.css" media-type="text/css"/>${coverItems}<item id="title-page" href="title.xhtml" media-type="application/xhtml+xml"/>${inlineTocItem}${chapterItems}${assetItems}</manifest><spine>${coverSpine}<itemref idref="title-page"/>${contentsSpine}</spine></package>`;
}

function coverXhtml(
  metadata: PublicationMetadata,
  coverPath: 'cover.png' | 'cover.svg',
): string {
  return xhtmlDocument(
    metadata,
    `Cover for ${metadata.title}`,
    `<section epub:type="cover"><img src="${coverPath}" alt="Cover for ${escapeAttribute(metadata.title)}"/></section>`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function navXhtml(
  metadata: PublicationMetadata,
  headings: TocRenderEntry[],
  title: string,
  hasCover: boolean,
  startTarget: { path: string; id?: string },
  pageList: readonly PageListEntry[],
): string {
  const items = headings.length
    ? renderTocEntries(headings)
    : '<li><a href="chapter-001.xhtml">Document</a></li>';
  const startHref = `${startTarget.path}${startTarget.id ? `#${escapeAttribute(startTarget.id)}` : ''}`;
  const landmarks = `<nav epub:type="landmarks" hidden="hidden"><h2>Guide</h2><ol>${hasCover ? '<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>' : ''}<li><a epub:type="titlepage" href="title.xhtml">Title page</a></li><li><a epub:type="bodymatter" href="${escapeAttribute(startHref)}">Start of content</a></li></ol></nav>`;
  const pageNavigation = pageList.length
    ? `<nav epub:type="page-list" id="page-list"><h2>Pages</h2><ol>${pageList
        .map(
          ({ path, id, label }) =>
            `<li><a href="${escapeAttribute(path)}#${escapeAttribute(id)}">${escapeXml(label)}</a></li>`,
        )
        .join('')}</ol></nav>`
    : '';
  return xhtmlDocument(
    metadata,
    title,
    `<nav epub:type="toc" id="toc"><h1>${escapeXml(title)}</h1><ol>${items}</ol></nav>${landmarks}${pageNavigation}`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function contentsXhtml(
  metadata: PublicationMetadata,
  headings: TocRenderEntry[],
  title: string,
): string {
  const list = headings.length
    ? `<ol>${renderTocEntries(headings)}</ol>`
    : '<p>No contents available.</p>';
  return xhtmlDocument(
    metadata,
    title,
    `<section class="inline-toc"><h1>${escapeXml(title)}</h1>${list}</section>`,
  );
}

function renderTocEntries(entries: readonly TocRenderEntry[]): string {
  return entries
    .map(
      ({ path, id, label, children }) =>
        `<li><a href="${path}#${escapeAttribute(id)}">${escapeXml(label)}</a>${children.length ? `<ol>${renderTocEntries(children)}</ol>` : ''}</li>`,
    )
    .join('');
}

function titleXhtml(
  metadata: PublicationMetadata,
  model: DocumentModel,
): string {
  const subtitle = model.metadata.subtitle?.value;
  const authors = model.metadata.authors
    .map(({ value }) => `<p class="author">${escapeXml(value.name)}</p>`)
    .join('');
  return xhtmlDocument(
    metadata,
    metadata.title,
    `<section epub:type="titlepage"><h1>${escapeXml(metadata.title)}</h1>${subtitle ? `<p class="subtitle">${escapeXml(subtitle)}</p>` : ''}${authors}</section>`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function chapterXhtml(
  chapter: Chapter,
  metadata: PublicationMetadata,
  model: DocumentModel,
  assetPaths: ReadonlyMap<string, string>,
  headings: HeadingEntry[],
  formulaMode: MathOutputMode,
  chapterMark: ChapterMark,
  pageMarkers: ReadonlyMap<string, string> = new Map(),
): string {
  const firstHeading = headings.find(({ path }) => path === chapter.path);
  const context: RenderContext = {
    model,
    assetPaths,
    headings,
    headingIndex: headings.findIndex(({ path }) => path === chapter.path),
    chapterPath: chapter.path,
    referencedNotes: [],
    formulaMode,
    pageMarkers,
  };
  if (context.headingIndex < 0) context.headingIndex = headings.length;
  const marker =
    chapter.markBefore &&
    (chapterMark === 'pagebreak' ||
      chapterMark === 'rule' ||
      chapterMark === 'both')
      ? `${chapterMark === 'pagebreak' || chapterMark === 'both' ? '<div class="page-break chapter-page-break" aria-hidden="true"></div>' : ''}${chapterMark === 'rule' || chapterMark === 'both' ? '<hr class="chapter-rule"/>' : ''}`
      : '';
  const body = `${marker}${renderBlocks(chapter.blocks, context)}`;
  return xhtmlDocument(
    metadata,
    firstHeading?.label ?? metadata.title,
    `${body}${renderNotes(context)}`,
    ' xmlns:epub="http://www.idpf.org/2007/ops"',
  );
}

function xhtmlDocument(
  metadata: PublicationMetadata,
  title: string,
  body: string,
  namespace = '',
): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"${namespace} xml:lang="${escapeAttribute(metadata.language)}" lang="${escapeAttribute(metadata.language)}"><head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body>${body}</body></html>`;
}

function renderBlocks(blocks: BlockNode[], context: RenderContext): string {
  return blocks.map((block) => renderBlock(block, context)).join('');
}

function renderBlock(block: BlockNode, context: RenderContext): string {
  switch (block.type) {
    case 'paragraph': {
      const classes = paragraphIndentClasses(block.indent);
      const id = block.id ? ` id="${escapeAttribute(block.id)}"` : '';
      return `${context.pageMarkers.get(block.id ?? '') ?? ''}<p${id}${classes ? ` class="${classes}"` : ''}>${renderInlines(block.children, context)}</p>`;
    }
    case 'heading': {
      const heading = context.headings[context.headingIndex++];
      const numbering = block.numbering ? `${escapeXml(block.numbering)} ` : '';
      return `${context.pageMarkers.get(heading?.id ?? '') ?? ''}<h${block.level} id="${escapeAttribute(heading?.id ?? 'section')}">${numbering}${renderInlines(block.children, context)}</h${block.level}>`;
    }

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const start =
        block.ordered && block.start !== undefined
          ? ` start="${block.start}"`
          : '';
      return `<${tag}${start}>${block.items.map((item) => `<li>${renderBlocks(item.blocks, context)}</li>`).join('')}</${tag}>`;
    }
    case 'table':
      return `<table>${block.caption ? `<caption>${renderInlines(block.caption, context)}</caption>` : ''}<tbody>${block.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell) => {
                const tag = cell.header ? 'th' : 'td';
                const colSpan =
                  cell.colSpan === undefined
                    ? ''
                    : ` colspan="${cell.colSpan}"`;
                const rowSpan =
                  cell.rowSpan === undefined
                    ? ''
                    : ` rowspan="${cell.rowSpan}"`;
                return `<${tag}${colSpan}${rowSpan}>${renderBlocks(cell.blocks, context)}</${tag}>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</tbody></table>`;
    case 'blockquote':
      return `<blockquote>${renderBlocks(block.blocks, context)}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${escapeXml(block.text)}</code></pre>`;
    case 'equationBlock':
      return `<div class="equation" role="math">${renderEquation(block.equationId, true, context)}</div>`;
    case 'imageBlock': {
      const image = renderImage(block.assetId, block.alt, undefined, context);
      if (!image) return '';
      return `<figure${imageBlockAttributes(block)}>${image}${block.caption ? `<figcaption>${renderInlines(block.caption, context)}</figcaption>` : ''}</figure>`;
    }
    case 'thematicBreak':
      return '<hr/>';
    case 'pageBreak':
      return '<div class="page-break" aria-hidden="true"></div>';
  }
}

function imageBlockAttributes(
  block: Extract<BlockNode, { type: 'imageBlock' }>,
): string {
  const alignment = block.alignment;
  if (
    !Number.isFinite(block.width) ||
    block.width === undefined ||
    block.width <= 0 ||
    block.width > 1 ||
    (alignment !== 'left' && alignment !== 'center' && alignment !== 'right')
  )
    return '';
  const percentage = Math.max(5, Math.round(block.width * 20) * 5);
  return ` class="image-block image-${alignment} image-width-${percentage}"`;
}

function paragraphIndentClasses(
  indent: Extract<BlockNode, { type: 'paragraph' }>['indent'],
): string {
  if (!indent) return '';
  return [
    indent.firstLine === undefined
      ? ''
      : `indent-first-line-${Math.round(indent.firstLine * 100)}`,
    indent.hanging === undefined
      ? ''
      : `indent-hanging-${Math.round(indent.hanging * 100)}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function renderInlines(nodes: InlineNode[], context: RenderContext): string {
  return nodes.map((node) => renderInline(node, context)).join('');
}

function renderInline(node: InlineNode, context: RenderContext): string {
  switch (node.type) {
    case 'text':
      return applyMarks(escapeXml(node.text), node.marks ?? []);
    case 'link': {
      const content = renderInlines(node.children, context);
      const href = resolveEpubHref(node.href, context);
      return href
        ? `<a href="${escapeAttribute(href)}"${node.title ? ` title="${escapeAttribute(node.title)}"` : ''}>${content}</a>`
        : content;
    }
    case 'image':
      return renderImage(
        node.assetId,
        node.alt,
        node.title,
        context,
        imageInlineAttributes(node),
      );
    case 'equation':
      return `<span class="equation" role="math">${renderEquation(node.equationId, false, context)}</span>`;
    case 'noteReference': {
      if (!context.referencedNotes.includes(node.noteId))
        context.referencedNotes.push(node.noteId);
      const id = slug(node.noteId);
      return `<a id="note-ref-${id}" href="#note-${id}" epub:type="noteref">[${context.referencedNotes.indexOf(node.noteId) + 1}]</a>`;
    }
    case 'lineBreak':
      return '<br/>';
    case 'softBreak':
      return '\n';
  }
}

function resolveEpubHref(
  href: string,
  context: RenderContext,
): string | undefined {
  const safe = safeHref(href);
  if (!safe?.startsWith('#')) return safe;
  const target = context.headings.find(({ id }) => id === safe.slice(1));
  if (!target || target.path === context.chapterPath) return safe;
  return `${target.path.replace(/^EPUB\//, '')}${safe}`;
}

function applyMarks(value: string, marks: TextMark[]): string {
  return marks.reduce((content, mark) => {
    if (mark.type === 'bold') return `<strong>${content}</strong>`;
    if (mark.type === 'italic') return `<em>${content}</em>`;
    if (mark.type === 'underline')
      return `<span class="underline">${content}</span>`;
    if (mark.type === 'strikethrough') return `<s>${content}</s>`;
    if (mark.type === 'subscript') return `<sub>${content}</sub>`;
    if (mark.type === 'superscript') return `<sup>${content}</sup>`;
    if (mark.type === 'code') return `<code>${content}</code>`;
    if (mark.type === 'style')
      return `<span class="style-${slug(mark.styleId)}">${content}</span>`;
    return content;
  }, value);
}

function renderImage(
  assetId: string,
  alt: string | undefined,
  title: string | undefined,
  context: RenderContext,
  attributes = '',
): string {
  const path = context.assetPaths.get(assetId);
  if (!path) return '';
  return `<img src="${escapeAttribute(path)}" alt="${escapeAttribute(alt ?? '')}"${title ? ` title="${escapeAttribute(title)}"` : ''}${attributes}/>`;
}

function imageInlineAttributes(
  image: Extract<InlineNode, { type: 'image' }>,
): string {
  if (
    image.presentation !== 'equation' ||
    !Number.isFinite(image.width) ||
    image.width === undefined ||
    image.width <= 0 ||
    image.width > 1
  )
    return '';
  const percentage = Math.max(5, Math.round(image.width * 20) * 5);
  return ` class="equation-image image-width-${percentage}"`;
}

function renderEquation(
  id: string,
  display: boolean,
  context: RenderContext,
): string {
  return renderMathEquation(context.model.equations[id], {
    mode: context.formulaMode,
    display,
  });
}

function renderNotes(context: RenderContext): string {
  const notes = context.referencedNotes.flatMap((id) => {
    const note = context.model.notes[id];
    if (!note) return [];
    const safe = slug(id);
    return [
      `<li id="note-${safe}" epub:type="footnote">${renderBlocks(note.blocks, context)}<a href="#note-ref-${safe}">↩</a></li>`,
    ];
  });
  return notes.length
    ? `<section epub:type="footnotes"><ol>${notes.join('')}</ol></section>`
    : '';
}

function safeHref(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^#[A-Za-z0-9_.:-]+$/.test(trimmed)) return trimmed;
  return undefined;
}

function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.type === 'text'
        ? node.text
        : node.type === 'link'
          ? plainText(node.children)
          : '',
    )
    .join('');
}

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

function escapeXml(value: string): string {
  return Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const allowed =
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      return allowed ? character : '�';
    })
    .join('')
    .replace(/[&<>]/g, (character) =>
      character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;',
    );
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
