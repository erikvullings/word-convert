import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  loadPreferences,
  persistPreferences,
  validateDocxFile,
  WORKFLOW_STAGES,
  type PreferenceStorage,
} from './state.ts';

class MemoryStorage implements PreferenceStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('SPA state', () => {
  it('defines the compact output-first workflow as serializable state', () => {
    const state = createInitialState('2026-07-15');

    expect({
      stages: WORKFLOW_STAGES,
      state: JSON.parse(JSON.stringify(state)),
    }).toMatchObject({
      stages: ['Document', 'Output Format', 'Preview', 'Download'],
      state: { stage: 0, status: 'idle', conversionDate: '2026-07-15' },
    });
  });

  it('persists only preferences and mapping presets, never document state', () => {
    const storage = new MemoryStorage();
    const preferences = {
      theme: 'dark' as const,
      outputFormat: 'markdown' as const,
      mappingPresets: { editorial: { Heading1: 'heading1' as const } },
      formulaMode: 'katex' as const,
      htmlMode: 'standalone' as const,
      markdownMode: 'single' as const,
      assetMode: 'embedded' as const,
      epubIncludeCover: true,
    };

    persistPreferences(storage, preferences);

    expect([...storage.values.values()].join(' ')).not.toContain('document');
    expect(loadPreferences(storage)).toEqual(preferences);
  });

  it('rejects stored presets with unknown mapping values', () => {
    const storage = new MemoryStorage();
    persistPreferences(storage, {
      theme: 'dark',
      outputFormat: 'html',
      mappingPresets: { unsafe: { Heading1: 'heading1' } },
      formulaMode: 'mathml',
      htmlMode: 'standalone',
      markdownMode: 'single',
      assetMode: 'embedded',
      epubIncludeCover: true,
    });
    const key = [...storage.values.keys()][0];
    if (!key) throw new Error('No preference key');
    storage.values.set(
      key,
      '{"theme":"dark","outputFormat":"html","mappingPresets":{"unsafe":{"Heading1":"script"}}}',
    );

    expect(loadPreferences(storage).mappingPresets).toEqual({});
  });

  it('accepts DOCX files and rejects unsafe or misleading input', () => {
    expect(validateDocxFile({ name: 'report.docx', type: '' })).toBeUndefined();
    expect(validateDocxFile({ name: 'macro.docm', type: '' })).toContain(
      '.docx',
    );
    expect(
      validateDocxFile({ name: 'report.docx', type: 'text/html' }),
    ).toContain('DOCX');
  });
});
