import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetDirectory = resolve(root, 'apps/web/src/assets/formula-ocr');
const manifest = JSON.parse(
  await readFile(resolve(assetDirectory, 'model-manifest.json'), 'utf8'),
);
const baseUrl = `https://huggingface.co/${manifest.mirror}/resolve/${manifest.revision}`;

await mkdir(assetDirectory, { recursive: true });
for (const file of manifest.files) {
  const destination = resolve(assetDirectory, file.path);
  let valid = await verify(destination, file);
  if (!valid) {
    const response = await fetch(`${baseUrl}/${file.path}`);
    if (!response.ok)
      throw new Error(
        `Could not download ${file.path}: HTTP ${response.status}`,
      );
    await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
    valid = await verify(destination, file);
  }
  if (!valid)
    throw new Error(`${file.path} does not match its pinned manifest.`);
  console.log(`verified ${file.path}`);
}

async function verify(path, expected) {
  try {
    if ((await stat(path)).size !== expected.size) return false;
    if (!expected.sha256) return true;
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    return hash === expected.sha256;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return false;
    throw cause;
  }
}
