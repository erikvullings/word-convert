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

export interface MailEnvironment {
  canShare?(data: ShareData): boolean;
  share?(data: ShareData): Promise<void>;
  openMailto(url: string): void;
}

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
    if (cause instanceof DOMException && cause.name === 'AbortError')
      return false;
    throw cause;
  }
}

export async function mailEpub(
  output: DownloadOutput,
  title: string,
  environment: MailEnvironment,
): Promise<void> {
  const file = new File([output.data], output.filename, {
    type: output.mediaType,
  });
  const shareData: ShareData = { title, files: [file] };
  let supportsFileSharing = false;
  try {
    supportsFileSharing = environment.canShare?.(shareData) === true;
  } catch {
    supportsFileSharing = false;
  }
  if (environment.share && supportsFileSharing) {
    await environment.share(shareData);
    return;
  }
  environment.openMailto(`mailto:?subject=${encodeURIComponent(title)}`);
}
