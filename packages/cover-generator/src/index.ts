export const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_COVER_IMAGE_PIXELS = 40_000_000;

export type CoverLayout =
  | 'image-only'
  | 'overlay'
  | 'title-panel'
  | 'separate-title-page'
  | 'typographic';
export type CoverAlignment = 'left' | 'center' | 'right';
export type CoverCrop = 'cover' | 'contain' | 'stretch';
export type CoverTextColor = 'light' | 'dark';
export type CoverContrastPanel = 'none' | 'light' | 'dark';

export interface CoverImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/svg+xml';
  data: Uint8Array;
  width?: number;
  height?: number;
}

export interface CoverComposition {
  width: number;
  height: number;
  layout: CoverLayout;
  title: string;
  subtitle?: string;
  authors: readonly string[];
  alignment: CoverAlignment;
  titlePosition: number;
  authorPosition: number;
  titleSize: number;
  authorSize: number;
  textColor: CoverTextColor;
  contrastPanel: CoverContrastPanel;
  panelOpacity: number;
  imageOpacity: number;
  margin: number;
  crop: CoverCrop;
  image?: CoverImage;
}

export interface CoverRasterizer {
  rasterize(svg: string, width: number, height: number): Promise<Uint8Array>;
}

export async function rasterizeCover(
  composition: CoverComposition,
  adapter: CoverRasterizer,
): Promise<Uint8Array> {
  return adapter.rasterize(
    createCoverSvg(composition),
    composition.width,
    composition.height,
  );
}

export function prepareCoverImage(image: CoverImage): CoverImage {
  if (image.data.byteLength > MAX_COVER_IMAGE_BYTES)
    throw new RangeError('Cover images must be no larger than 10 MiB.');
  if (
    image.width !== undefined &&
    image.height !== undefined &&
    image.width * image.height > MAX_COVER_IMAGE_PIXELS
  )
    throw new RangeError('Cover images must be no larger than 40 megapixels.');
  if (image.mediaType !== 'image/svg+xml') return image;
  return {
    ...image,
    data: encodeUtf8(sanitizeSvg(decodeUtf8(image.data))),
  };
}

export function createCoverSvg(input: CoverComposition): string {
  validateComposition(input);
  const image = input.image ? prepareCoverImage(input.image) : undefined;
  const margin = (input.width * input.margin) / 100;
  const maxTextWidth = Math.max(80, input.width - margin * 2);
  const x =
    input.alignment === 'left'
      ? margin
      : input.alignment === 'right'
        ? input.width - margin
        : input.width / 2;
  const anchor =
    input.alignment === 'left'
      ? 'start'
      : input.alignment === 'right'
        ? 'end'
        : 'middle';
  const foreground = input.textColor === 'light' ? '#fff' : '#111';
  const background = input.textColor === 'light' ? '#172033' : '#f1ede4';
  const imageMarkup = image
    ? `<image width="${input.width}" height="${input.height}" opacity="${input.imageOpacity}" preserveAspectRatio="${aspectRatio(input.crop)}" href="data:${image.mediaType};base64,${base64(image.data)}"/>`
    : '';
  const containsText =
    input.layout === 'overlay' ||
    input.layout === 'title-panel' ||
    input.layout === 'typographic';
  const titleLineHeight = input.titleSize * 0.95;
  const titleLines = containsText
    ? wrapTextLines(input.title, input.titleSize, maxTextWidth)
    : [];
  const titleLineCount = Math.max(1, titleLines.length);
  const subtitleY =
    (input.height * input.titlePosition) / 100 +
    titleLineHeight * titleLineCount;
  const panel =
    containsText && input.contrastPanel !== 'none'
      ? `<rect x="${margin / 2}" y="${(input.height * input.titlePosition) / 100 - input.titleSize * 1.15}" width="${input.width - margin}" height="${input.titleSize * (0.95 + titleLineCount * 0.95 + (input.subtitle ? 0.95 : 0))}" rx="24" fill="${input.contrastPanel === 'dark' ? '#000' : '#fff'}" opacity="${input.panelOpacity}"/>`
      : '';
  const title = containsText
    ? `<text x="${x}" y="${(input.height * input.titlePosition) / 100}" text-anchor="${anchor}" font-family="Georgia,serif" font-size="${input.titleSize}" font-weight="700" fill="${foreground}">${titleLines
        .map((line, index) =>
          index === 0
            ? `<tspan x="${x}" dy="0">${escapeXml(line)}</tspan>`
            : `<tspan x="${x}" dy="${titleLineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join(
          '',
        )}</text>${input.subtitle ? `<text x="${x}" y="${subtitleY}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${input.authorSize}" fill="${foreground}">${escapeXml(input.subtitle)}</text>` : ''}`
    : '';
  const authors = containsText
    ? `<text x="${x}" y="${(input.height * input.authorPosition) / 100}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${input.authorSize}" fill="${foreground}">${escapeXml(input.authors.join(' · '))}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}"><rect width="100%" height="100%" fill="${background}"/>${imageMarkup}${panel}${title}${authors}</svg>`;
}

export function titleTextWarning(
  filename: string,
  title: string,
): string | undefined {
  const words = title.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (words.length < 2) return undefined;
  const normalizedFilename = filename.toLocaleLowerCase();
  const matches = words.filter((word) => normalizedFilename.includes(word));
  if (matches.length / words.length < 0.6) return undefined;
  return 'The image filename contains most title words, so it may already include title text. Check the preview before adding an overlay.';
}

function validateComposition(input: CoverComposition): void {
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  )
    throw new RangeError('Cover dimensions must be positive integers.');
  for (const [label, value, minimum, maximum] of [
    ['title position', input.titlePosition, 0, 100],
    ['author position', input.authorPosition, 0, 100],
    ['panel opacity', input.panelOpacity, 0, 1],
    ['image opacity', input.imageOpacity, 0, 1],
    ['margin', input.margin, 0, 25],
  ] as const) {
    if (value < minimum || value > maximum)
      throw new RangeError(
        `Cover ${label} must be between ${minimum} and ${maximum}.`,
      );
  }
}

function aspectRatio(crop: CoverCrop): string {
  return crop === 'cover'
    ? 'xMidYMid slice'
    : crop === 'contain'
      ? 'xMidYMid meet'
      : 'none';
}

function sanitizeSvg(svg: string): string {
  if (!/^\s*<svg[\s>]/i.test(svg))
    throw new TypeError('The cover SVG is invalid.');
  return svg
    .replace(
      /<(?:script|style|foreignObject|iframe|object|embed|use)\b[^>]*>[\s\S]*?<\/(?:script|style|foreignObject|iframe|object|embed|use)\s*>/gi,
      '',
    )
    .replace(
      /<\/?(?:script|style|foreignObject|iframe|object|embed|use)\b[^>]*>/gi,
      '',
    )
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s+(?:href|xlink:href)\s*=\s*(?:"(?:https?:|javascript:|data:text\/html)[^"]*"|'(?:https?:|javascript:|data:text\/html)[^']*'|(?:https?:|javascript:|data:text\/html)[^\s>]*)/gi,
      '',
    );
}

function base64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    result += alphabet[(value >> 18) & 63] ?? '';
    result += alphabet[(value >> 12) & 63] ?? '';
    result +=
      index + 1 < bytes.length ? (alphabet[(value >> 6) & 63] ?? '') : '=';
    result += index + 2 < bytes.length ? (alphabet[value & 63] ?? '') : '=';
  }
  return result;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character] ?? character,
  );
}

function wrapTextLines(
  value: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = words[0] ?? '';
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (estimateTextWidth(word, fontSize) <= maxWidth) {
      current = word;
      continue;
    }
    const split = splitLongWord(word, fontSize, maxWidth);
    lines.push(...split.slice(0, -1));
    current = split[split.length - 1] ?? '';
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [value];
}

function splitLongWord(
  word: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const segments: string[] = [];
  let current = '';
  for (const char of Array.from(word)) {
    const candidate = `${current}${char}`;
    if (current && estimateTextWidth(candidate, fontSize) > maxWidth) {
      segments.push(current);
      current = char;
      continue;
    }
    current = candidate;
  }
  if (current) segments.push(current);
  return segments;
}

function estimateTextWidth(value: string, fontSize: number): number {
  const units = Array.from(value).reduce((sum, char) => {
    if (char === ' ') return sum + 0.34;
    if (/[ilI1\.,:;'!]/.test(char)) return sum + 0.28;
    if (/[MW@%#&]/.test(char)) return sum + 0.9;
    return sum + 0.62;
  }, 0);
  return units * fontSize;
}

function encodeUtf8(value: string): Uint8Array {
  const encoded = unescape(encodeURIComponent(value));
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

function decodeUtf8(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join(
    '',
  );
  try {
    return decodeURIComponent(escape(binary));
  } catch {
    throw new TypeError('The cover SVG is not valid UTF-8.');
  }
}
