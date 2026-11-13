import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('installs full bundles, upgrades managed installations and refuses unmanaged replacements', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'wordconvert-install-test-'));
  try {
    const bundle = join(temporary, 'bundle');
    const prefix = join(temporary, 'installed');
    const bin = join(temporary, 'bin');
    const executable =
      process.platform === 'win32' ? 'wordconvert.exe' : 'wordconvert';
    await mkdir(join(bundle, 'runtime'), { recursive: true });
    await writeFile(join(bundle, executable), 'version one');
    await writeFile(join(bundle, 'runtime', 'dependency'), 'runtime');
    const script = fileURLToPath(
      new URL('../scripts/install.ts', import.meta.url),
    );
    const invoke = (...args: string[]) =>
      spawnSync(
        'bun',
        [
          script,
          '--bundle',
          bundle,
          '--prefix',
          prefix,
          '--bin-dir',
          bin,
          ...args,
        ],
        { encoding: 'utf8' },
      );
    const first = invoke();
    if (first.error) throw first.error;
    expect(first.status, first.stderr).toBe(0);
    expect(await readFile(join(prefix, 'runtime/dependency'), 'utf8')).toBe(
      'runtime',
    );
    if (process.platform !== 'win32')
      expect(await realpath(join(bin, 'wordconvert'))).toBe(
        await realpath(join(prefix, executable)),
      );
    expect(invoke().status).not.toBe(0);
    await writeFile(join(bundle, executable), 'version two');
    const upgrade = invoke('--force');
    expect(upgrade.status, upgrade.stderr).toBe(0);
    expect(await readFile(join(prefix, executable), 'utf8')).toBe(
      'version two',
    );
    await writeFile(
      join(prefix, '.wordconvert-install'),
      'another application',
    );
    expect(invoke('--force').status).not.toBe(0);
    expect(await readFile(join(prefix, executable), 'utf8')).toBe(
      'version two',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
