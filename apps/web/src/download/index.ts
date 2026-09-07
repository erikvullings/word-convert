import type { DownloadOutput } from '../state.ts';

export interface DownloadAnchor {
  href: string;
  download: string;
  click(): void;
}

export interface DownloadEnvironment {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): DownloadAnchor;
  showSaveFilePicker?(options: SaveFilePickerOptions): Promise<SaveFileHandle>;
}

export interface EmailEnvironment {
  openMailto(url: string): void;
}

export interface ShareEnvironment {
  canShare?(data: ShareData): boolean;
  share?(data: ShareData): Promise<void>;
}

export interface ShareEpubOptions {
  blob: Blob;
  filename: string;
  title?: string;
  text?: string;
}

export interface EmailEpubOptions {
  title: string;
  filename: string;
  recipient?: string;
}

export type ShareEpubResult =
  | { status: 'shared' }
  | { status: 'cancelled' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: unknown };

interface SaveFilePickerOptions {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}

interface SaveFileHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    cause.name === 'AbortError'
  );
}

export function createEpubFile(blob: Blob, filename: string): File {
  return new File(
    [blob],
    filename.toLowerCase().endsWith('.epub') ? filename : `${filename}.epub`,
    { type: 'application/epub+zip' },
  );
}

export function canShareEpub(
  file: File,
  environment: ShareEnvironment,
): boolean {
  if (!environment.share || !environment.canShare) return false;
  try {
    return environment.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareEpub(
  options: ShareEpubOptions,
  environment: ShareEnvironment,
): Promise<ShareEpubResult> {
  const file = createEpubFile(options.blob, options.filename);
  if (!canShareEpub(file, environment)) return { status: 'unsupported' };

  try {
    await environment.share?.({
      ...(options.title ? { title: options.title } : {}),
      ...(options.text ? { text: options.text } : {}),
      files: [file],
    });
    return { status: 'shared' };
  } catch (error) {
    return isAbortError(error)
      ? { status: 'cancelled' }
      : { status: 'failed', error };
  }
}

export function openEpubEmail(
  options: EmailEpubOptions,
  environment: EmailEnvironment,
): void {
  const subject = encodeURIComponent(`EPUB: ${options.title}`);
  const body = encodeURIComponent(
    [
      `I've created an EPUB version of "${options.title}".`,
      '',
      `Please attach the downloaded file "${options.filename}" to this message.`,
    ].join('\n'),
  );
  const recipient = options.recipient
    ? encodeURIComponent(options.recipient)
    : '';
  environment.openMailto(`mailto:${recipient}?subject=${subject}&body=${body}`);
}

export function deliverDownload(
  output: DownloadOutput,
  environment: DownloadEnvironment,
  release: () => void,
): void {
  const url = environment.createObjectURL(
    new Blob([output.data], { type: output.mediaType }),
  );
  try {
    const anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = output.filename;
    anchor.click();
  } finally {
    environment.revokeObjectURL(url);
    release();
  }
}

export async function saveDownload(
  output: DownloadOutput,
  environment: DownloadEnvironment,
  release: () => void,
): Promise<boolean> {
  if (!environment.showSaveFilePicker) {
    deliverDownload(output, environment, release);
    return true;
  }
  const extension = /\.[^.]+$/.exec(output.filename)?.[0] ?? '';
  try {
    const handle = await environment.showSaveFilePicker({
      suggestedName: output.filename,
      types: [
        {
          description: `${extension.slice(1).toUpperCase() || 'Document'} file`,
          accept: { [output.mediaType]: extension ? [extension] : [] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([output.data], { type: output.mediaType }));
    await writable.close();
    release();
    return true;
  } catch (cause) {
    if (isAbortError(cause)) return false;
    deliverDownload(output, environment, release);
    return true;
  }
}
