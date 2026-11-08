import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const heronRevision = '40bde044036bb181c130ddf6c51792187268748f';
const formulaRevision = '9727784d91d7f8437dc7140941c4335284ce075e';
export const MODEL_FILES = {
  heron: {
    filename: 'heron.onnx',
    size: 171220471,
    sha256: '59c81a3a2923042d85034ffc487f8f47e4854117e879aef89b2b9f728fb4922a',
    url: `https://huggingface.co/docling-project/docling-layout-heron-onnx/resolve/${heronRevision}/model.onnx`,
  },
  encoder: {
    filename: 'encoder.onnx',
    size: 56848921,
    sha256: 'de5fe45294a00f45af907b783f3f4764dbdc95386676f4e20175d912cfe8e59a',
    url: `https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/${formulaRevision}/onnx/encoder_model_q4.onnx`,
  },
  decoder: {
    filename: 'decoder.onnx',
    size: 198619422,
    sha256: 'd937474a36f212cd704acc811b9eef32405f3aa20c5da812d7bf227abbc6004b',
    url: `https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/${formulaRevision}/onnx/decoder_model_q4.onnx`,
  },
  tokenizer: {
    filename: 'tokenizer.json',
    size: 1370259,
    sha256: 'ec4ca954798a092faf6fefcfa47fb5f85d76cdf6ab170b624ae1a683d53dae14',
    url: `https://huggingface.co/onnx-community/TexTeller-ONNX/resolve/${formulaRevision}/tokenizer.json`,
  },
} as const;

export interface ModelFile {
  filename: string;
  size: number;
  sha256: string;
  url: string;
}

export function defaultModelCache(): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Caches')
      : process.platform === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'))
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  return join(base, 'wordconvert/models');
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function checkDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Model cache must be a directory, not a symlink.');
}

async function validCachedFile(
  path: string,
  file: ModelFile,
): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size)
      throw new Error(
        `Invalid cached model: ${path}. Use --clear-model-cache to remove it.`,
      );
    const handle = await open(path, 'r');
    try {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.byteLength;
        if (size > file.size)
          throw new Error(`Cached model exceeds its expected size: ${path}.`);
        hash.update(chunk);
      }
      if (hash.digest('hex') !== file.sha256)
        throw new Error(
          `Cached model checksum mismatch: ${path}. Use --clear-model-cache to remove it.`,
        );
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function ensureModel(
  directory: string,
  file: ModelFile,
  options: {
    offline: boolean;
    warn(message: string): void;
    fetch?: typeof fetch;
  },
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkDirectory(directory);
  const path = join(directory, file.filename);
  if (await validCachedFile(path, file)) return path;
  if (options.offline)
    throw new Error(
      `Model is not cached: ${path}. Run without --offline once, supply local models, or use --no-layout.`,
    );
  options.warn(
    `warning: Downloading ${file.filename} (${Math.ceil(file.size / 1024 / 1024)} MiB) from Hugging Face to ${path}. Documents are not uploaded. Remove cached models with --clear-model-cache.\n`,
  );
  const temporaryDirectory = await mkdtemp(join(directory, '.download-'));
  const temporary = join(temporaryDirectory, 'model');
  try {
    const response = await (options.fetch ?? fetch)(file.url, {
      signal: AbortSignal.timeout(600_000),
      credentials: 'omit',
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Model download failed: HTTP ${response.status}.`);
    }
    if (response.url && !response.url.startsWith('https://')) {
      await response.body.cancel();
      throw new Error('Model download redirected to an insecure URL.');
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== file.size) {
      await response.body.cancel();
      throw new Error('Model download has an unexpected content length.');
    }
    const handle = await open(temporary, 'wx', 0o600);
    const reader = response.body.getReader();
    try {
      const hash = createHash('sha256');
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > file.size)
          throw new Error('Model download exceeds its expected size.');
        hash.update(value);
        await handle.writeFile(value);
      }
      if (size !== file.size || hash.digest('hex') !== file.sha256)
        throw new Error('Model download size or SHA-256 checksum mismatch.');
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
        await handle.close();
      }
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
      await validCachedFile(path, file);
    }
    return path;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
    await rmdir(temporaryDirectory);
  }
}

export async function clearModelCache(directory: string): Promise<number> {
  try {
    await checkDirectory(directory);
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const file of Object.values(MODEL_FILES)) {
    try {
      await unlink(join(directory, file.filename));
      count++;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return count;
}
