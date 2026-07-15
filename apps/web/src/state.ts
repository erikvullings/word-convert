import type {
  ConversionError,
  ConversionProgress,
  DocumentModel,
  StyleMapping,
} from '@wordconvert/document-model';

export const WORKFLOW_STAGES = [
  'Select document',
  'Analyze document',
  'Review styles',
  'Review metadata',
  'Configure output',
  'Configure EPUB cover',
  'Preview',
  'Convert and download',
] as const;

export type ThemePreference = 'system' | 'light' | 'dark';
export type OutputFormat = 'html' | 'markdown';

export interface Preferences {
  theme: ThemePreference;
  outputFormat: OutputFormat;
  mappingPresets: Record<string, Record<string, StyleMapping>>;
}

export interface DownloadOutput {
  filename: string;
  mediaType: string;
  data: ArrayBuffer;
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
  return { stage: 0, status: 'idle', conversionDate, preferences };
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
      !['html', 'markdown'].includes(value.outputFormat ?? '') ||
      typeof value.mappingPresets !== 'object' ||
      value.mappingPresets === null
    )
      return DEFAULT_PREFERENCES;
    return value as Preferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export { DOCX_MEDIA_TYPE };
