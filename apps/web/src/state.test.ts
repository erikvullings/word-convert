import { describe, expect, it } from 'vitest';

import {
  createInitialState,
  loadPreferences,
  MAX_REMEMBERED_DENSE_PAGE_MODES,
  persistPreferences,
  rememberDensePageMode,
  validateSourceFile,
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
      formulaRecognitionEnabled: false,
      formulaMode: 'katex' as const,
      htmlMode: 'standalone' as const,
      markdownMode: 'single' as const,
      markdownIncludeInternalLinks: false,
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
      formulaRecognitionEnabled: true,
      formulaMode: 'mathml',
      htmlMode: 'standalone',
      markdownMode: 'single',
      markdownIncludeInternalLinks: true,
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

  it('drops invalid remembered dense-page choices without resetting preferences', () => {
    const storage = new MemoryStorage();
    const fingerprint = 'a'.repeat(64);
    storage.values.set(
      'wordconvert.preferences.v1',
      JSON.stringify({
        theme: 'dark',
        outputFormat: 'epub',
        mappingPresets: {},
        densePageModes: {
          [fingerprint]: 'image-and-prose',
          ['b'.repeat(64)]: 'script',
          'report.pdf': 'image-only',
        },
      }),
    );

    expect(loadPreferences(storage)).toMatchObject({
      theme: 'dark',
      outputFormat: 'epub',
      densePageModes: { [fingerprint]: 'image-and-prose' },
    });
  });

  it('keeps a bounded, most-recent list of remembered dense-page choices', () => {
    let preferences = createInitialState('2026-07-15').preferences;
    const fingerprints = Array.from(
      { length: MAX_REMEMBERED_DENSE_PAGE_MODES + 1 },
      (_, index) => index.toString(16).padStart(64, '0'),
    );
    for (const fingerprint of fingerprints)
      preferences = rememberDensePageMode(
        preferences,
        fingerprint,
        'image-only',
      );
    preferences = rememberDensePageMode(
      preferences,
      fingerprints[1]!,
      'extract',
    );

    const remembered = Object.entries(preferences.densePageModes ?? {});
    expect(remembered).toHaveLength(MAX_REMEMBERED_DENSE_PAGE_MODES);
    expect(remembered.at(-1)).toEqual([fingerprints[1], 'extract']);
    expect(preferences.densePageModes).not.toHaveProperty(fingerprints[0]!);

    preferences = rememberDensePageMode(
      preferences,
      fingerprints[1]!,
      undefined,
    );
    expect(preferences.densePageModes).not.toHaveProperty(fingerprints[1]!);
  });

  it('accepts DOCX and PDF files and rejects unsafe or misleading input', () => {
    expect(
      validateSourceFile({ name: 'report.docx', type: '' }),
    ).toBeUndefined();
    expect(
      validateSourceFile({ name: 'article.pdf', type: 'application/pdf' }),
    ).toBeUndefined();
    expect(validateSourceFile({ name: 'macro.docm', type: '' })).toContain(
      '.docx',
    );
    expect(
      validateSourceFile({ name: 'report.pdf', type: 'text/html' }),
    ).toContain('PDF');
  });
});
