// @vitest-environment jsdom

import { renderTex } from '@wordconvert/math-converter';
import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';

import {
  formulaPreviewSanitizeConfig,
  previewSanitizeConfig,
  warningDestination,
} from './index.ts';

describe('preview safety and warning navigation', () => {
  it('uses a restrictive DOMPurify policy that forbids active content and remote URLs', () => {
    const config = previewSanitizeConfig();
    expect(config.FORBID_TAGS).toEqual(
      expect.arrayContaining([
        'script',
        'iframe',
        'object',
        'embed',
        'style',
        'link',
      ]),
    );
    expect(config.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
    const allowedUri = config.ALLOWED_URI_REGEXP;
    if (!allowedUri) throw new Error('Missing URI policy');
    expect(allowedUri.test('https://tracker.example/pixel')).toBe(false);
    expect(allowedUri.test('javascript:alert(1)')).toBe(false);
    expect(allowedUri.test('#chapter-1')).toBe(true);
    expect(allowedUri.test('data:image/png;base64,AA==')).toBe(true);
  });

  it('preserves KaTeX layout styles without relaxing active-content restrictions', () => {
    const config = formulaPreviewSanitizeConfig();
    const container = document.createElement('div');
    container.innerHTML = DOMPurify.sanitize(
      `${renderTex(String.raw`\sqrt{d_k}`, true)}
        <svg><a href="https://tracker.example/pixel">remote</a>
          <path d="M0 0" onclick="alert(1)"></path>
        </svg>`,
      config,
    );

    const radical = container.querySelector('.sqrt svg');
    expect(radical?.getAttribute('preserveAspectRatio')).toBe('xMinYMin slice');
    expect(radical?.querySelector('path')?.getAttribute('d')).toBeTruthy();
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(container.querySelector('path[onclick]')).toBeNull();
  });

  it.each([
    ['formula-conversion-incomplete', 'formula'],
    ['markdown-unsafe-asset', undefined],
    ['missing-required-metadata', 'metadata'],
    ['style-ambiguous', 'styles'],
    ['pdf-cropped-page-furniture', 'pdf'],
  ] as const)('routes %s warnings to %s', (code, destination) => {
    expect(
      warningDestination({ code, severity: 'warning', message: 'Check it' }),
    ).toBe(destination);
  });
});
