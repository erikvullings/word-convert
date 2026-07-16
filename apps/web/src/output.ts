import type { MathOutputMode } from '@wordconvert/math-converter';

export type OutputFormat = 'html' | 'markdown' | 'epub';
export type HtmlOutputMode = 'standalone' | 'zip';
export type MarkdownOutputMode = 'single' | 'zip';
export type AssetOutputMode = 'embedded' | 'folder';
export type ConversionMode = HtmlOutputMode | MarkdownOutputMode | 'epub';

export interface OutputSettings {
  format: OutputFormat;
  htmlMode: HtmlOutputMode;
  markdownMode: MarkdownOutputMode;
  formulaMode: MathOutputMode;
  assetMode: AssetOutputMode;
  epub: { includeCover: boolean };
}

export function createOutputSettings(): OutputSettings {
  return {
    format: 'html',
    htmlMode: 'standalone',
    markdownMode: 'single',
    formulaMode: 'mathml',
    assetMode: 'embedded',
    epub: { includeCover: true },
  };
}

export function outputExtension(
  format: OutputFormat,
  mode: ConversionMode,
): '.html' | '.md' | '.zip' | '.epub' {
  if (format === 'epub') return '.epub';
  if (mode === 'zip') return '.zip';
  return format === 'html' ? '.html' : '.md';
}

export function conversionMode(settings: OutputSettings): ConversionMode {
  return settings.format === 'html'
    ? settings.htmlMode
    : settings.format === 'markdown'
      ? settings.markdownMode
      : 'epub';
}
