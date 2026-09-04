import type { OutputFormat } from './state.ts';

export type AppRoute =
  | { page: 'document' }
  | { page: 'output-format' }
  | { page: 'conversion'; format: OutputFormat };

const conversionFormats = new Set<OutputFormat>(['markdown', 'html', 'epub']);

export function parseAppRoute(pathname: string, basePath: string): AppRoute {
  const base = normalizeBasePath(basePath);
  if (!pathname.startsWith(base)) return { page: 'document' };
  const relativePath = pathname.slice(base.length).replace(/^\/+|\/+$/g, '');
  if (!relativePath) return { page: 'document' };
  if (relativePath === 'output-format') return { page: 'output-format' };
  if (conversionFormats.has(relativePath as OutputFormat))
    return { page: 'conversion', format: relativePath as OutputFormat };
  return { page: 'document' };
}

export function routePath(route: AppRoute, basePath: string): string {
  const base = normalizeBasePath(basePath);
  if (route.page === 'document') return base;
  const segment =
    route.page === 'output-format' ? 'output-format' : route.format;
  return `${base}${segment}`;
}

function normalizeBasePath(basePath: string): string {
  const withLeadingSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith('/')
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}
