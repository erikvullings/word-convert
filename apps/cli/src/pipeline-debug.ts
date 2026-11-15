import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  PipelineStageEvent,
  WriterArtifacts,
} from '@wordconvert/document-model';

const MAX_STAGE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const JSON_BUDGETS = [
  { items: 8_000, text: 1024 },
  { items: 2_000, text: 512 },
  { items: 500, text: 256 },
];
const TEXT_OUTPUT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.md',
  '.opf',
  '.xhtml',
  '.xml',
]);

export class PipelineDebugUsageError extends Error {}

export interface PipelineDebugOptions {
  directory: string;
  input: string;
  output: string;
  cwd: string;
  force: boolean;
  includeAssets: boolean;
  request: Record<string, unknown>;
  warn(message: string): void;
}

export interface PipelineDebugDump {
  onStage(event: PipelineStageEvent): void;
}

interface ProjectionBudget {
  itemsLeft: number;
  maxText: number;
  truncated: boolean;
}

export async function createPipelineDebugDump(
  options: PipelineDebugOptions,
): Promise<PipelineDebugDump | undefined> {
  const requested = resolve(options.directory);
  let parent: string;
  let sourceDirectory: string;
  let cwd: string;
  try {
    parent = await realpath(dirname(requested));
    sourceDirectory = dirname(await realpath(options.input));
    cwd = await realpath(options.cwd);
  } catch {
    throw new PipelineDebugUsageError(
      'The pipeline dump parent and input must exist before conversion.',
    );
  }
  const directory = resolve(parent, basename(requested));
  if (within(directory, sourceDirectory))
    throw new PipelineDebugUsageError(
      'The pipeline dump directory must not be the input directory or one of its ancestors.',
    );
  if (!options.force && !within(cwd, directory))
    throw new PipelineDebugUsageError(
      'The pipeline dump directory must be inside the current working directory unless --force is used.',
    );
  if (options.output !== '-' && within(directory, resolve(options.output)))
    throw new PipelineDebugUsageError(
      'The output file must not be inside the pipeline dump directory.',
    );
  try {
    await lstat(directory);
    throw new PipelineDebugUsageError(
      'The pipeline dump directory must not already exist.',
    );
  } catch (error) {
    if (error instanceof PipelineDebugUsageError) throw error;
    if (!isMissing(error)) throw error;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
    const dump = new PipelineDebugDumpWriter(
      directory,
      options.warn,
      options.includeAssets,
    );
    dump.writeJson('0-request.json', 'request', options.request);
    return dump;
  } catch {
    options.warn(
      'warning: Could not create the pipeline dump; conversion will continue without stage files.\n',
    );
    return undefined;
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

class PipelineDebugDumpWriter implements PipelineDebugDump {
  private disabled = false;

  constructor(
    private readonly directory: string,
    private readonly warn: (message: string) => void,
    private readonly includeAssets: boolean,
  ) {}

  onStage(event: PipelineStageEvent): void {
    if (this.disabled) return;
    try {
      switch (event.stage) {
        case 'raw':
          this.writeJson('1-raw.json', 'raw', event.data);
          break;
        case 'analysis':
          this.writeJson('2-analysis.json', 'analysis', event.data);
          break;
        case 'model':
          this.writeJson('3-model.json', 'model', event.data);
          break;
        case 'output':
          this.writeOutput(event.data);
          break;
      }
    } catch {
      this.disabled = true;
      this.warn(
        'warning: Could not write a pipeline dump artifact; conversion output is unaffected.\n',
      );
    }
  }

  writeJson(path: string, stage: string, value: unknown): void {
    const json = serializeStage(stage, value);
    this.write(path, Buffer.from(json, 'utf8'));
  }

  private writeOutput(artifacts: WriterArtifacts): void {
    const assets: Array<{
      path: string;
      size: number;
      sha256: string;
      included: boolean;
    }> = [];
    let total = 0;
    let inlineAssetNumber = 0;
    for (const path of Object.keys(artifacts).sort()) {
      const source = artifacts[path];
      if (!(source instanceof Uint8Array))
        throw new TypeError('Writer artifact is not a byte array.');
      if (!isSafeArtifactPath(path))
        throw new TypeError('Writer artifact has an unsafe path.');
      total += source.byteLength;
      if (total > MAX_OUTPUT_BYTES)
        throw new RangeError('Writer artifacts exceed the dump size limit.');
      if (
        path === 'mimetype' ||
        path.endsWith('/mimetype') ||
        TEXT_OUTPUT_EXTENSIONS.has(extension(path))
      ) {
        const text = Buffer.from(source).toString('utf8');
        const redacted = text.replace(
          /data:([a-z0-9.+/-]+);base64,([a-z0-9+/]+={0,2})/gi,
          (match, mediaType: string, encoded: string) => {
            const data = Buffer.from(encoded, 'base64');
            const reference = `inline-asset-${String(++inlineAssetNumber).padStart(3, '0')}`;
            assets.push({
              path: `${path}#${reference}`,
              size: data.byteLength,
              sha256: sha256(data),
              included: this.includeAssets,
            });
            return this.includeAssets
              ? match
              : `wordconvert-asset-ref:${reference};media-type=${mediaType}`;
          },
        );
        this.write(
          `4-output/${path}`,
          redacted === text ? source : Buffer.from(redacted, 'utf8'),
        );
      } else {
        assets.push({
          path,
          size: source.byteLength,
          sha256: sha256(source),
          included: this.includeAssets,
        });
        if (this.includeAssets) this.write(`4-output/${path}`, source);
      }
    }
    this.writeJson('4-output/assets.json', 'output-assets', { assets });
  }

  private write(path: string, data: Uint8Array): void {
    const output = resolve(this.directory, path);
    if (!within(this.directory, output))
      throw new TypeError('Pipeline artifact path escapes the dump directory.');
    const parent = dirname(output);
    this.makeDirectories(parent);
    writeFileSync(output, data, { flag: 'wx', mode: 0o600 });
  }

  private makeDirectories(path: string): void {
    const root = lstatSync(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error('Pipeline dump directory is no longer private.');
    const relativePath = relative(this.directory, path);
    if (!relativePath) return;
    let current = this.directory;
    for (const part of relativePath.split(sep)) {
      current = resolve(current, part);
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (!(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EEXIST' &&
          lstatSync(current).isDirectory() &&
          !lstatSync(current).isSymbolicLink()
        ))
          throw error;
      }
    }
  }
}

function serializeStage(stage: string, value: unknown): string {
  for (const limits of JSON_BUDGETS) {
    const budget: ProjectionBudget = {
      itemsLeft: limits.items,
      maxText: limits.text,
      truncated: false,
    };
    const data = record(value);
    const projection =
      data.status === 'not-applicable'
        ? {
            status: 'not-applicable',
            reason: text(data.reason, budget),
          }
        : stage === 'raw'
          ? projectRawPdf(value, budget)
          : stage === 'analysis'
            ? projectPdfAnalysis(value, budget)
            : stage === 'model'
              ? projectDocumentModel(value, budget)
              : value;
    const json = JSON.stringify(
      {
        schema: 1,
        stage,
        ...record(projection),
        truncated: budget.truncated,
      },
      null,
      2,
    );
    if (Buffer.byteLength(json) <= MAX_STAGE_JSON_BYTES) return `${json}\n`;
  }
  return `${JSON.stringify(
    {
      schema: 1,
      stage,
      truncated: true,
      reason: 'Serialized stage exceeds the 16 MiB dump limit.',
    },
    null,
    2,
  )}\n`;
}

function projectRawPdf(value: unknown, budget = createBudget()): object {
  const raw = record(value);
  return {
    version: number(raw.version),
    pageCount: number(raw.pageCount),
    pages: list(raw.pages, budget).map((value) => {
      const page = record(value);
      return {
        number: number(page.number),
        width: number(page.width),
        height: number(page.height),
        rotation: number(page.rotation),
        ...(optionalBoolean(page.imageBacked) === undefined
          ? {}
          : { imageBacked: page.imageBacked }),
        ...(optionalBoolean(page.dense) === undefined
          ? {}
          : { dense: page.dense }),
        ...(record(page.fallback).reason
          ? {
              fallback: {
                reason: text(record(page.fallback).reason, budget),
                mode: text(record(page.fallback).mode, budget),
              },
            }
          : {}),
        images: list(page.images, budget).map((value) => {
          const image = record(value);
          const data = bytes(image.data);
          return {
            id: text(image.id, budget),
            x: number(image.x),
            top: number(image.top),
            width: number(image.width),
            height: number(image.height),
            pixelWidth: number(image.pixelWidth),
            pixelHeight: number(image.pixelHeight),
            mediaType: text(image.mediaType, budget),
            data: dataReference(data),
            ...(optionalText(image.source, budget) === undefined
              ? {}
              : { source: text(image.source, budget) }),
            ...(optionalNumber(image.placementTop) === undefined
              ? {}
              : { placementTop: image.placementTop }),
          };
        }),
        spans: list(page.spans, budget).map((value) => {
          const span = record(value);
          return {
            id: text(span.id, budget),
            text: text(span.text, budget),
            x: number(span.x),
            top: number(span.top),
            width: number(span.width),
            height: number(span.height),
            ...(optionalNumber(span.baseline) === undefined
              ? {}
              : { baseline: span.baseline }),
            ...(optionalNumber(span.ascent) === undefined
              ? {}
              : { ascent: span.ascent }),
            ...(optionalNumber(span.descent) === undefined
              ? {}
              : { descent: span.descent }),
            fontId: text(span.fontId, budget),
            ...(optionalText(span.fontFamily, budget) === undefined
              ? {}
              : { fontFamily: text(span.fontFamily, budget) }),
            fontSize: number(span.fontSize),
            bold: boolean(span.bold),
            italic: boolean(span.italic),
            direction: text(span.direction, budget),
            ...(optionalText(span.linkId, budget) === undefined
              ? {}
              : { linkId: text(span.linkId, budget) }),
            ...(optionalText(span.markedContentId, budget) === undefined
              ? {}
              : { markedContentId: text(span.markedContentId, budget) }),
          };
        }),
        links: list(page.links, budget).map((value) => {
          const link = record(value);
          return {
            id: text(link.id, budget),
            href: text(link.href, budget),
            x: number(link.x),
            top: number(link.top),
            width: number(link.width),
            height: number(link.height),
          };
        }),
        ...(Array.isArray(page.formulaCandidates)
          ? {
              formulaCandidates: list(page.formulaCandidates, budget).map(
                (candidate) => projectFormulaCandidate(candidate, budget),
              ),
            }
          : {}),
        ...(page.taggedStructure
          ? { taggedStructure: projectStructure(page.taggedStructure, budget) }
          : {}),
        ...(Array.isArray(page.strokes)
          ? {
              strokes: list(page.strokes, budget).map((value) => {
                const stroke = record(value);
                return {
                  x1: number(stroke.x1),
                  y1: number(stroke.y1),
                  x2: number(stroke.x2),
                  y2: number(stroke.y2),
                  width: number(stroke.width),
                };
              }),
            }
          : {}),
        ...(optionalBoolean(page.strokesTruncated) === undefined
          ? {}
          : { strokesTruncated: page.strokesTruncated }),
      };
    }),
    metadata: {
      title: optionalText(raw.metadata && record(raw.metadata).title, budget),
      author: optionalText(raw.metadata && record(raw.metadata).author, budget),
      subject: optionalText(
        raw.metadata && record(raw.metadata).subject,
        budget,
      ),
      keywords: list(record(raw.metadata).keywords, budget).map((value) =>
        text(value, budget),
      ),
      language: optionalText(
        raw.metadata && record(raw.metadata).language,
        budget,
      ),
      createdAt: optionalText(
        raw.metadata && record(raw.metadata).createdAt,
        budget,
      ),
      modifiedAt: optionalText(
        raw.metadata && record(raw.metadata).modifiedAt,
        budget,
      ),
    },
    outline: list(raw.outline, budget).map((item) =>
      projectOutline(item, budget),
    ),
  };
}

function projectPdfAnalysis(value: unknown, budget = createBudget()): object {
  const analysis = record(value);
  const crop = record(analysis.crop);
  return {
    pageCount: number(analysis.pageCount),
    analysedPages: list(analysis.analysedPages, budget).map(number),
    crop: { top: number(crop.top), bottom: number(crop.bottom) },
    ...(Array.isArray(analysis.reflowIssues)
      ? {
          reflowIssues: list(analysis.reflowIssues, budget).map((value) => {
            const issue = record(value);
            return {
              page: number(issue.page),
              columns: number(issue.columns),
              reorderedLines: number(issue.reorderedLines),
            };
          }),
        }
      : {}),
    candidates: list(analysis.candidates, budget).map((value) => {
      const candidate = record(value);
      return {
        id: text(candidate.id, budget),
        kind: text(candidate.kind, budget),
        text: text(candidate.text, budget),
        normalizedText: text(candidate.normalizedText, budget),
        pageParity: text(candidate.pageParity, budget),
        pageNumbers: list(candidate.pageNumbers, budget).map(number),
        confidence: text(candidate.confidence, budget),
        removed: boolean(candidate.removed),
      };
    }),
    scannedPages: list(analysis.scannedPages, budget).map(number),
    ...(Array.isArray(analysis.imageBackedPages)
      ? {
          imageBackedPages: list(analysis.imageBackedPages, budget).map(number),
        }
      : {}),
    ...(Array.isArray(analysis.densePages)
      ? { densePages: list(analysis.densePages, budget).map(number) }
      : {}),
    ...(Array.isArray(analysis.fallbackPages)
      ? {
          fallbackPages: list(analysis.fallbackPages, budget).map((value) => {
            const fallback = record(value);
            return {
              page: number(fallback.page),
              reason: text(fallback.reason, budget),
              mode: text(fallback.mode, budget),
            };
          }),
        }
      : {}),
    ...(Array.isArray(analysis.formulaCandidates)
      ? {
          formulaCandidates: list(analysis.formulaCandidates, budget).map(
            (value) => projectFormulaCandidate(value, budget),
          ),
        }
      : {}),
    ...(Array.isArray(analysis.formulaImageRegions)
      ? {
          formulaImageRegions: list(analysis.formulaImageRegions, budget).map(
            (value) => {
              const region = record(value);
              return {
                id: text(region.id, budget),
                page: number(region.page),
                bounds: projectBounds(region.bounds),
              };
            },
          ),
        }
      : {}),
    ...(Array.isArray(analysis.tables)
      ? {
          tables: list(analysis.tables, budget).map((value) => {
            const table = record(value);
            return {
              page: number(table.page),
              rows: number(table.rows),
              columns: number(table.columns),
              source: text(table.source, budget),
              confidence: text(table.confidence, budget),
            };
          }),
        }
      : {}),
  };
}

function projectFormulaCandidate(value: unknown, budget: ProjectionBudget) {
  const candidate = record(value);
  const recognition = record(candidate.recognition);
  const diagnostics = record(recognition.diagnostics);
  const features = record(candidate.features);
  return {
    id: text(candidate.id, budget),
    page: number(candidate.page),
    kind: text(candidate.kind, budget),
    bounds: projectBounds(candidate.bounds),
    spanIds: list(candidate.spanIds, budget).map((id) => text(id, budget)),
    features: {
      mathFontRatio: number(features.mathFontRatio),
      operatorRatio: number(features.operatorRatio),
      greekRatio: number(features.greekRatio),
      symbolRatio: number(features.symbolRatio),
      singleLetterTokenRatio: number(features.singleLetterTokenRatio),
      dictionaryLikeWordRatio: number(features.dictionaryLikeWordRatio),
      superscriptCount: number(features.superscriptCount),
      subscriptCount: number(features.subscriptCount),
      baselineVariance: number(features.baselineVariance),
      fontSizeVariance: number(features.fontSizeVariance),
      centered: boolean(features.centered),
      isolated: boolean(features.isolated),
      equationNumberAtRight: boolean(features.equationNumberAtRight),
      multilineStructure: boolean(features.multilineStructure),
      ...(optionalNumber(features.heronFormulaConfidence) === undefined
        ? {}
        : { heronFormulaConfidence: features.heronFormulaConfidence }),
      score: number(features.score),
      confidence: text(features.confidence, budget),
    },
    score: number(candidate.score),
    confidence: text(candidate.confidence, budget),
    sources: list(candidate.sources, budget).map((source) =>
      text(source, budget),
    ),
    ...(optionalText(candidate.sourceImageId, budget) === undefined
      ? {}
      : { sourceImageId: text(candidate.sourceImageId, budget) }),
    ...(optionalText(candidate.tex, budget) === undefined
      ? {}
      : { tex: text(candidate.tex, budget) }),
    requiresRecognition: boolean(candidate.requiresRecognition),
    ...(Object.keys(recognition).length
      ? {
          recognition: {
            tex: text(recognition.tex, budget),
            ...(optionalNumber(recognition.confidence) === undefined
              ? {}
              : { confidence: recognition.confidence }),
            ...(Object.keys(diagnostics).length
              ? {
                  diagnostics: {
                    ...(optionalNumber(diagnostics.tokens) === undefined
                      ? {}
                      : { tokens: diagnostics.tokens }),
                    ...(optionalText(diagnostics.backend, budget) === undefined
                      ? {}
                      : { backend: text(diagnostics.backend, budget) }),
                  },
                }
              : {}),
            model: text(recognition.model, budget),
            reviewConfidence: text(recognition.reviewConfidence, budget),
          },
        }
      : {}),
    ...(optionalText(candidate.recognitionFailure, budget) === undefined
      ? {}
      : { recognitionFailure: text(candidate.recognitionFailure, budget) }),
  };
}

function projectBounds(value: unknown) {
  const bounds = record(value);
  return {
    x: number(bounds.x),
    top: number(bounds.top),
    width: number(bounds.width),
    height: number(bounds.height),
  };
}

function projectStructure(
  value: unknown,
  budget: ProjectionBudget,
  depth = 0,
): Record<string, unknown> {
  const node = record(value);
  if (depth >= 64) {
    budget.truncated = true;
    return { truncated: true };
  }
  return {
    role: text(node.role, budget),
    ...(optionalText(node.markedContentId, budget) === undefined
      ? {}
      : { markedContentId: text(node.markedContentId, budget) }),
    ...(optionalNumber(node.colSpan) === undefined
      ? {}
      : { colSpan: node.colSpan }),
    ...(optionalNumber(node.rowSpan) === undefined
      ? {}
      : { rowSpan: node.rowSpan }),
    children: list(node.children, budget).map((child) =>
      projectStructure(child, budget, depth + 1),
    ),
  };
}

function projectOutline(
  value: unknown,
  budget: ProjectionBudget,
  depth = 0,
): Record<string, unknown> {
  const item = record(value);
  if (depth >= 64) {
    budget.truncated = true;
    return { truncated: true };
  }
  return {
    title: text(item.title, budget),
    ...(optionalText(item.destination, budget) === undefined
      ? {}
      : { destination: text(item.destination, budget) }),
    children: list(item.children, budget).map((child) =>
      projectOutline(child, budget, depth + 1),
    ),
  };
}

function projectDocumentModel(value: unknown, budget = createBudget()): object {
  const model = record(value);
  const assets: Record<string, unknown> = {};
  for (const [id, value] of entries(model.assets, budget)) {
    const asset = record(value);
    assets[id] = {
      id: text(asset.id, budget),
      mediaType: text(asset.mediaType, budget),
      size: bytes(asset.data).byteLength,
      sha256: sha256(bytes(asset.data)),
      ...(optionalNumber(asset.width) === undefined
        ? {}
        : { width: asset.width }),
      ...(optionalNumber(asset.height) === undefined
        ? {}
        : { height: asset.height }),
    };
  }
  const equations: Record<string, unknown> = {};
  for (const [id, value] of entries(model.equations, budget))
    equations[id] = projectEquation(value, budget);
  const notes: Record<string, unknown> = {};
  for (const [id, value] of entries(model.notes, budget)) {
    const note = record(value);
    notes[id] = {
      id: text(note.id, budget),
      kind: text(note.kind, budget),
      blocks: projectBlocks(note.blocks, budget),
    };
  }
  return {
    schema: text(model.schema, budget),
    version: number(model.version),
    metadata: projectMetadata(model.metadata, budget),
    blocks: projectBlocks(model.blocks, budget),
    assets,
    equations,
    notes,
    styles: list(model.styles, budget).map((style) =>
      projectStyle(style, budget),
    ),
    warnings: list(model.warnings, budget).map((warning) =>
      projectWarning(warning, budget),
    ),
  };
}

function projectMetadata(value: unknown, budget: ProjectionBudget) {
  const metadata = record(value);
  return {
    ...(metadata.title ? { title: inferred(metadata.title, budget) } : {}),
    ...(metadata.subtitle
      ? { subtitle: inferred(metadata.subtitle, budget) }
      : {}),
    authors: list(metadata.authors, budget).map((author) =>
      inferred(author, budget, projectPerson),
    ),
    ...(metadata.language
      ? { language: inferred(metadata.language, budget) }
      : {}),
    ...(metadata.publisher
      ? { publisher: inferred(metadata.publisher, budget) }
      : {}),
    ...(metadata.description
      ? { description: inferred(metadata.description, budget) }
      : {}),
    subjects: list(metadata.subjects, budget).map((subject) =>
      inferred(subject, budget),
    ),
    ...(metadata.version
      ? { version: inferred(metadata.version, budget) }
      : {}),
    ...(metadata.sourceCreatedAt
      ? { sourceCreatedAt: inferred(metadata.sourceCreatedAt, budget) }
      : {}),
    ...(metadata.sourceModifiedAt
      ? { sourceModifiedAt: inferred(metadata.sourceModifiedAt, budget) }
      : {}),
    ...(metadata.publicationDate
      ? { publicationDate: inferred(metadata.publicationDate, budget) }
      : {}),
    conversionDate: inferred(metadata.conversionDate, budget),
    ...(metadata.identifier
      ? { identifier: inferred(metadata.identifier, budget) }
      : {}),
    ...(metadata.rights ? { rights: inferred(metadata.rights, budget) } : {}),
  };
}

function inferred(
  value: unknown,
  budget: ProjectionBudget,
  projectValue: (value: unknown, budget: ProjectionBudget) => unknown = (
    value,
    budget,
  ) => text(value, budget),
) {
  const inferredValue = record(value);
  return {
    value: projectValue(inferredValue.value, budget),
    provenance: projectProvenance(inferredValue.provenance, budget),
  };
}

function projectPerson(value: unknown, budget: ProjectionBudget) {
  const person = record(value);
  return {
    name: text(person.name, budget),
    ...(optionalText(person.sortAs, budget) === undefined
      ? {}
      : { sortAs: text(person.sortAs, budget) }),
    ...(optionalText(person.role, budget) === undefined
      ? {}
      : { role: text(person.role, budget) }),
    ...(optionalText(person.identifier, budget) === undefined
      ? {}
      : { identifier: text(person.identifier, budget) }),
  };
}

function projectProvenance(value: unknown, budget: ProjectionBudget) {
  const provenance = record(value);
  return {
    source: text(provenance.source, budget),
    ...(optionalText(provenance.location, budget) === undefined
      ? {}
      : { location: text(provenance.location, budget) }),
    method: text(provenance.method, budget),
    confidence: text(provenance.confidence, budget),
    ...(optionalText(provenance.reason, budget) === undefined
      ? {}
      : { reason: text(provenance.reason, budget) }),
  };
}

function projectStyle(value: unknown, budget: ProjectionBudget) {
  const style = record(value);
  const formatting = record(style.formatting);
  return {
    id: text(style.id, budget),
    ...(optionalText(style.name, budget) === undefined
      ? {}
      : { name: text(style.name, budget) }),
    kind: text(style.kind, budget),
    ...(optionalText(style.basedOn, budget) === undefined
      ? {}
      : { basedOn: text(style.basedOn, budget) }),
    formatting: {
      ...(optionalText(formatting.fontFamily, budget) === undefined
        ? {}
        : { fontFamily: text(formatting.fontFamily, budget) }),
      ...pickNumbers(formatting, [
        'fontSizePt',
        'outlineLevel',
        'spacingBeforePt',
        'spacingAfterPt',
        'indentationLeftPt',
        'indentationRightPt',
        'indentationFirstLinePt',
      ]),
      ...pickBooleans(formatting, ['bold', 'italic']),
      ...(optionalText(formatting.numbering, budget) === undefined
        ? {}
        : { numbering: text(formatting.numbering, budget) }),
    },
    usageCount: number(style.usageCount),
    examples: list(style.examples, budget).map((example) =>
      text(example, budget),
    ),
    proposedMapping: text(style.proposedMapping, budget),
    reasons: list(style.reasons, budget).map((reason) => text(reason, budget)),
    provenance: projectProvenance(style.provenance, budget),
  };
}

function projectWarning(value: unknown, budget: ProjectionBudget) {
  const warning = record(value);
  const details: Record<string, string | number | boolean> = {};
  for (const [key, detail] of entries(warning.details, budget)) {
    if (
      typeof detail === 'string' ||
      typeof detail === 'number' ||
      typeof detail === 'boolean'
    )
      details[key] = typeof detail === 'string' ? text(detail, budget) : detail;
  }
  return {
    code: text(warning.code, budget),
    severity: text(warning.severity, budget),
    message: text(warning.message, budget),
    ...(optionalText(warning.location, budget) === undefined
      ? {}
      : { location: text(warning.location, budget) }),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function projectEquation(value: unknown, budget: ProjectionBudget) {
  const equation = record(value);
  const source = record(equation.source);
  const recognition = record(equation.recognition);
  const location = record(equation.location);
  const review = record(equation.review);
  return {
    id: text(equation.id, budget),
    source: {
      format: text(source.format, budget),
      value: text(source.value, budget),
    },
    ...(optionalText(equation.tex, budget) === undefined
      ? {}
      : { tex: text(equation.tex, budget) }),
    ...(optionalText(equation.mathml, budget) === undefined
      ? {}
      : { mathml: text(equation.mathml, budget) }),
    conversionComplete: boolean(equation.conversionComplete),
    ...(optionalText(equation.display, budget) === undefined
      ? {}
      : { display: text(equation.display, budget) }),
    ...(Object.keys(recognition).length
      ? {
          recognition: {
            method: text(recognition.method, budget),
            ...(optionalNumber(recognition.confidence) === undefined
              ? {}
              : { confidence: recognition.confidence }),
            ...(optionalText(recognition.model, budget) === undefined
              ? {}
              : { model: text(recognition.model, budget) }),
          },
        }
      : {}),
    ...(Object.keys(location).length
      ? {
          location: {
            kind: text(location.kind, budget),
            page: number(location.page),
            x: number(location.x),
            top: number(location.top),
            width: number(location.width),
            height: number(location.height),
            ...(Array.isArray(location.spanIds)
              ? {
                  spanIds: list(location.spanIds, budget).map((id) =>
                    text(id, budget),
                  ),
                }
              : {}),
            ...(optionalText(location.previewAssetId, budget) === undefined
              ? {}
              : { previewAssetId: text(location.previewAssetId, budget) }),
          },
        }
      : {}),
    ...(Object.keys(review).length
      ? {
          review: {
            status: text(review.status, budget),
            ...(optionalText(review.originalTex, budget) === undefined
              ? {}
              : { originalTex: text(review.originalTex, budget) }),
          },
        }
      : {}),
  };
}

function projectBlocks(
  values: unknown,
  budget: ProjectionBudget,
  depth = 0,
): unknown[] {
  if (depth >= 64) {
    budget.truncated = true;
    return [];
  }
  return list(values, budget).map((value) => {
    const block = record(value);
    switch (block.type) {
      case 'paragraph':
        return {
          type: block.type,
          children: projectInlines(block.children, budget, depth + 1),
          ...(optionalText(block.styleId, budget) === undefined
            ? {}
            : { styleId: text(block.styleId, budget) }),
        };
      case 'heading':
        return {
          type: block.type,
          level: number(block.level),
          children: projectInlines(block.children, budget, depth + 1),
          ...(optionalText(block.numbering, budget) === undefined
            ? {}
            : { numbering: text(block.numbering, budget) }),
          ...(optionalText(block.styleId, budget) === undefined
            ? {}
            : { styleId: text(block.styleId, budget) }),
          ...(optionalText(block.id, budget) === undefined
            ? {}
            : { id: text(block.id, budget) }),
        };
      case 'list':
        return {
          type: block.type,
          ordered: boolean(block.ordered),
          ...(optionalNumber(block.start) === undefined
            ? {}
            : { start: block.start }),
          items: list(block.items, budget).map((value) => ({
            blocks: projectBlocks(record(value).blocks, budget, depth + 1),
          })),
        };
      case 'table':
        return {
          type: block.type,
          rows: list(block.rows, budget).map((value) => ({
            cells: list(record(value).cells, budget).map((value) => {
              const cell = record(value);
              return {
                blocks: projectBlocks(cell.blocks, budget, depth + 1),
                ...(optionalBoolean(cell.header) === undefined
                  ? {}
                  : { header: cell.header }),
                ...(optionalNumber(cell.colSpan) === undefined
                  ? {}
                  : { colSpan: cell.colSpan }),
                ...(optionalNumber(cell.rowSpan) === undefined
                  ? {}
                  : { rowSpan: cell.rowSpan }),
              };
            }),
          })),
          ...(Array.isArray(block.caption)
            ? { caption: projectInlines(block.caption, budget, depth + 1) }
            : {}),
        };
      case 'blockquote':
        return {
          type: block.type,
          blocks: projectBlocks(block.blocks, budget, depth + 1),
        };
      case 'codeBlock':
        return {
          type: block.type,
          text: text(block.text, budget),
          ...(optionalText(block.language, budget) === undefined
            ? {}
            : { language: text(block.language, budget) }),
        };
      case 'equationBlock':
        return { type: block.type, equationId: text(block.equationId, budget) };
      case 'imageBlock':
        return {
          type: block.type,
          assetId: text(block.assetId, budget),
          ...(optionalText(block.alt, budget) === undefined
            ? {}
            : { alt: text(block.alt, budget) }),
          ...(Array.isArray(block.caption)
            ? { caption: projectInlines(block.caption, budget, depth + 1) }
            : {}),
          ...(optionalNumber(block.width) === undefined
            ? {}
            : { width: block.width }),
          ...(optionalText(block.alignment, budget) === undefined
            ? {}
            : { alignment: text(block.alignment, budget) }),
        };
      case 'thematicBreak':
      case 'pageBreak':
        return { type: block.type };
      default:
        budget.truncated = true;
        return { type: 'unsupported' };
    }
  });
}

function projectInlines(
  values: unknown,
  budget: ProjectionBudget,
  depth = 0,
): unknown[] {
  if (depth >= 64) {
    budget.truncated = true;
    return [];
  }
  return list(values, budget).map((value) => {
    const node = record(value);
    switch (node.type) {
      case 'text':
        return {
          type: node.type,
          text: text(node.text, budget),
          ...(Array.isArray(node.marks)
            ? {
                marks: list(node.marks, budget).map((value) => {
                  const mark = record(value);
                  return mark.type === 'style'
                    ? {
                        type: text(mark.type, budget),
                        styleId: text(mark.styleId, budget),
                      }
                    : { type: text(mark.type, budget) };
                }),
              }
            : {}),
        };
      case 'link':
        return {
          type: node.type,
          href: text(node.href, budget),
          children: projectInlines(node.children, budget, depth + 1),
          ...(optionalText(node.title, budget) === undefined
            ? {}
            : { title: text(node.title, budget) }),
        };
      case 'image':
        return {
          type: node.type,
          assetId: text(node.assetId, budget),
          ...(optionalText(node.alt, budget) === undefined
            ? {}
            : { alt: text(node.alt, budget) }),
          ...(optionalText(node.title, budget) === undefined
            ? {}
            : { title: text(node.title, budget) }),
          ...(optionalText(node.presentation, budget) === undefined
            ? {}
            : { presentation: text(node.presentation, budget) }),
          ...(optionalNumber(node.width) === undefined
            ? {}
            : { width: node.width }),
        };
      case 'equation':
        return { type: node.type, equationId: text(node.equationId, budget) };
      case 'noteReference':
        return { type: node.type, noteId: text(node.noteId, budget) };
      case 'lineBreak':
      case 'softBreak':
        return { type: node.type };
      default:
        budget.truncated = true;
        return { type: 'unsupported' };
    }
  });
}

function pickNumbers(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of keys)
    if (optionalNumber(source[key]) !== undefined)
      result[key] = number(source[key]);
  return result;
}

function pickBooleans(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const key of keys)
    if (optionalBoolean(source[key]) !== undefined)
      result[key] = boolean(source[key]);
  return result;
}

function entries(
  value: unknown,
  budget: ProjectionBudget,
): Array<readonly [string, unknown]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const keys = Object.keys(value).sort();
  const result: Array<readonly [string, unknown]> = [];
  for (const key of list(keys, budget))
    if (typeof key === 'string')
      result.push([key, (value as Record<string, unknown>)[key]]);
  return result;
}

function list(value: unknown, budget: ProjectionBudget): unknown[] {
  if (!Array.isArray(value)) return [];
  const count = Math.min(value.length, budget.itemsLeft);
  if (count < value.length) budget.truncated = true;
  budget.itemsLeft -= count;
  return value.slice(0, count);
}

function createBudget(): ProjectionBudget {
  return {
    itemsLeft: JSON_BUDGETS[0]!.items,
    maxText: JSON_BUDGETS[0]!.text,
    truncated: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, budget: ProjectionBudget): string {
  if (typeof value !== 'string') return '';
  if (value.length <= budget.maxText) return value;
  budget.truncated = true;
  return `${value.slice(0, budget.maxText)}…`;
}

function optionalText(
  value: unknown,
  budget: ProjectionBudget,
): string | undefined {
  return typeof value === 'string' ? text(value, budget) : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function bytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function dataReference(data: Uint8Array) {
  return { size: data.byteLength, sha256: sha256(data) };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < path.lastIndexOf('/') || dot < 0
    ? ''
    : path.slice(dot).toLowerCase();
}

function isSafeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..') &&
    !/[\p{Cc}]/u.test(path)
  );
}
