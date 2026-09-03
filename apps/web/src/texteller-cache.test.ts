import { describe, expect, it, vi } from 'vitest';

import {
  clearCachedTexTellerAssets,
  hasCachedTexTellerAssets,
} from './texteller-cache.ts';

function cacheStorage(urls: string[]) {
  const requests = urls.map((url) => new Request(url));
  const cache = {
    keys: vi.fn(async () => requests),
    delete: vi.fn(async (request: Request) => {
      const index = requests.findIndex(({ url }) => url === request.url);
      if (index >= 0) requests.splice(index, 1);
      return index >= 0;
    }),
  };
  return {
    storage: {
      keys: vi.fn(async () => ['wordconvert-v1']),
      open: vi.fn(async () => cache),
    } as unknown as CacheStorage,
    cache,
  };
}

describe('TexTeller cache controls', () => {
  it('detects and clears only TexTeller runtime assets', async () => {
    const { storage, cache } = cacheStorage([
      'https://example.test/word-convert/texteller/encoder.onnx',
      'https://example.test/word-convert/texteller/tokenizer.json',
      'https://example.test/word-convert/assets/app.js',
    ]);

    expect(await hasCachedTexTellerAssets(storage)).toBe(true);
    await clearCachedTexTellerAssets(storage);

    expect(cache.delete).toHaveBeenCalledTimes(2);
    expect(cache.delete).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('app.js') }),
    );
    expect(await hasCachedTexTellerAssets(storage)).toBe(false);
  });
});
