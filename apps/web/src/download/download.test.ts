import { describe, expect, it, vi } from 'vitest';

import { deliverDownload } from './index.ts';

describe('download lifecycle', () => {
  it('revokes the object URL and releases the output after starting the download', () => {
    const click = vi.fn();
    const revoke = vi.fn();
    const release = vi.fn();
    deliverDownload(
      {
        filename: 'report.html',
        mediaType: 'text/html',
        data: new ArrayBuffer(4),
      },
      {
        createObjectURL: () => 'blob:local-only',
        revokeObjectURL: revoke,
        createAnchor: () => ({ href: '', download: '', click }),
      },
      release,
    );
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:local-only');
    expect(release).toHaveBeenCalledOnce();
  });
});
