import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(root, 'apps/cli');
const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'no-runtime': { type: 'boolean' },
  },
});
const nativeTargets: Record<string, string> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-arm64': 'bun-linux-arm64',
  'linux-x64': 'bun-linux-x64-baseline',
  'win32-x64': 'bun-windows-x64-baseline',
};
const target =
  values.target ?? nativeTargets[`${process.platform}-${process.arch}`];
if (
  !target ||
  !/^bun-(?:darwin|linux|windows)-(?:arm64|x64)(?:-baseline)?$/.test(target)
)
  throw new Error('Unsupported Bun compile target.');
if (
  !values['no-runtime'] &&
  target !== nativeTargets[`${process.platform}-${process.arch}`]
)
  throw new Error(
    'Build portable native-runtime bundles on the destination OS/architecture. Use --no-runtime for executable-only cross-compilation.',
  );

const output = join(cli, 'dist', target);
await mkdir(output, { recursive: true });
const executable = join(
  output,
  target.includes('windows') ? 'wordconvert.exe' : 'wordconvert',
);
const result = spawnSync(
  process.execPath,
  [
    'build',
    join(cli, 'src/main.ts'),
    '--compile',
    '--compile-autoload-package-json',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--external',
    '@napi-rs/canvas',
    '--external',
    'onnxruntime-node',
    '--target',
    target,
    '--define',
    '__WORDCONVERT_CLI_COMPILED__=true',
    '--outfile',
    executable,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`CLI compilation failed with exit code ${result.status}.`);

if (!values['no-runtime']) {
  const require = createRequire(join(cli, 'package.json'));
  const runtime = join(output, 'runtime/node_modules');
  const canvasPlatform =
    process.platform === 'linux'
      ? `linux-${process.arch}-gnu`
      : process.platform === 'win32'
        ? `win32-${process.arch}-msvc`
        : `${process.platform}-${process.arch}`;
  for (const name of [
    'onnxruntime-node',
    'onnxruntime-common',
    '@napi-rs/canvas',
    `@napi-rs/canvas-${canvasPlatform}`,
  ]) {
    const resolver =
      name === 'onnxruntime-common'
        ? createRequire(require.resolve('onnxruntime-node'))
        : name.startsWith('@napi-rs/canvas-')
          ? createRequire(require.resolve('@napi-rs/canvas'))
          : require;
    const source = dirname(resolver.resolve(`${name}/package.json`));
    const destination = join(runtime, name);
    if (name === 'onnxruntime-node')
      await rm(join(destination, 'bin'), { recursive: true, force: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const parts = path.slice(source.length).split(/[\\/]/).filter(Boolean);
        return (
          !parts.includes('node_modules') &&
          !(name === 'onnxruntime-node' && parts[0] === 'bin')
        );
      },
    });
    if (name === 'onnxruntime-node') {
      const platform = join('bin/napi-v6', process.platform, process.arch);
      await cp(join(source, platform), join(destination, platform), {
        recursive: true,
        dereference: true,
      });
    }
  }
}
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES'])
  await cp(join(root, name), join(output, name), { recursive: true });
const metadata = JSON.parse(
  await readFile(join(cli, 'package.json'), 'utf8'),
) as { version: string };
console.log(`WordConvert ${metadata.version}: ${resolve(output)}`);
