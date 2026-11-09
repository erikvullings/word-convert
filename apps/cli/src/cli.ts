import { parseArgs } from 'node:util';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  link,
  mkdtemp,
  open,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  importStylePreset,
  isConversionError,
  type DocumentModel,
  type InferredValue,
  type StyleMapping,
} from '@wordconvert/document-model';
import { secureDocxReader } from '@wordconvert/docx-reader';
import { writeHtml, writeHtmlZip } from '@wordconvert/html-writer';
import { writeMarkdown, writeMarkdownZip } from '@wordconvert/markdown-writer';
import {
  DEFAULT_EPUB_MAX_IMAGE_DIMENSION,
  writeEpub,
} from '@wordconvert/epub-writer';
import type { MathOutputMode } from '@wordconvert/math-converter';
import { version } from '../package.json';
import { isExecutionProvider } from './inference-options.ts';
import {
  clearModelCache,
  defaultModelCache,
  ensureModel,
  MODEL_FILES,
} from './model-cache.ts';

const FORMATS = [
  'html',
  'html-zip',
  'markdown',
  'markdown-zip',
  'epub',
] as const;
type Format = (typeof FORMATS)[number];
const EXTENSIONS: Record<Format, string> = {
  html: '.html',
  'html-zip': '.html.zip',
  markdown: '.md',
  'markdown-zip': '.md.zip',
  epub: '.epub',
};
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const HELP = `WordConvert ${version} - local DOCX/PDF/Markdown/HTML conversion

Usage: wordconvert <input.docx|input.pdf|input.md|input.html> [options]
       wordconvert --clear-model-cache [--model-cache-dir <dir>]

  -f, --format <format>        epub (default), html, html-zip, markdown, markdown-zip
                              Inferred from --output extension unless explicitly set
  -o, --output <path>          Default: beside input, with the format's extension
                              Use "-" for stdout (including binary ZIP/EPUB)
      --force                 Replace an existing output, never the input/preset
      --style-preset <path>    Version 1 JSON preset exported by the SPA (DOCX only)
      --title <text>           Override inferred title
      --author <name>          Override authors (repeat for multiple authors)
      --language <tag>         Override language; missing/invalid document tag defaults to en
      --identifier <text>      Override publication identifier
      --formula-mode <mode>   source, mathml, katex, disabled
                              Default: mathml for EPUB, source otherwise
      --max-image-size <px>   Longest image edge in EPUB output; larger JPEG/PNG/WebP
                              images are downscaled. Default 1600, 0 disables
      --conversion-date <ISO>  Fixed date or UTC timestamp for reproducible output
      --rasterize             Render PDF vectors/pages using the native runtime
      --layout-model <path>   Use a local Heron ONNX model instead of the cached default
      --no-layout             Disable default PDF layout analysis (no Heron download)
      --formula-ocr           Enable TexTeller OCR, downloading missing models once
      --formula-model-dir <dir> Enable TexTeller (encoder.onnx, decoder.onnx,
                              tokenizer.json); overrides cached formula models
      --execution-provider <name> auto (default), cpu, coreml (macOS), webgpu
                              GPU providers require compatible drivers/hardware
      --runtime-dir <dir>     Override native runtime (auto-resolved beside real executable)
      --include-external-images Download public HTTPS raster images in Markdown/HTML
                              Disabled by default; never accesses private networks
      --offline               Never use the network; missing cached models are errors
      --model-cache-dir <dir>  Override OS model cache directory
      --clear-model-cache     Delete only managed cached models, then exit
  -h, --help                  Show this help
  -v, --version               Show version

Warnings and errors go to stderr. Exit codes: 0 success, 1 conversion/I/O error,
2 invalid arguments. Local files only; no browser, network, or installed runtime
is required by a compiled executable. PDF layout analysis downloads a pinned,
SHA-256-verified Heron model (~164 MiB) on first use with a warning on stderr.
Formula OCR is optional (~245 MiB). Documents are never uploaded.
Keep runtime/ beside the executable; temporary directories are not needed.
Auto prefers CoreML on macOS, WebGPU elsewhere, with a warning on CPU fallback.
Explicit GPU choices fail rather than silently fall back; unsupported operators use CPU.

Examples:
  wordconvert notes.md -o notes.epub
  wordconvert article.html -o article.epub
  wordconvert article.html --include-external-images -o article.epub
  wordconvert book.pdf -f epub -o book.epub
  wordconvert article.html --max-image-size 1200 -o small.epub
  wordconvert paper.pdf --formula-ocr -f markdown
  wordconvert book.pdf --no-layout --offline -f html
  wordconvert --clear-model-cache
`;

export interface CliIo {
  stdout(data: string | Uint8Array): Promise<void>;
  stderr(message: string): void;
}

class UsageError extends Error {}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArguments(argv);
    if (values.help) {
      await io.stdout(HELP);
      return 0;
    }
    if (values.version) {
      await io.stdout(`${version}\n`);
      return 0;
    }
    for (const [name, value] of Object.entries(values))
      if (typeof value === 'string' && !value.trim())
        throw new UsageError(`--${name} must not be empty.`);
    const cacheDirectory = resolve(
      values['model-cache-dir'] ?? defaultModelCache(),
    );
    if (values['clear-model-cache']) {
      if (
        positionals.length ||
        Object.keys(values).some(
          (key) => key !== 'clear-model-cache' && key !== 'model-cache-dir',
        )
      )
        throw new UsageError(
          '--clear-model-cache cannot be combined with conversion arguments.',
        );
      io.stderr(
        `Removed ${await clearModelCache(cacheDirectory)} cached model files from ${cacheDirectory}.\n`,
      );
      return 0;
    }
    const input = positionals[0];
    if (!input || positionals.length !== 1)
      throw new UsageError(
        'Provide exactly one local DOCX, PDF, Markdown, or HTML input. See --help.',
      );
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input))
      throw new UsageError(
        'Only local files are supported; remote URLs are not accepted.',
      );
    const extension = extname(input).toLowerCase();
    if (values['include-external-images'] && values.offline)
      throw new UsageError(
        '--include-external-images cannot be combined with --offline.',
      );
    if (
      values['include-external-images'] &&
      ['.docx', '.pdf'].includes(extension)
    )
      throw new UsageError(
        '--include-external-images is supported only for Markdown/HTML input.',
      );
    if (
      ![
        '.docx',
        '.pdf',
        '.md',
        '.markdown',
        '.html',
        '.htm',
        '.xhtml',
      ].includes(extension)
    )
      throw new UsageError(
        'Only local DOCX, PDF, Markdown (.md/.markdown), and HTML (.html/.htm/.xhtml) files are supported.',
      );
    if (values['include-external-images'])
      io.stderr(
        'warning: External image downloads are enabled. Image hosts can observe your IP address and requested URLs; documents are not uploaded.\n',
      );
    const format = values.format ?? inferOutputFormat(values.output) ?? 'epub';
    if (!isFormat(format))
      throw new UsageError(`Unknown format. Choose ${FORMATS.join(', ')}.`);
    const formulaMode =
      values['formula-mode'] ?? (format === 'epub' ? 'mathml' : 'source');
    if (!isFormulaMode(formulaMode))
      throw new UsageError(
        'Formula mode must be source, mathml, katex, or disabled.',
      );
    const maxImageSize = parseMaxImageSize(values['max-image-size']);
    if (values['max-image-size'] !== undefined && format !== 'epub')
      throw new UsageError('--max-image-size applies only to EPUB output.');
    const conversionDate =
      values['conversion-date'] ?? new Date().toISOString();
    if (!isIsoDate(conversionDate))
      throw new UsageError(
        'Conversion date must be a valid ISO date or UTC timestamp.',
      );
    if (
      values.language &&
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(values.language)
    )
      throw new UsageError('Language must be a valid BCP 47 language tag.');
    for (const text of [
      values.title,
      values.identifier,
      ...(values.author ?? []),
    ])
      if (text !== undefined && !text.trim())
        throw new UsageError('Metadata overrides must not be empty.');
    const presetPath = values['style-preset'];
    const provider = values['execution-provider'] ?? 'auto';
    if (provider !== 'auto' && !isExecutionProvider(provider))
      throw new UsageError(
        'Execution provider must be auto, cpu, coreml, or webgpu.',
      );
    if (values['no-layout'] && values['layout-model'])
      throw new UsageError(
        '--no-layout cannot be combined with --layout-model.',
      );
    if (
      values['execution-provider'] &&
      provider !== 'auto' &&
      values['no-layout'] &&
      !values['formula-ocr'] &&
      !values['formula-model-dir']
    )
      throw new UsageError(
        '--execution-provider requires layout analysis or formula OCR.',
      );
    if (
      extension !== '.pdf' &&
      (values.rasterize ||
        values['layout-model'] ||
        values['formula-model-dir'] ||
        values['formula-ocr'] ||
        values['no-layout'] ||
        values['execution-provider'] ||
        values['runtime-dir'])
    )
      throw new UsageError(
        'PDF rendering and model options require PDF input.',
      );
    if (presetPath && extension !== '.docx')
      throw new UsageError('Style presets apply only to DOCX input.');
    const output =
      values.output ??
      join(
        dirname(input),
        `${basename(input, extname(input))}${EXTENSIONS[format]}`,
      );
    if (output !== '-') {
      await protectSource(input, output);
      if (presetPath) await protectSource(presetPath, output);
      if (values['layout-model'])
        await protectSource(values['layout-model'], output);
      if (values['formula-model-dir'])
        for (const file of ['encoder.onnx', 'decoder.onnx', 'tokenizer.json'])
          await protectSource(join(values['formula-model-dir'], file), output);
    }
    let stylePreset: Record<string, StyleMapping> | undefined;
    if (presetPath) {
      const preset = importStylePreset(
        new TextDecoder().decode(await readBounded(presetPath, 1024 * 1024)),
      );
      if (!preset.ok || !preset.mappings)
        throw new UsageError(preset.error ?? 'Invalid style preset.');
      stylePreset = preset.mappings;
    }
    const bytes = await readBounded(input, MAX_INPUT_BYTES);
    let layoutModel = values['layout-model'];
    let formulaModelDir = values['formula-model-dir'];
    if (extension === '.pdf') {
      const needsLayout = !values['no-layout'];
      const needsFormula = values['formula-ocr'] || Boolean(formulaModelDir);
      if (needsLayout || needsFormula || values.rasterize) {
        // Resolve native libraries before downloading any model assets.
        (await import('./native-runtime.ts')).loadNativeRuntime(
          values['runtime-dir'],
        );
      }
      const downloadOptions = {
        offline: values.offline ?? false,
        warn: io.stderr,
      };
      if (needsLayout && !layoutModel)
        layoutModel = await ensureModel(
          cacheDirectory,
          MODEL_FILES.heron,
          downloadOptions,
        );
      if (needsFormula && !formulaModelDir) {
        for (const file of [
          MODEL_FILES.encoder,
          MODEL_FILES.decoder,
          MODEL_FILES.tokenizer,
        ])
          await ensureModel(cacheDirectory, file, downloadOptions);
        formulaModelDir = cacheDirectory;
      }
      if (output !== '-') {
        if (layoutModel) await protectSource(layoutModel, output);
        if (formulaModelDir)
          for (const file of ['encoder.onnx', 'decoder.onnx', 'tokenizer.json'])
            await protectSource(join(formulaModelDir, file), output);
      }
    }
    const options = { conversionDate };
    const filename = basename(input);
    const model =
      extension === '.docx'
        ? await secureDocxReader.read(bytes, {
            ...options,
            filename,
            ...(stylePreset ? { stylePreset } : {}),
          })
        : extension !== '.pdf'
          ? await (
              await import('./text.ts')
            ).readLocalText(
              bytes,
              input,
              ['.md', '.markdown'].includes(extension) ? 'markdown' : 'html',
              conversionDate,
              output === '-'
                ? undefined
                : (path) => protectSource(path, output),
              values['include-external-images'] ?? false,
              io.stderr,
            )
          : await (
              await import('./pdf.ts')
            ).readPdf(bytes, filename, {
              ...options,
              executionProvider: provider,
              onDiagnostic: io.stderr,
              ...(values.rasterize ? { rasterize: true } : {}),
              ...(layoutModel ? { layoutModel } : {}),
              ...(formulaModelDir ? { formulaModelDir } : {}),
              ...(values['runtime-dir']
                ? { runtimeDir: values['runtime-dir'] }
                : {}),
            });
    if (values.title !== undefined)
      model.metadata.title = userValue(values.title);
    if (values.language !== undefined)
      model.metadata.language = userValue(values.language);
    else if (
      !model.metadata.language?.value ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(
        model.metadata.language.value,
      )
    ) {
      model.metadata.language = {
        value: 'en',
        provenance: {
          source: 'CLI default language',
          method: 'default',
          confidence: 'low',
          reason:
            'Document language is missing or invalid; override with --language.',
        },
      };
      io.stderr(
        'warning: Document language is missing or invalid; using en. Override with --language if needed.\n',
      );
    }
    if (values.identifier !== undefined)
      model.metadata.identifier = userValue(values.identifier);
    if (values.author !== undefined)
      model.metadata.authors = values.author.map((name) => userValue({ name }));
    const data = await render(model, format, conversionDate, formulaMode, {
      maxImageSize,
      runtimeDir: values['runtime-dir'],
      warn: io.stderr,
    });
    for (const warning of model.warnings)
      io.stderr(`${warning.severity} [${warning.code}]: ${warning.message}\n`);
    if (output === '-') await io.stdout(data);
    else {
      await saveOutput(output, data, values.force ?? false);
      io.stderr(`Written ${output}\n`);
    }
    return 0;
  } catch (error) {
    const code = error instanceof UsageError ? 2 : 1;
    const message = isConversionError(error)
      ? `[${error.code}] ${error.message}`
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown conversion failure.';
    io.stderr(`wordconvert: ${message}\n`);
    return code;
  }
}

function parseArguments(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f' },
        output: { type: 'string', short: 'o' },
        force: { type: 'boolean' },
        'style-preset': { type: 'string' },
        title: { type: 'string' },
        author: { type: 'string', multiple: true },
        language: { type: 'string' },
        identifier: { type: 'string' },
        'formula-mode': { type: 'string' },
        'conversion-date': { type: 'string' },
        'max-image-size': { type: 'string' },
        rasterize: { type: 'boolean' },
        'no-layout': { type: 'boolean' },
        'formula-ocr': { type: 'boolean' },
        offline: { type: 'boolean' },
        'include-external-images': { type: 'boolean' },
        'model-cache-dir': { type: 'string' },
        'clear-model-cache': { type: 'boolean' },
        'layout-model': { type: 'string' },
        'formula-model-dir': { type: 'string' },
        'execution-provider': { type: 'string' },
        'runtime-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
}

function isFormat(value: string): value is Format {
  return FORMATS.some((format) => format === value);
}

function inferOutputFormat(output: string | undefined): Format | undefined {
  if (!output || output === '-') return undefined;
  const filename = output.toLowerCase();
  if (filename.endsWith('.html.zip')) return 'html-zip';
  if (filename.endsWith('.md.zip') || filename.endsWith('.markdown.zip'))
    return 'markdown-zip';
  if (filename.endsWith('.epub')) return 'epub';
  if (filename.endsWith('.html') || filename.endsWith('.htm')) return 'html';
  if (filename.endsWith('.md') || filename.endsWith('.markdown'))
    return 'markdown';
  if (filename.endsWith('.zip'))
    throw new UsageError(
      'Use --format html-zip or markdown-zip for an output ending in .zip, or use .html.zip/.md.zip.',
    );
  return undefined;
}
function isFormulaMode(value: string): value is MathOutputMode {
  return ['source', 'mathml', 'katex', 'disabled'].includes(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value))
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) ===
      (value.length === 10 ? `${value}T00:00:00` : value.slice(0, 19))
  );
}

function userValue<T>(value: T): InferredValue<T> {
  return {
    value,
    provenance: { source: 'CLI option', method: 'user', confidence: 'certain' },
  };
}

async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Input must be a regular file.');
    if (info.size > limit)
      throw new Error(`File exceeds the ${limit} byte input limit.`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit)
        throw new Error(`File exceeds the ${limit} byte input limit.`);
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    await file.close();
  }
}

async function protectSource(source: string, output: string): Promise<void> {
  if (resolve(source) === resolve(output))
    throw new UsageError(
      'Output must not replace the input document or style preset.',
    );
  const sourceInfo = await stat(source);
  try {
    const outputInfo = await stat(output);
    if (sourceInfo.dev === outputInfo.dev && sourceInfo.ino === outputInfo.ino)
      throw new UsageError(
        'Output must not replace the input document or style preset.',
      );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}

async function saveOutput(
  path: string,
  data: string | Uint8Array,
  force: boolean,
): Promise<void> {
  const directory = await mkdtemp(
    join(dirname(resolve(path)), '.wordconvert-'),
  );
  const temporary = join(directory, 'output');
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    if (force) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    });
    await rmdir(directory);
  }
}

function parseMaxImageSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EPUB_MAX_IMAGE_DIMENSION;
  if (!/^\d+$/.test(value) || Number(value) > 32768)
    throw new UsageError(
      '--max-image-size must be a whole number of pixels from 0 to 32768.',
    );
  return Number(value);
}

async function render(
  model: DocumentModel,
  format: Format,
  conversionDate: string,
  formulaMode: MathOutputMode,
  images: {
    maxImageSize: number;
    runtimeDir: string | undefined;
    warn: (message: string) => void;
  },
): Promise<string | Uint8Array> {
  const options = { conversionDate, formulaMode };
  const markdownOptions = {
    ...options,
    onWarning: (warning: DocumentModel['warnings'][number]) =>
      model.warnings.push(warning),
  };
  switch (format) {
    case 'html':
      return writeHtml(model, { ...options, mode: 'standalone' });
    case 'html-zip':
      return writeHtmlZip(model, options);
    case 'markdown':
      return writeMarkdown(model, markdownOptions);
    case 'markdown-zip':
      return writeMarkdownZip(model, markdownOptions);
    case 'epub': {
      const imageResizer =
        images.maxImageSize > 0
          ? (await import('./image-resizer.ts')).createImageResizer(
              images.runtimeDir,
            )
          : undefined;
      if (images.maxImageSize > 0 && !imageResizer)
        images.warn(
          'warning: Native image runtime unavailable; images are embedded at original size.\n',
        );
      return writeEpub(model, {
        ...options,
        maxImageDimension: images.maxImageSize,
        ...(imageResizer ? { imageResizer } : {}),
      });
    }
  }
}
