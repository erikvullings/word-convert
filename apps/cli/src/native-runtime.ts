import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __WORDCONVERT_CLI_COMPILED__: boolean;

function runtimeRoot(directory?: string): string {
  const defaultDirectory =
    typeof __WORDCONVERT_CLI_COMPILED__ !== 'undefined'
      ? join(dirname(realpathSync(process.execPath)), 'runtime')
      : fileURLToPath(new URL('../', import.meta.url));
  return resolve(directory ?? defaultDirectory);
}

/** Loads only the canvas binding; used for image resizing without ONNX. */
export function loadCanvas(
  directory?: string,
): typeof import('@napi-rs/canvas') {
  const root = runtimeRoot(directory);
  return createRequire(join(root, 'package.json'))('@napi-rs/canvas');
}

export function loadNativeRuntime(directory?: string) {
  const defaultDirectory =
    typeof __WORDCONVERT_CLI_COMPILED__ !== 'undefined'
      ? join(dirname(realpathSync(process.execPath)), 'runtime')
      : fileURLToPath(new URL('../', import.meta.url));
  const root = resolve(directory ?? defaultDirectory);
  const require = createRequire(join(root, 'package.json'));
  let canvas: typeof import('@napi-rs/canvas');
  let ort: typeof import('onnxruntime-node');
  try {
    canvas = require('@napi-rs/canvas');
    const intelSource =
      typeof __WORDCONVERT_CLI_COMPILED__ === 'undefined' &&
      process.platform === 'darwin' &&
      process.arch === 'x64';
    ort = require(
      intelSource ? 'wordconvert-onnxruntime-intel' : 'onnxruntime-node',
    );
  } catch (error) {
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
    throw new Error(
      `Could not load native runtime at ${root}: ${message}. Keep runtime/ beside the executable or override --runtime-dir. For basic PDF conversion use --no-layout.`,
      { cause: error },
    );
  }
  Object.assign(globalThis, {
    DOMMatrix: canvas.DOMMatrix,
    ImageData: canvas.ImageData,
    Path2D: canvas.Path2D,
  });
  ort.env.logLevel = 'error';
  return { canvas, ort };
}

export type NativeRuntime = ReturnType<typeof loadNativeRuntime>;
