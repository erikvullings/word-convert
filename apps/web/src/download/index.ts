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
