import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    bundle: { type: 'string' },
    prefix: { type: 'string' },
    'bin-dir': { type: 'string' },
    force: { type: 'boolean' },
  },
});
const targets: Record<string, string> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64': 'bun-linux-x64-baseline',
  'win32-x64': 'bun-windows-x64-baseline',
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error('Unsupported installation platform.');
const bundle = resolve(
  values.bundle ??
    fileURLToPath(new URL(`../dist/${target}/`, import.meta.url)),
);
const prefix = resolve(
  values.prefix ??
    (process.platform === 'win32'
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'),
          'wordconvert',
        )
      : join(homedir(), '.local/share/wordconvert')),
);
const executable =
  process.platform === 'win32' ? 'wordconvert.exe' : 'wordconvert';
const marker = '.wordconvert-install';
await lstat(join(bundle, executable));
if (prefix === bundle)
  throw new Error('Installation directory must differ from the build bundle.');
if (
  prefix === homedir() ||
  prefix === dirname(prefix) ||
  !relative(bundle, prefix).startsWith('..') ||
  !relative(prefix, bundle).startsWith('..')
)
  throw new Error(
    'Installation must be outside the build bundle, not a filesystem root or home directory.',
  );
async function exists(path: string) {
  try {
    return await lstat(path);
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
}
if (await exists(prefix)) {
  if (!values.force)
    throw new Error(
      `Installation already exists at ${prefix}. Use --force to update a managed installation.`,
    );
  if (
    (await lstat(prefix)).isSymbolicLink() ||
    (await readFile(join(prefix, marker), 'utf8')) !== 'wordconvert\n'
  )
    throw new Error('Refusing to replace an unmanaged installation directory.');
}
const bin = resolve(values['bin-dir'] ?? join(homedir(), '.local/bin'));
const link = join(bin, 'wordconvert');
if (process.platform !== 'win32' && (await exists(link))) {
  const { realpath } = await import('node:fs/promises');
  if ((await realpath(link)) !== (await realpath(join(prefix, executable))))
    throw new Error(`Refusing to overwrite another command at ${link}.`);
}
await mkdir(dirname(prefix), { recursive: true });
const { mkdtemp } = await import('node:fs/promises');
const staging = await mkdtemp(join(dirname(prefix), '.wordconvert-install-'));
try {
  await cp(bundle, staging, { recursive: true });
  await writeFile(join(staging, marker), 'wordconvert\n');
  if (await exists(prefix)) {
    const backup = `${staging}.previous`;
    await rename(prefix, backup);
    try {
      await rename(staging, prefix);
    } catch (error) {
      await rename(backup, prefix);
      throw error;
    }
    await rm(backup, { recursive: true });
  } else await rename(staging, prefix);
  if (process.platform !== 'win32') {
    await mkdir(bin, { recursive: true });
    if (!(await exists(link))) await symlink(join(prefix, executable), link);
    console.log(`Installed ${link}. Ensure ${bin} is on PATH.`);
  } else {
    console.log(
      `Installed ${join(prefix, executable)}. Add ${prefix} to your user PATH.`,
    );
  }
} finally {
  if (await exists(staging)) await rm(staging, { recursive: true });
}
