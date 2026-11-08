import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearModelCache, ensureModel, type ModelFile } from './model-cache.ts';

const content = new TextEncoder().encode('test ONNX model');
const file: ModelFile = {
  filename: 'heron.onnx',
  url: 'https://huggingface.co/test/model',
  size: content.length,
  sha256: createHash('sha256').update(content).digest('hex'),
};
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'wordconvert-model-cache-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('model cache', () => {
  it('publishes concurrent downloads atomically without leaving temporary files', async () => {
    const cache = await directory();
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(content));
    const options = { offline: false, warn: vi.fn(), fetch: download };
    const paths = await Promise.all([
      ensureModel(cache, file, options),
      ensureModel(cache, file, options),
    ]);
    expect(paths[0]).toBe(paths[1]);
    expect(await readdir(cache)).toEqual(['heron.onnx']);
    expect(await readFile(paths[0]!)).toEqual(Buffer.from(content));
  });
  it('warns before downloading, verifies and caches assets, then runs offline without fetching', async () => {
    const cache = await directory();
    const warn = vi.fn();
    const download = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Downloading'));
      return new Response(content);
    });
    const path = await ensureModel(cache, file, {
      offline: false,
      warn,
      fetch: download,
    });
    expect(await readFile(path)).toEqual(Buffer.from(content));
    expect(download).toHaveBeenCalledOnce();
    expect(
      await ensureModel(cache, file, { offline: true, warn, fetch: download }),
    ).toBe(path);
    expect(download).toHaveBeenCalledOnce();
    expect(await readdir(cache)).toEqual(['heron.onnx']);
  });

  it.each(['http', 'length', 'oversize', 'truncated', 'checksum', 'stream'])(
    'rejects %s failures and removes partial downloads',
    async (failure) => {
      const cache = await directory();
      const download = vi.fn<typeof fetch>().mockResolvedValue(
        failure === 'http'
          ? new Response(null, { status: 503 })
          : failure === 'length'
            ? new Response(content, { headers: { 'content-length': '1000' } })
            : failure === 'oversize'
              ? new Response(new Uint8Array(content.length + 1))
              : failure === 'truncated'
                ? new Response(content.subarray(0, 3))
                : failure === 'stream'
                  ? new Response(
                      new ReadableStream({
                        start(controller) {
                          controller.error(new Error('network failed'));
                        },
                      }),
                    )
                  : new Response(new Uint8Array(content.length)),
      );
      await expect(
        ensureModel(cache, file, {
          offline: false,
          warn: vi.fn(),
          fetch: download,
        }),
      ).rejects.toThrow();
      expect(await readdir(cache)).toEqual([]);
    },
  );

  it('does not fetch when offline or when the cache is corrupt', async () => {
    const cache = await directory();
    const download = vi.fn<typeof fetch>();
    const options = { offline: true, warn: vi.fn(), fetch: download };
    await expect(ensureModel(cache, file, options)).rejects.toThrow(
      'not cached',
    );
    await writeFile(join(cache, file.filename), new Uint8Array(file.size));
    await expect(
      ensureModel(cache, file, { ...options, offline: false }),
    ).rejects.toThrow('checksum mismatch');
    expect(download).not.toHaveBeenCalled();
  });

  it('clears managed files but preserves custom files and symlink targets', async () => {
    const cache = await directory();
    const external = join(await directory(), 'model');
    await writeFile(external, content);
    await symlink(external, join(cache, 'heron.onnx'));
    await writeFile(join(cache, 'custom.onnx'), content);
    expect(await clearModelCache(cache)).toBe(1);
    expect(await readFile(external)).toEqual(Buffer.from(content));
    expect(await readdir(cache)).toEqual(['custom.onnx']);
  });

  it('refuses a symlinked cache root', async () => {
    const parent = await directory();
    const target = await directory();
    const cache = join(parent, 'cache');
    await symlink(
      target,
      cache,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(clearModelCache(cache)).rejects.toThrow('not a symlink');
    await expect(
      ensureModel(cache, file, { offline: true, warn: vi.fn() }),
    ).rejects.toThrow('not a symlink');
  });
});
