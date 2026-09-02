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
import type { PdfAnalysisSummary } from '@wordconvert/pdf-reader';

export const WORKFLOW_STAGES = [
  'Document',
  'Output Format',
  'Preview',
  'Download',
] as const;

export type ThemePreference = 'system' | 'light' | 'dark';
export type OutputFormat = 'html' | 'markdown' | 'epub';
export type PreviewMode = 'rendered' | 'source' | 'edit' | 'package';
export type SourceFormat = 'docx' | 'pdf';

export interface PdfImportSettings {
  cropTop: number;
  cropBottom: number;
  samplePageCount: number;
  removeDetectedFurniture: boolean;
  removedCandidateIds: string[];
  retainedCandidateIds: string[];
}

export interface PdfPagePreviewState {
  pageNumber: number;
  width: number;
  height: number;
  url: string;
}

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
  remotePdfUrl: string;
  remotePdfLoading?: boolean;
  sourceFormat?: SourceFormat;
  operationId?: string;
  progress?: ConversionProgress;
  model?: DocumentModel;
  pdfAnalysis?: PdfAnalysisSummary;
  pdfLayoutStatus?: 'loading' | 'ready' | 'unavailable';
  pdfImport: PdfImportSettings;
  pdfPreviewPage: number;
  pdfPreviewScale: number;
  pdfPreviewRequested?: boolean;
  pdfOriginalVisible?: boolean;
  pdfPreviewOperationId?: string;
  pdfPreview?: PdfPagePreviewState;
  pdfPreviewLoading?: boolean;
  pdfPreviewError?: string;
  output?: DownloadOutput;
  outputSaved?: boolean;
  selectedEpubFile?: string;
  markdownEdit?: string;
  epubContentEdit?: string;
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
const PDF_MEDIA_TYPE = 'application/pdf';
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
    remotePdfUrl: '',
    styleMappings: {},
    presetText: '',
    previewMode: 'rendered',
    cover: createCoverSettings(),
    pdfImport: {
      cropTop: 0,
      cropBottom: 0,
      samplePageCount: 5,
      removeDetectedFurniture: true,
      removedCandidateIds: [],
      retainedCandidateIds: [],
    },
    pdfPreviewPage: 1,
    pdfPreviewScale: 1,
    preferences,
  };
}

export function validateSourceFile(file: FileDescriptor): string | undefined {
  const name = file.name.toLowerCase();
  const format = name.endsWith('.docx')
    ? 'docx'
    : name.endsWith('.pdf')
      ? 'pdf'
      : undefined;
  if (!format) return 'Choose a file with the .docx or .pdf extension.';
  const expectedType = format === 'docx' ? DOCX_MEDIA_TYPE : PDF_MEDIA_TYPE;
  if (file.type !== '' && file.type !== expectedType)
    return `The selected file is not identified as a safe ${format.toUpperCase()} document.`;
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

export { DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE };
