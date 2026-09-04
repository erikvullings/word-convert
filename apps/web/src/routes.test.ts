import { describe, expect, it } from 'vitest';

import { parseAppRoute, routePath } from './routes.ts';

describe('workflow routes', () => {
  it.each([
    ['/', { page: 'document' }],
    ['/output-format', { page: 'output-format' }],
    ['/markdown', { page: 'conversion', format: 'markdown' }],
    ['/html', { page: 'conversion', format: 'html' }],
    ['/epub', { page: 'conversion', format: 'epub' }],
  ] as const)('parses %s', (path, expected) => {
    expect(parseAppRoute(path, '/')).toEqual(expected);
  });

  it('supports custom deployment base paths', () => {
    expect(parseAppRoute('/word-convert/markdown', '/word-convert/')).toEqual({
      page: 'conversion',
      format: 'markdown',
    });
    expect(routePath({ page: 'output-format' }, '/word-convert/')).toBe(
      '/word-convert/output-format',
    );
    expect(routePath({ page: 'conversion', format: 'epub' }, '/app')).toBe(
      '/app/epub',
    );
  });

  it('treats unknown and out-of-base paths as the document route', () => {
    expect(parseAppRoute('/unknown', '/')).toEqual({ page: 'document' });
    expect(parseAppRoute('/other/html', '/word-convert/')).toEqual({
      page: 'document',
    });
  });
});
