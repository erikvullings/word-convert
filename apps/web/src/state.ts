import type {
  ConversionError,
  ConversionProgress,
  DocumentModel,
  StyleMapping,
} from '@wordconvert/document-model';
import { STYLE_MAPPINGS } from './editors.ts';

export const WORKFLOW_STAGES = [
  'Document',
  'Format',
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
}

export interface DownloadOutput {
  filename: string;
  mediaType: string;
  data: ArrayBuffer;
  files?: string[];
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
  error?: ConversionError;
  styleMappings: Record<string, StyleMapping>;
  presetText: string;
  editorNotice?: string;
  review?: 'styles' | 'metadata';
  previewMode: PreviewMode;
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
      !isMappingPresets(value.mappingPresets)
    )
      return DEFAULT_PREFERENCES;
    return value as Preferences;
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
