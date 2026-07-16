import { describe, expect, it } from 'vitest';

import {
  createCoverSvg,
  prepareCoverImage,
  titleTextWarning,
  type CoverComposition,
} from './index.ts';

const base: CoverComposition = {
  width: 1600,
  height: 2560,
  layout: 'overlay',
  title: 'The Long Road',
  subtitle: 'Notes from elsewhere',
  authors: ['Ada Example', 'Lin Example'],
  alignment: 'center',
  titlePosition: 18,
  authorPosition: 86,
  titleSize: 112,
  authorSize: 54,
  textColor: 'light',
  contrastPanel: 'dark',
  panelOpacity: 0.56,
  imageOpacity: 1,
  margin: 8,
  crop: 'cover',
  image: {
    mediaType: 'image/png',
    data: new Uint8Array([137, 80, 78, 71]),
    width: 1200,
    height: 1800,
  },
};

describe('cover generator', () => {
  it('creates a deterministic browser-independent SVG for every cover layout', () => {
    for (const layout of [
      'image-only',
      'overlay',
      'title-panel',
      'separate-title-page',
      'typographic',
    ] as const) {
      const input = { ...base, layout };
      expect(createCoverSvg(input)).toBe(createCoverSvg(input));
      expect(createCoverSvg(input)).toContain('viewBox="0 0 1600 2560"');
    }
  });

  it('escapes text, applies crop/alignment/positions/sizes/colors/panels/opacity/margins, and uses no remote fonts', () => {
    const svg = createCoverSvg({ ...base, title: '<unsafe & title>' });
    expect(svg).toContain('&lt;unsafe &amp; title&gt;');
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('font-size="112"');
    expect(svg).toContain('opacity="0.56"');
    expect(svg).toContain('font-family="Georgia,serif"');
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(
      /https?:|<script|onload=/i,
    );
  });

  it('rejects oversized or implausibly large raster images', () => {
    expect(() =>
      prepareCoverImage({
        mediaType: 'image/png',
        data: new Uint8Array(10 * 1024 * 1024 + 1),
      }),
    ).toThrow('10 MiB');
    expect(() =>
      prepareCoverImage({
        mediaType: 'image/jpeg',
        data: new Uint8Array([1]),
        width: 10_000,
        height: 10_000,
      }),
    ).toThrow('40 megapixels');
  });

  it('sanitizes SVG images before embedding them', () => {
    const image = prepareCoverImage({
      mediaType: 'image/svg+xml',
      data: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://example.test/x.png"/><rect width="2" height="2" onclick="bad()"/></svg>',
      ),
    });
    const text = new TextDecoder().decode(image.data);
    expect(text).toContain('<rect');
    expect(text).not.toMatch(/script|https:|onclick/i);
  });

  it('gives a conservative and explainable existing-title warning', () => {
    expect(titleTextWarning('cover-the-long-road.png', 'The Long Road')).toBe(
      'The image filename contains most title words, so it may already include title text. Check the preview before adding an overlay.',
    );
    expect(
      titleTextWarning('mountain-photo.png', 'The Long Road'),
    ).toBeUndefined();
  });

  it('wraps long titles to multiple lines and keeps subtitle below wrapped title block', () => {
    const svg = createCoverSvg({
      ...base,
      title:
        'A Very Long Cover Title That Must Wrap Across Multiple Lines To Stay Inside The Safe Margin',
      alignment: 'left',
      margin: 10,
      titleSize: 120,
    });
    const tspanCount = (svg.match(/<tspan\b/g) ?? []).length;
    expect(tspanCount).toBeGreaterThan(1);

    const subtitleMatch = svg.match(
      /<text x="[^"]+" y="([0-9.]+)"[^>]*>Notes from elsewhere<\/text>/,
    );
    expect(subtitleMatch?.[1]).toBeDefined();
    expect(Number(subtitleMatch?.[1])).toBeGreaterThan(
      (base.height * base.titlePosition) / 100 + 80,
    );
  });
});
