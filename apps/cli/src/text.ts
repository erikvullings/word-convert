import { open, realpath } from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { readTextDocument } from '@wordconvert/text-reader';
import { createHash } from 'node:crypto';
import { downloadExternalImage } from './external-images.ts';

const mediaTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

export async function readLocalText(
  bytes: Uint8Array,
  input: string,
  format: 'markdown' | 'html',
  conversionDate: string,
  protectImage?: (path: string) => Promise<void>,
  includeExternalImages = false,
  warn?: (message: string) => void,
) {
  const root = await realpath(dirname(resolve(input)));
  const model = await readTextDocument(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    format,
    {
      filename: input.split(/[\\/]/).at(-1) ?? 'document',
      conversionDate,
      async loadImage(source) {
        if (
          includeExternalImages &&
          (/^https?:/i.test(source) || source.startsWith('//'))
        ) {
          try {
            return await downloadExternalImage(source);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            warn?.(
              `warning [cli-external-image-omitted]: External image skipped: ${reason}\n`,
            );
            return undefined;
          }
        }
        if (
          !source ||
          /^[a-z][a-z0-9+.-]*:/i.test(source) ||
          source.startsWith('//') ||
          isAbsolute(source)
        )
          return undefined;
        const decoded = decodeURIComponent(source.split(/[?#]/)[0] ?? '');
        const candidate = resolve(root, decoded);
        const lexical = relative(root, candidate);
        if (
          lexical === '..' ||
          lexical.startsWith(`..${sep}`) ||
          isAbsolute(lexical)
        )
          return undefined;
        let path: string;
        try {
          path = await realpath(candidate);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return undefined;
          throw error;
        }
        const resolved = relative(root, path);
        if (
          resolved === '..' ||
          resolved.startsWith(`..${sep}`) ||
          isAbsolute(resolved)
        )
          return undefined;
        const mediaType = mediaTypes[extname(path).toLowerCase()];
        if (!mediaType) return undefined;
        await protectImage?.(path);
        const file = await open(path, 'r');
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 10 * 1024 * 1024)
            throw new Error(
              'Local image must be a regular file of at most 10 MiB.',
            );
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of file.createReadStream({
            autoClose: false,
          })) {
            size += chunk.byteLength;
            if (size > 10 * 1024 * 1024)
              throw new Error('Local image exceeds the 10 MiB limit.');
            chunks.push(chunk);
          }
          return {
            mediaType,
            data: new Uint8Array(Buffer.concat(chunks, size)),
          };
        } finally {
          await file.close();
        }
      },
    },
  );
  model.metadata.identifier = {
    value: `urn:sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    provenance: {
      source: 'Text source SHA-256',
      method: 'default',
      confidence: 'certain',
    },
  };
  return model;
}
