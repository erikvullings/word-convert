import type {
  CancellationSignal,
  ConversionProgress,
} from '@wordconvert/document-model';
import {
  GlobalWorkerOptions,
  ImageKind,
  OPS,
  Util,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  TextContent,
  TextItem,
} from 'pdfjs-dist/types/src/display/api.d.ts';
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport.d.ts';

import type {
  RawPdfDocument,
  RawPdfImage,
  RawPdfLink,
  RawPdfMetadata,
  RawPdfOutlineItem,
  RawPdfPage,
  RawPdfStructureNode,
  RawPdfTextSpan,
} from './index.ts';
import { PdfReadError } from './error.ts';
import { rgbaToPng } from './png.ts';

export interface PdfReaderLimits {
  maxInputBytes: number;
  maxPages: number;
  maxTextItems: number;
  maxTextItemsPerPage: number;
  maxImages: number;
  maxImagePixels: number;
  maxTotalImagePixels: number;
}

export interface PdfExtractionOptions {
  limits: PdfReaderLimits;
  samplePageCount?: number;
  cancellation?: CancellationSignal;
  onProgress?: (progress: ConversionProgress) => void;
  figureRasterizer?: PdfFigureRasterizer;
}

export interface PdfFigureSurface {
  canvas: unknown;
  encodePng(): Promise<Uint8Array>;
  dispose(): void;
}

export interface PdfFigureRasterizer {
  CanvasFactory: new (options: { enableHWA?: boolean }) => object;
  FilterFactory: new (options: { docId: string }) => object;
  createSurface(width: number, height: number): PdfFigureSurface;
}

interface PdfJsImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

interface PdfJsAnnotation {
  subtype?: unknown;
  url?: unknown;
  rect?: unknown;
}

interface PdfJsInlineImageMap {
  transform: Matrix;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PdfImageBudget {
  images: number;
  pixels: number;
}

type Matrix = [number, number, number, number, number, number];

export function configurePdfJsWorker(workerSrc: string): void {
  GlobalWorkerOptions.workerSrc = workerSrc;
}

export async function extractPdfWithPdfJs(
  input: Uint8Array,
  options: PdfExtractionOptions,
): Promise<RawPdfDocument> {
  if (input.byteLength > options.limits.maxInputBytes)
    throw new PdfReadError(
      'resource-limit',
      'PDF exceeds the input size limit.',
      {
        phase: 'inspect',
        details: {
          limit: options.limits.maxInputBytes,
          actual: input.byteLength,
        },
      },
    );
  throwIfCancelled(options.cancellation);
  const loading = getDocument({
    data: Uint8Array.from(input),
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    verbosity: 0,
    ...(options.figureRasterizer
      ? {
          CanvasFactory: options.figureRasterizer.CanvasFactory,
          FilterFactory: options.figureRasterizer.FilterFactory,
        }
      : {}),
  });
  let document: PDFDocumentProxy | undefined;
  try {
    document = await loading.promise;
    if (document.numPages > options.limits.maxPages)
      throw new PdfReadError('resource-limit', 'PDF exceeds the page limit.', {
        phase: 'inspect',
        details: {
          limit: options.limits.maxPages,
          actual: document.numPages,
        },
      });
    const [metadata, outline] = await Promise.all([
      readMetadata(document),
      readOutline(document),
    ]);
    const pageNumbers = representativePageNumbers(
      document.numPages,
      options.samplePageCount,
    );
    const isSample = pageNumbers.length < document.numPages;
    const pages: RawPdfPage[] = [];
    let textItems = 0;
    const imageBudget: PdfImageBudget = { images: 0, pixels: 0 };
    for (const [index, pageNumber] of pageNumbers.entries()) {
      throwIfCancelled(options.cancellation);
      options.onProgress?.({
        phase: 'read',
        completed: index,
        total: pageNumbers.length,
        message: `Reading PDF page ${pageNumber}.`,
      });
      const page = await document.getPage(pageNumber);
      try {
        const extracted = await readPage(
          page,
          pageNumber,
          options.limits,
          imageBudget,
          options.cancellation,
          !isSample,
          options.figureRasterizer,
        );
        textItems += extracted.spans.length;
        if (textItems > options.limits.maxTextItems)
          throw new PdfReadError(
            'resource-limit',
            'PDF exceeds the text item limit.',
            {
              phase: 'read',
              details: {
                limit: options.limits.maxTextItems,
                actual: textItems,
              },
            },
          );
        pages.push(extracted);
      } finally {
        page.cleanup();
      }
    }
    options.onProgress?.({
      phase: 'read',
      completed: pageNumbers.length,
      total: pageNumbers.length,
    });
    return {
      version: 1,
      pageCount: document.numPages,
      pages,
      metadata,
      outline,
    };
  } catch (cause) {
    if (cause instanceof PdfReadError) throw cause;
    const name = errorName(cause);
    if (name === 'PasswordException')
      throw new PdfReadError(
        'encrypted-document',
        'Password-protected PDFs are not supported.',
        { phase: 'read', cause },
      );
    if (name === 'InvalidPDFException' || name === 'FormatError')
      throw new PdfReadError(
        'invalid-input',
        'The PDF is malformed or invalid.',
        {
          phase: 'read',
          cause,
        },
      );
    throw new PdfReadError('conversion-failed', 'The PDF could not be read.', {
      phase: 'read',
      recoverable: true,
      cause,
    });
  } finally {
    await loading.destroy();
  }
}

export function representativePageNumbers(
  totalPages: number,
  samplePageCount?: number,
): number[] {
  if (samplePageCount === undefined)
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (!Number.isInteger(samplePageCount) || samplePageCount < 1)
    throw new PdfReadError(
      'invalid-input',
      'PDF sample page count must be a positive integer.',
      { phase: 'inspect', recoverable: true },
    );
  if (samplePageCount >= totalPages)
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (samplePageCount === 1) return [1];
  return Array.from(
    { length: samplePageCount },
    (_, index) =>
      1 + Math.round((index * (totalPages - 1)) / (samplePageCount - 1)),
  );
}

async function readPage(
  page: PDFPageProxy,
  pageNumber: number,
  limits: PdfReaderLimits,
  imageBudget: PdfImageBudget,
  cancellation?: CancellationSignal,
  includeImages = true,
  figureRasterizer?: PdfFigureRasterizer,
): Promise<RawPdfPage> {
  const viewport = page.getViewport({ scale: 1 });
  const [text, annotations, structure] = await Promise.all([
    page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: false,
    }),
    page.getAnnotations({ intent: 'display' }),
    page.getStructTree(),
  ]);
  throwIfCancelled(cancellation);
  if (text.items.length > limits.maxTextItemsPerPage)
    throw new PdfReadError(
      'resource-limit',
      'A PDF page exceeds the text item limit.',
      {
        phase: 'read',
        details: {
          limit: limits.maxTextItemsPerPage,
          actual: text.items.length,
        },
      },
    );
  const links = readLinks(annotations, viewport);
  const spans = readSpans(
    text,
    links,
    viewport.width,
    viewport.height,
    viewport.transform as Matrix,
    pageNumber,
  );
  const images = includeImages
    ? await readImages(
        page,
        viewport.transform as Matrix,
        limits,
        cancellation,
        imageBudget,
        figureRasterizer,
        spans,
      )
    : [];
  const figureRegions = images.filter(
    ({ source }) => source === 'rendered-figure',
  );
  return {
    number: pageNumber,
    width: viewport.width,
    height: viewport.height,
    rotation: viewport.rotation,
    spans: spans.filter(
      (span) => !figureRegions.some((region) => intersects(span, region)),
    ),
    links,
    images,
    ...(structure ? { taggedStructure: readStructure(structure) } : {}),
  };
}

export function readSpans(
  content: TextContent,
  links: readonly RawPdfLink[],
  pageWidth: number,
  pageHeight: number,
  viewportTransform: Matrix,
  pageNumber = 1,
): RawPdfTextSpan[] {
  const spans: RawPdfTextSpan[] = [];
  let markedContentId: string | undefined;
  let index = 0;
  for (const item of content.items) {
    if (!isTextItem(item)) {
      if (item.type === 'endMarkedContent') markedContentId = undefined;
      else if (item.id) markedContentId = item.id;
      continue;
    }
    if (!item.str) continue;
    const transform = Util.transform(
      viewportTransform,
      item.transform as Matrix,
    ) as Matrix;
    const fontHeight = Math.hypot(transform[2], transform[3]) || item.height;
    const baselineScale = Math.hypot(transform[0], transform[1]) || 1;
    const baseline = [
      (transform[0] / baselineScale) * item.width,
      (transform[1] / baselineScale) * item.width,
    ] as const;
    const points: [number, number][] = [
      [transform[4], transform[5]],
      [transform[4] + baseline[0], transform[5] + baseline[1]],
      [transform[4] + transform[2], transform[5] + transform[3]],
      [
        transform[4] + baseline[0] + transform[2],
        transform[5] + baseline[1] + transform[3],
      ],
    ];
    const left = Math.min(...points.map(([pointX]) => pointX));
    const right = Math.max(...points.map(([pointX]) => pointX));
    const upper = Math.min(...points.map(([, pointY]) => pointY));
    const lower = Math.max(...points.map(([, pointY]) => pointY));
    const x = clamp(left / pageWidth);
    const top = clamp(upper / pageHeight);
    const width = clamp((right - left) / pageWidth, 0, 1 - x);
    const height = clamp((lower - upper) / pageHeight, 0.001, 1 - top);
    const style = content.styles[item.fontName];
    const fontFamily = style?.fontFamily;
    const fontSignature = `${item.fontName} ${fontFamily ?? ''}`;
    const linkId = links.find((link) =>
      intersects({ x, top, width, height }, link),
    )?.id;
    spans.push({
      id: `pdf-span-${pageNumber}-${index++}`,
      text: item.str,
      x,
      top,
      width,
      height,
      fontId: stableFontId(fontFamily, fontSignature),
      ...(fontFamily ? { fontFamily } : {}),
      fontSize: fontHeight,
      bold: /bold|black|heavy|semibold|demi/i.test(fontSignature),
      italic: /italic|oblique/i.test(fontSignature),
      direction: item.dir === 'rtl' || item.dir === 'ttb' ? item.dir : 'ltr',
      ...(linkId ? { linkId } : {}),
      ...(markedContentId ? { markedContentId } : {}),
    });
  }

  function stableFontId(
    fontFamily: string | undefined,
    fontSignature: string,
  ): string {
    const family = (fontFamily ?? 'unknown')
      .toLocaleLowerCase('en')
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '');
    const weight = /bold|black|heavy|semibold|demi/i.test(fontSignature)
      ? 'bold'
      : 'regular';
    const posture = /italic|oblique/i.test(fontSignature) ? 'italic' : 'roman';
    return `pdf-font-${family || 'unknown'}-${weight}-${posture}`;
  }
  return spans;
}

function readLinks(
  annotations: readonly unknown[],
  viewport: PageViewport,
): RawPdfLink[] {
  const links: RawPdfLink[] = [];
  for (const annotation of annotations) {
    if (!isRecord(annotation)) continue;
    const value = annotation as PdfJsAnnotation;
    if (
      value.subtype !== 'Link' ||
      typeof value.url !== 'string' ||
      !isSafeLink(value.url) ||
      !isNumberArray(value.rect, 4)
    )
      continue;
    const first = viewport.convertToViewportPoint(
      value.rect[0]!,
      value.rect[1]!,
    );
    const second = viewport.convertToViewportPoint(
      value.rect[2]!,
      value.rect[3]!,
    );
    const rectangle = [first[0]!, first[1]!, second[0]!, second[1]!];
    const left = Math.min(rectangle[0]!, rectangle[2]!);
    const top = Math.min(rectangle[1]!, rectangle[3]!);
    const right = Math.max(rectangle[0]!, rectangle[2]!);
    const bottom = Math.max(rectangle[1]!, rectangle[3]!);
    links.push({
      id: `pdf-link-${links.length}`,
      href: value.url,
      x: clamp(left / viewport.width),
      top: clamp(top / viewport.height),
      width: clamp((right - left) / viewport.width),
      height: clamp((bottom - top) / viewport.height),
    });
  }
  return links;
}

export async function readImages(
  page: PDFPageProxy,
  viewportTransform: Matrix,
  limits: PdfReaderLimits,
  cancellation?: CancellationSignal,
  imageBudget: PdfImageBudget = { images: 0, pixels: 0 },
  figureRasterizer?: PdfFigureRasterizer,
  spans: readonly RawPdfTextSpan[] = [],
): Promise<RawPdfImage[]> {
  const operators = await page.getOperatorList();
  throwIfCancelled(cancellation);
  const images: RawPdfImage[] = [];
  const stack: Matrix[] = [];
  const vectorBounds: NormalizedBounds[] = [];
  let transform: Matrix = [1, 0, 0, 1, 0, 0];
  for (let index = 0; index < operators.fnArray.length; index++) {
    if (index % 100 === 0) {
      await yieldToEventLoop();
      throwIfCancelled(cancellation);
    }
    const operation = operators.fnArray[index];
    const args = operators.argsArray[index] as unknown[] | undefined;
    if (operation === OPS.save) stack.push([...transform]);
    else if (operation === OPS.restore) transform = stack.pop() ?? transform;
    else if (operation === OPS.transform && isNumberArray(args, 6))
      transform = multiply(transform, args);
    else if (
      operation === OPS.constructPath &&
      isNumberSequence(args?.[2]) &&
      args[2].length >= 4
    ) {
      const viewport = page.getViewport({ scale: 1 });
      vectorBounds.push(
        rectangleBounds(
          multiply(viewportTransform, transform),
          args[2][0]!,
          args[2][1]!,
          args[2][2]!,
          args[2][3]!,
          viewport.width,
          viewport.height,
        ),
      );
    } else if (
      operation === OPS.paintImageXObject &&
      typeof args?.[0] === 'string'
    ) {
      const image = await objectValue<PdfJsImage>(page, args[0]);
      if (image)
        await appendImage(
          images,
          page,
          image,
          transform,
          viewportTransform,
          limits,
          imageBudget,
          cancellation,
        );
    } else if (
      operation === OPS.paintInlineImageXObject &&
      isPdfJsImage(args?.[0])
    ) {
      await appendImage(
        images,
        page,
        args[0],
        transform,
        viewportTransform,
        limits,
        imageBudget,
        cancellation,
      );
    } else if (
      operation === OPS.paintInlineImageXObjectGroup &&
      isPdfJsImage(args?.[0]) &&
      Array.isArray(args[1])
    ) {
      enforceImageLimit(args[0], limits);
      const atlas = await imageRgba(args[0], cancellation);
      for (const entry of args[1]) {
        if (!isInlineImageMap(entry)) continue;
        const image = cropRgbaImage(atlas, args[0].width, entry);
        await appendImage(
          images,
          page,
          image,
          multiply(transform, entry.transform),
          viewportTransform,
          limits,
          imageBudget,
          cancellation,
        );
      }
    } else if (
      operation === OPS.paintImageXObjectRepeat &&
      typeof args?.[0] === 'string' &&
      typeof args[1] === 'number' &&
      typeof args[2] === 'number' &&
      isNumberSequence(args[3])
    ) {
      const image = await objectValue<PdfJsImage>(page, args[0]);
      if (!image?.data) continue;
      enforceImageLimit(image, limits);
      reserveImages(image, Math.floor(args[3].length / 2), limits, imageBudget);
      const data = await encodeImage(image, cancellation);
      for (let position = 0; position + 1 < args[3].length; position += 2) {
        await appendImage(
          images,
          page,
          image,
          multiply(transform, [
            args[1],
            0,
            0,
            args[2],
            args[3][position]!,
            args[3][position + 1]!,
          ]),
          viewportTransform,
          limits,
          imageBudget,
          cancellation,
          data,
          true,
        );
      }
    }
  }
  if (!figureRasterizer) return images;
  const regions = figureRegions(vectorBounds, images, spans);
  const standaloneImages = images.filter(
    (image) => !regions.some((region) => intersects(image, region)),
  );
  for (const [index, region] of regions.entries()) {
    standaloneImages.push(
      await rasterizeFigure(
        page,
        region,
        index,
        limits,
        imageBudget,
        figureRasterizer,
        cancellation,
        images,
      ),
    );
  }
  return standaloneImages;
}

interface NormalizedBounds {
  x: number;
  top: number;
  width: number;
  height: number;
}

function figureRegions(
  bounds: readonly NormalizedBounds[],
  images: readonly RawPdfImage[] = [],
  spans: readonly RawPdfTextSpan[] = [],
): NormalizedBounds[] {
  const groups = [
    ...bounds
      .filter(({ width, height }) => width > 0 || height > 0)
      .map((region) => ({ region, paths: 1, imageSeed: false })),
    ...images
      .filter(
        ({ width, height }) =>
          width >= 0.12 && height >= 0.06 && width * height <= 0.7,
      )
      .map((region) => ({ region, paths: 0, imageSeed: true })),
  ];
  let merged = true;
  while (merged) {
    merged = false;
    for (let leftIndex = 0; leftIndex < groups.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < groups.length;
        rightIndex++
      ) {
        const left = groups[leftIndex]!;
        const right = groups[rightIndex]!;
        if (!nearby(left.region, right.region, 0.015)) continue;
        left.region = unionBounds(left.region, right.region);
        left.paths += right.paths;
        left.imageSeed ||= right.imageSeed;
        groups.splice(rightIndex, 1);
        merged = true;
        rightIndex--;
      }
    }
  }
  const regions = groups
    .filter(
      ({ region, paths, imageSeed }) =>
        (imageSeed || paths >= 4) &&
        region.width >= 0.12 &&
        region.height >= 0.06 &&
        region.width * region.height <= 0.7,
    )
    .map(({ region }) => region);
  regions.push(...displayEquationRegions(spans));
  return regions.map((region) =>
    padBounds(expandToNearbyLabel(region, spans), 0.008),
  );
}

function expandToNearbyLabel(
  region: NormalizedBounds,
  spans: readonly RawPdfTextSpan[],
): NormalizedBounds {
  const center = region.x + region.width / 2;
  const labels = spans.filter((span) => {
    const bottom = span.top + span.height;
    const spanCenter = span.x + span.width / 2;
    return (
      span.text.trim().length >= 3 &&
      span.text.trim().length <= 80 &&
      !/[.!?]$/.test(span.text.trim()) &&
      bottom <= region.top &&
      region.top - bottom <= 0.04 &&
      Math.abs(spanCenter - center) <= Math.max(region.width * 0.4, 0.04)
    );
  });
  return labels.reduce<NormalizedBounds>(unionBounds, region);
}

function displayEquationRegions(
  spans: readonly RawPdfTextSpan[],
): NormalizedBounds[] {
  return spans
    .filter(
      (span) =>
        span.text.includes('=') && span.x >= 0.22 && span.text.length <= 80,
    )
    .flatMap((anchor) => {
      const members = spans.filter(
        (span) =>
          span.top >= anchor.top - 0.02 &&
          span.top <= anchor.top + 0.035 &&
          span.x >= 0.15 &&
          span.x + span.width <= 0.9,
      );
      if (members.length < 3) return [];
      const region = members
        .map<NormalizedBounds>(({ x, top, width, height }) => ({
          x,
          top,
          width,
          height,
        }))
        .reduce(unionBounds);
      return region.width >= 0.15 ? [region] : [];
    });
}

async function rasterizeFigure(
  page: PDFPageProxy,
  region: NormalizedBounds,
  index: number,
  limits: PdfReaderLimits,
  imageBudget: PdfImageBudget,
  rasterizer: PdfFigureRasterizer,
  cancellation?: CancellationSignal,
  sourceImages: readonly RawPdfImage[] = [],
): Promise<RawPdfImage> {
  const base = page.getViewport({ scale: 1 });
  const regionPixels = base.width * region.width * base.height * region.height;
  const sourceScale = sourceImages
    .filter((image) => intersects(image, region))
    .reduce(
      (maximum, image) =>
        Math.max(
          maximum,
          image.pixelWidth / (base.width * image.width),
          image.pixelHeight / (base.height * image.height),
        ),
      2,
    );
  const scale = Math.min(
    sourceScale,
    Math.sqrt(limits.maxImagePixels / regionPixels),
  );
  const viewport = page.getViewport({ scale });
  const pixelWidth = Math.max(1, Math.ceil(viewport.width * region.width));
  const pixelHeight = Math.max(1, Math.ceil(viewport.height * region.height));
  reserveImages(
    { width: pixelWidth, height: pixelHeight },
    1,
    limits,
    imageBudget,
  );
  const surface = rasterizer.createSurface(pixelWidth, pixelHeight);
  try {
    const task = page.render({
      canvas: surface.canvas as never,
      viewport,
      transform: [
        1,
        0,
        0,
        1,
        -region.x * viewport.width,
        -region.top * viewport.height,
      ],
      background: '#ffffff',
    });
    await task.promise;
    throwIfCancelled(cancellation);
    return {
      id: `pdf-figure-${page.pageNumber}-${index}`,
      ...region,
      pixelWidth,
      pixelHeight,
      mediaType: 'image/png',
      data: await surface.encodePng(),
      source: 'rendered-figure',
    };
  } finally {
    surface.dispose();
  }
}

async function appendImage(
  images: RawPdfImage[],
  page: PDFPageProxy,
  image: PdfJsImage,
  transform: Matrix,
  viewportTransform: Matrix,
  limits: PdfReaderLimits,
  imageBudget: PdfImageBudget,
  cancellation?: CancellationSignal,
  encodedData?: Uint8Array,
  reserved = false,
): Promise<void> {
  if (!image.data || image.width <= 0 || image.height <= 0) return;
  enforceImageLimit(image, limits);
  if (!reserved) reserveImages(image, 1, limits, imageBudget);
  const viewport = page.getViewport({ scale: 1 });
  const bounds = imageBounds(
    multiply(viewportTransform, transform),
    viewport.width,
    viewport.height,
  );
  const data = encodedData ?? (await encodeImage(image, cancellation));
  throwIfCancelled(cancellation);
  images.push({
    id: `pdf-image-${page.pageNumber}-${images.length}`,
    ...bounds,
    pixelWidth: image.width,
    pixelHeight: image.height,
    mediaType: 'image/png',
    data,
  });
}

async function encodeImage(
  image: PdfJsImage,
  cancellation?: CancellationSignal,
): Promise<Uint8Array> {
  const rgba = await imageRgba(image, cancellation);
  await yieldToEventLoop();
  throwIfCancelled(cancellation);
  return rgbaToPng(rgba, image.width, image.height, async () => {
    await yieldToEventLoop();
    throwIfCancelled(cancellation);
  });
}

function enforceImageLimit(
  image: Pick<PdfJsImage, 'width' | 'height'>,
  limits: PdfReaderLimits,
): void {
  const pixels = image.width * image.height;
  if (pixels > limits.maxImagePixels)
    throw new PdfReadError(
      'resource-limit',
      'A PDF image exceeds the pixel limit.',
      {
        phase: 'read',
        details: { limit: limits.maxImagePixels, actual: pixels },
      },
    );
}

function reserveImages(
  image: Pick<PdfJsImage, 'width' | 'height'>,
  count: number,
  limits: PdfReaderLimits,
  budget: PdfImageBudget,
): void {
  const pixels = image.width * image.height;
  const images = budget.images + count;
  const totalPixels = budget.pixels + pixels * count;
  if (images > limits.maxImages)
    throw new PdfReadError(
      'resource-limit',
      'PDF exceeds the image count limit.',
      {
        phase: 'read',
        details: { limit: limits.maxImages, actual: images },
      },
    );
  if (totalPixels > limits.maxTotalImagePixels)
    throw new PdfReadError(
      'resource-limit',
      'PDF exceeds the total decoded image pixel limit.',
      {
        phase: 'read',
        details: { limit: limits.maxTotalImagePixels, actual: totalPixels },
      },
    );
  budget.images = images;
  budget.pixels = totalPixels;
}

function isPdfJsImage(value: unknown): value is PdfJsImage {
  return (
    isRecord(value) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    (value.data instanceof Uint8Array ||
      value.data instanceof Uint8ClampedArray)
  );
}

function isInlineImageMap(value: unknown): value is PdfJsInlineImageMap {
  return (
    isRecord(value) &&
    isNumberArray(value.transform, 6) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.w === 'number' &&
    typeof value.h === 'number'
  );
}

function cropRgbaImage(
  atlas: Uint8Array,
  atlasWidth: number,
  entry: PdfJsInlineImageMap,
): PdfJsImage {
  const data = new Uint8Array(entry.w * entry.h * 4);
  for (let row = 0; row < entry.h; row++) {
    const start = ((entry.y + row) * atlasWidth + entry.x) * 4;
    data.set(atlas.subarray(start, start + entry.w * 4), row * entry.w * 4);
  }
  return {
    width: entry.w,
    height: entry.h,
    kind: ImageKind.RGBA_32BPP,
    data,
  };
}

function objectValue<T>(
  page: PDFPageProxy,
  id: string,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    page.objs.get(id, (value: unknown) =>
      resolve(isRecord(value) ? (value as T) : undefined),
    );
  });
}

async function imageRgba(
  image: PdfJsImage,
  cancellation?: CancellationSignal,
): Promise<Uint8Array> {
  const data = image.data;
  if (!data) return new Uint8Array();
  const pixels = image.width * image.height;
  if (image.kind === ImageKind.RGBA_32BPP || data.length === pixels * 4) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const output = new Uint8Array(pixels * 4);
  if (image.kind === ImageKind.RGB_24BPP || data.length === pixels * 3) {
    for (let pixel = 0; pixel < pixels; pixel++) {
      if (pixel > 0 && pixel % 262_144 === 0) {
        await yieldToEventLoop();
        throwIfCancelled(cancellation);
      }
      output[pixel * 4] = data[pixel * 3] ?? 0;
      output[pixel * 4 + 1] = data[pixel * 3 + 1] ?? 0;
      output[pixel * 4 + 2] = data[pixel * 3 + 2] ?? 0;
      output[pixel * 4 + 3] = 255;
    }
    return output;
  }
  for (let pixel = 0; pixel < pixels; pixel++) {
    if (pixel > 0 && pixel % 262_144 === 0) {
      await yieldToEventLoop();
      throwIfCancelled(cancellation);
    }
    const sourceByte = data[Math.floor(pixel / 8)] ?? 0;
    const value = sourceByte & (1 << (7 - (pixel % 8))) ? 255 : 0;
    output.set([value, value, value, 255], pixel * 4);
  }
  return output;
}

function imageBounds(
  matrix: Matrix,
  pageWidth: number,
  pageHeight: number,
): Pick<RawPdfImage, 'x' | 'top' | 'width' | 'height'> {
  const points = [
    transformPoint(matrix, 0, 0),
    transformPoint(matrix, 1, 0),
    transformPoint(matrix, 0, 1),
    transformPoint(matrix, 1, 1),
  ];
  const left = Math.min(...points.map(([x]) => x));
  const right = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const bottom = Math.max(...points.map(([, y]) => y));
  return {
    x: clamp(left / pageWidth),
    top: clamp(top / pageHeight),
    width: clamp((right - left) / pageWidth),
    height: clamp((bottom - top) / pageHeight),
  };
}

function rectangleBounds(
  matrix: Matrix,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  pageWidth: number,
  pageHeight: number,
): NormalizedBounds {
  const points = [
    transformPoint(matrix, x1, y1),
    transformPoint(matrix, x2, y1),
    transformPoint(matrix, x1, y2),
    transformPoint(matrix, x2, y2),
  ];
  const left = Math.min(...points.map(([x]) => x));
  const right = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const bottom = Math.max(...points.map(([, y]) => y));
  const x = clamp(left / pageWidth);
  const normalizedTop = clamp(top / pageHeight);
  return {
    x,
    top: normalizedTop,
    width: clamp((right - left) / pageWidth, 0, 1 - x),
    height: clamp((bottom - top) / pageHeight, 0, 1 - normalizedTop),
  };
}

function nearby(
  left: NormalizedBounds,
  right: NormalizedBounds,
  gap: number,
): boolean {
  return !(
    left.x + left.width + gap < right.x ||
    right.x + right.width + gap < left.x ||
    left.top + left.height + gap < right.top ||
    right.top + right.height + gap < left.top
  );
}

function unionBounds(
  left: NormalizedBounds,
  right: NormalizedBounds,
): NormalizedBounds {
  const x = Math.min(left.x, right.x);
  const top = Math.min(left.top, right.top);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottom = Math.max(left.top + left.height, right.top + right.height);
  return { x, top, width: rightEdge - x, height: bottom - top };
}

function padBounds(
  bounds: NormalizedBounds,
  padding: number,
): NormalizedBounds {
  const x = Math.max(0, bounds.x - padding);
  const top = Math.max(0, bounds.top - padding);
  const right = Math.min(1, bounds.x + bounds.width + padding);
  const bottom = Math.min(1, bounds.top + bounds.height + padding);
  return { x, top, width: right - x, height: bottom - top };
}

function readStructure(value: unknown): RawPdfStructureNode {
  if (!isRecord(value)) return { role: 'Document', children: [] };
  const children = Array.isArray(value.children)
    ? value.children.map(readStructure)
    : [];
  return {
    role: typeof value.role === 'string' ? value.role : 'NonStruct',
    ...(typeof value.id === 'string' ? { markedContentId: value.id } : {}),
    children,
  };
}

async function readMetadata(
  document: PDFDocumentProxy,
): Promise<RawPdfMetadata> {
  const result = await document.getMetadata();
  const info = isRecord(result.info) ? result.info : {};
  const metadata = result.metadata;
  const title = stringValue(info.Title) ?? metadata?.get('dc:title');
  const author = stringValue(info.Author) ?? metadata?.get('dc:creator');
  const subject = stringValue(info.Subject) ?? metadata?.get('dc:description');
  const keywords = stringValue(info.Keywords)
    ?.split(/[,;]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const language = metadata?.get('dc:language');
  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(subject ? { subject } : {}),
    ...(keywords?.length ? { keywords } : {}),
    ...(language ? { language } : {}),
    ...dateFields(info),
  };
}

function dateFields(
  info: Record<string, unknown>,
): Pick<RawPdfMetadata, 'createdAt' | 'modifiedAt'> {
  const createdAt = pdfDate(stringValue(info.CreationDate));
  const modifiedAt = pdfDate(stringValue(info.ModDate));
  return {
    ...(createdAt ? { createdAt } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
}

function pdfDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(
    value,
  );
  if (!match) return undefined;
  const [
    ,
    year,
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
  ] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

async function readOutline(
  document: PDFDocumentProxy,
): Promise<RawPdfOutlineItem[]> {
  const outline = await document.getOutline();
  return (outline ?? []).map((item) => ({
    title: item.title,
    ...(typeof item.dest === 'string' ? { destination: item.dest } : {}),
    children: readOutlineChildren(item.items),
  }));
}

function readOutlineChildren(items: readonly unknown[]): RawPdfOutlineItem[] {
  return items
    .filter(isRecord)
    .map((item) => ({
      title: stringValue(item.title) ?? '',
      ...(typeof item.dest === 'string' ? { destination: item.dest } : {}),
      children: Array.isArray(item.items)
        ? readOutlineChildren(item.items)
        : [],
    }))
    .filter(({ title }) => Boolean(title));
}

function isTextItem(value: unknown): value is TextItem {
  return isRecord(value) && typeof value.str === 'string';
}

function isSafeLink(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value);
}

function intersects(
  left: { x: number; top: number; width: number; height: number },
  right: { x: number; top: number; width: number; height: number },
): boolean {
  const centerX = left.x + left.width / 2;
  const centerY = left.top + left.height / 2;
  return (
    centerX >= right.x &&
    centerX <= right.x + right.width &&
    centerY >= right.top &&
    centerY <= right.top + right.height
  );
}

function multiply(left: readonly number[], right: readonly number[]): Matrix {
  return [
    left[0]! * right[0]! + left[2]! * right[1]!,
    left[1]! * right[0]! + left[3]! * right[1]!,
    left[0]! * right[2]! + left[2]! * right[3]!,
    left[1]! * right[2]! + left[3]! * right[3]!,
    left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
    left[1]! * right[4]! + left[3]! * right[5]! + left[5]!,
  ];
}

function transformPoint(
  matrix: readonly number[],
  x: number,
  y: number,
): readonly [number, number] {
  return [
    matrix[0]! * x + matrix[2]! * y + matrix[4]!,
    matrix[1]! * x + matrix[3]! * y + matrix[5]!,
  ];
}

function isNumberArray(value: unknown, length = 0): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= length &&
    value.every((entry) => typeof entry === 'number')
  );
}

function isNumberSequence(
  value: unknown,
): value is number[] | Float32Array | Float64Array {
  return (
    (Array.isArray(value) &&
      value.every((entry) => typeof entry === 'number')) ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === 'string'
    ? value.name
    : undefined;
}

function throwIfCancelled(signal: CancellationSignal | undefined): void {
  if (signal?.cancelled)
    throw new PdfReadError('cancelled', 'The operation was cancelled.', {
      phase: 'read',
      recoverable: true,
    });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
