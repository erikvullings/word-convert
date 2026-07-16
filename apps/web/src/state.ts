import type {
  ConversionError,
  ConversionProgress,
  DocumentModel,
  StyleMapping,
} from '@wordconvert/document-model';
import { STYLE_MAPPINGS } from './editors.ts';
import { createCoverSettings, type CoverSettings } from './cover.ts';
import type { MathOutputMode } from '@wordconvert/math-converter';
import type { ConversionWarning } from '@wordconvert/document-model';
import type {
  AssetOutputMode,
  HtmlOutputMode,
  MarkdownOutputMode,
} from './output.ts';

export const WORKFLOW_STAGES = [
  'Document',
  'Output Format',
  'Preview',
  'Download',
] as const;

export type ThemePreference = 'system' | 'light' | 'dark';
export type OutputFormat = 'html' | 'markdown' | 'epub';
export type PreviewMode = 'rendered' | 'source';

export interface Preferences {
  theme: ThemePreference;
  outputFormat: OutputFormat;
  mappingPresets: Record<string, Record<string, StyleMapping>>;
  formulaMode: MathOutputMode;
  htmlMode: HtmlOutputMode;
  markdownMode: MarkdownOutputMode;
  assetMode: AssetOutputMode;
  epubIncludeCover: boolean;
}

export interface DownloadOutput {
  filename: string;
  mediaType: string;
  data: ArrayBuffer;
  files?: string[];
  warnings?: ConversionWarning[];
}

export interface AppState {
  stage: number;
  status: 'idle' | 'analysing' | 'ready' | 'converting' | 'complete' | 'error';
  conversionDate: string;
  selectedFilename?: string;
  operationId?: string;
  progress?: ConversionProgress;
  model?: DocumentModel;
  output?: DownloadOutput;
  selectedEpubFile?: string;
  error?: ConversionError;
  styleMappings: Record<string, StyleMapping>;
  presetText: string;
  editorNotice?: string;
  review?: 'styles' | 'metadata';
  previewMode: PreviewMode;
  cover: CoverSettings;
  preferences: Preferences;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FileDescriptor {
  name: string;
  type: string;
}

const STORAGE_KEY = 'wordconvert.preferences.v1';
const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  outputFormat: 'html',
  mappingPresets: {},
  formulaMode: 'mathml',
  htmlMode: 'standalone',
  markdownMode: 'single',
  assetMode: 'embedded',
  epubIncludeCover: true,
};

export function createInitialState(
  conversionDate: string,
  preferences: Preferences = DEFAULT_PREFERENCES,
): AppState {
  return {
    stage: 0,
    status: 'idle',
    conversionDate,
    styleMappings: {},
    presetText: '',
    previewMode: 'rendered',
    cover: createCoverSettings(),
    preferences,
  };
}

export function validateDocxFile(file: FileDescriptor): string | undefined {
  if (!file.name.toLowerCase().endsWith('.docx'))
    return 'Choose a file with the .docx extension.';
  if (file.type !== '' && file.type !== DOCX_MEDIA_TYPE)
    return 'The selected file is not identified as a safe DOCX document.';
  return undefined;
}

export function persistPreferences(
  storage: PreferenceStorage,
  preferences: Preferences,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadPreferences(storage: PreferenceStorage): Preferences {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === null) return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(stored) as Partial<Preferences>;
    if (
      !['system', 'light', 'dark'].includes(value.theme ?? '') ||
      !['html', 'markdown', 'epub'].includes(value.outputFormat ?? '') ||
      !isMappingPresets(value.mappingPresets) ||
      (value.formulaMode !== undefined &&
        !['source', 'mathml', 'katex', 'disabled'].includes(
          value.formulaMode,
        )) ||
      (value.htmlMode !== undefined &&
        !['standalone', 'zip'].includes(value.htmlMode)) ||
      (value.markdownMode !== undefined &&
        !['single', 'zip'].includes(value.markdownMode)) ||
      (value.assetMode !== undefined &&
        !['embedded', 'folder'].includes(value.assetMode)) ||
      (value.epubIncludeCover !== undefined &&
        typeof value.epubIncludeCover !== 'boolean')
    )
      return DEFAULT_PREFERENCES;
    return {
      ...value,
      formulaMode: value.formulaMode ?? 'mathml',
      htmlMode: value.htmlMode ?? 'standalone',
      markdownMode: value.markdownMode ?? 'single',
      assetMode: value.assetMode ?? 'embedded',
      epubIncludeCover: value.epubIncludeCover ?? true,
    } as Preferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function isMappingPresets(
  value: unknown,
): value is Record<string, Record<string, StyleMapping>> {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every(
    (preset) =>
      isPlainRecord(preset) &&
      Object.values(preset).every(
        (mapping) =>
          typeof mapping === 'string' &&
          (STYLE_MAPPINGS as readonly string[]).includes(mapping),
      ),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export { DOCX_MEDIA_TYPE };
