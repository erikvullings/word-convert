export const MAX_IMAGE_TEXT_LENGTH = 500;

export function sanitizeImageText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const bounded = Array.from(text).slice(0, MAX_IMAGE_TEXT_LENGTH).join('');
  return bounded || undefined;
}
