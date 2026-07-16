import type { ConversionWarning } from '@wordconvert/document-model';
import type { Config } from 'dompurify';

export type WarningDestination =
  'styles' | 'metadata' | 'formula' | 'assets' | 'output';

export function previewSanitizeConfig(): Config {
  return {
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'style',
      'link',
      'meta',
      'title',
      'audio',
      'video',
      'source',
      'track',
      'form',
      'input',
      'button',
    ],
    FORBID_ATTR: ['style', 'srcset', 'formaction'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP:
      /^(?:(?:data:image\/(?:avif|gif|jpeg|png|webp);base64,)|#|[^a-z][^:]*$)/i,
  };
}

export function warningDestination(
  warning: ConversionWarning,
): WarningDestination {
  const code = warning.code.toLowerCase();
  if (code.includes('formula') || code.includes('math')) return 'formula';
  if (code.includes('metadata')) return 'metadata';
  if (code.includes('style') || code.includes('heading')) return 'styles';
  if (
    code.includes('asset') ||
    code.includes('image') ||
    code.includes('media')
  )
    return 'assets';
  return 'output';
}
