import { describe, expect, it } from 'vitest';

import { createOutputSettings, outputExtension } from './output.ts';

describe('output settings', () => {
  it('provides sensible defaults for every requested output option', () => {
    expect(createOutputSettings()).toEqual({
      format: 'html',
      htmlMode: 'standalone',
      markdownMode: 'single',
      formulaMode: 'mathml',
      assetMode: 'embedded',
      epub: { includeCover: true },
    });
  });

  it.each([
    ['html', 'standalone', '.html'],
    ['html', 'zip', '.zip'],
    ['markdown', 'single', '.md'],
    ['markdown', 'zip', '.zip'],
    ['epub', 'epub', '.epub'],
  ] as const)('names %s %s output with %s', (format, mode, extension) => {
    expect(outputExtension(format, mode)).toBe(extension);
  });
});
