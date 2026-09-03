import {
  textTellerAssetPath,
  type TexTellerAsset,
} from './worker/texteller-assets.ts';

const assets: readonly TexTellerAsset[] = [
  'encoder.onnx',
  'decoder.onnx',
  'tokenizer.json',
];

export async function hasCachedTexTellerAssets(
  storage: CacheStorage = caches,
): Promise<boolean> {
  const urls = await cachedRequestUrls(storage);
  return assets.some((asset) =>
    urls.some((url) =>
      new URL(url).pathname.endsWith(`/${textTellerAssetPath(asset)}`),
    ),
  );
}

export async function clearCachedTexTellerAssets(
  storage: CacheStorage = caches,
): Promise<void> {
  for (const name of await storage.keys()) {
    const cache = await storage.open(name);
    for (const request of Array.from(await cache.keys())) {
      if (isTexTellerUrl(request.url)) await cache.delete(request);
    }
  }
}

async function cachedRequestUrls(storage: CacheStorage): Promise<string[]> {
  const urls: string[] = [];
  for (const name of await storage.keys()) {
    const cache = await storage.open(name);
    urls.push(...(await cache.keys()).map(({ url }) => url));
  }
  return urls;
}

function isTexTellerUrl(url: string): boolean {
  const pathname = new URL(url).pathname;
  return assets.some((asset) =>
    pathname.endsWith(`/${textTellerAssetPath(asset)}`),
  );
}
