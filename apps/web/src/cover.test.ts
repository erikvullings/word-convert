import { describe, expect, it } from 'vitest';

import {
  createCoverSettings,
  coverComposition,
  validateCoverFile,
} from './cover.ts';

describe('cover editor model', () => {
  it('creates serializable defaults and derives a deterministic composition', () => {
    const settings = createCoverSettings();
    settings.source = 'generated';
    const composition = coverComposition(settings, {
      title: 'A title',
      subtitle: 'A subtitle',
      authors: ['A. Writer'],
    });
    expect(composition).toMatchObject({
      width: 1600,
      height: 2560,
      layout: 'typographic',
      title: 'A title',
      titlePosition: 18,
      authorPosition: 86,
      margin: 8,
    });
    expect(JSON.parse(JSON.stringify(settings))).toBeTruthy();
  });

  it('accepts supported images and rejects unsupported or oversized files', () => {
    expect(
      validateCoverFile({ name: 'cover.webp', type: 'image/webp', size: 4 }),
    ).toBeUndefined();
    expect(
      validateCoverFile({ name: 'cover.gif', type: 'image/gif', size: 4 }),
    ).toContain('JPEG, PNG, WebP, or SVG');
    expect(
      validateCoverFile({
        name: 'cover.png',
        type: 'image/png',
        size: 10 * 1024 * 1024 + 1,
      }),
    ).toContain('10 MiB');
  });
});
