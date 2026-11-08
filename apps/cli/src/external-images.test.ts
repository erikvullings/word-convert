import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import { beforeEach, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import {
  downloadExternalImage,
  externalImageUrl,
  isPublicImageAddress,
} from './external-images.ts';
import { runCli } from './cli.ts';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

function reply(
  body: Buffer = png,
  headers: Record<string, string> = { 'content-type': 'image/png' },
  statusCode = 200,
) {
  return Object.assign(Readable.from([body]), { headers, statusCode });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lookup).mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
  ]);
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    const callback = args[1];
    const req = Object.assign(new EventEmitter(), {
      end() {
        if (typeof callback === 'function')
          queueMicrotask(() => callback(reply()));
      },
    });
    return req as ReturnType<typeof request>;
  });
});

it.each([
  '127.0.0.1',
  '10.0.0.1',
  '172.16.1.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.1.1',
  '0.0.0.0',
  '192.0.2.1',
  '198.18.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '::1',
  '::',
  '::ffff:127.0.0.1',
  'fc00::1',
  'fe80::1',
  '2001:db8::1',
  '2002:a00:1::1',
  'invalid',
])('blocks non-public address %s', (address) => {
  expect(isPublicImageAddress(address)).toBe(false);
});

it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])(
  'accepts public address %s',
  (address) => {
    expect(isPublicImageAddress(address)).toBe(true);
  },
);

it.each([
  'http://example.com/a.png',
  'file:///a.png',
  'https://user:secret@example.com/a.png',
  'https://example.com:8443/a.png',
])('rejects unsafe image URL %s before making a request', async (source) => {
  await expect(downloadExternalImage(source)).rejects.toThrow(
    'credential-free HTTPS',
  );
  expect(request).not.toHaveBeenCalled();
});

it('accepts protocol-relative HTTPS images', () => {
  expect(externalImageUrl('//example.com/a.png').href).toBe(
    'https://example.com/a.png',
  );
});

it('pins validated DNS and keeps the source TLS/Host identity without cookies or referrer', async () => {
  const image = await downloadExternalImage('https://example.com/a.png');
  expect(image.data).toEqual(new Uint8Array(png));
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      hostname: '93.184.216.34',
      servername: 'example.com',
      port: 443,
      agent: false,
      headers: {
        Host: 'example.com',
        Accept: expect.any(String),
        'Accept-Encoding': 'identity',
      },
    }),
    expect.any(Function),
  );
});

it('rejects mixed public/private DNS results without contacting either', async () => {
  vi.mocked(lookup).mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(
    downloadExternalImage('https://example.com/a.png'),
  ).rejects.toThrow('non-public');
  expect(request).not.toHaveBeenCalled();
});

it('revalidates redirect addresses and never connects to private destinations', async () => {
  vi.mocked(request).mockImplementationOnce((...args: unknown[]) => {
    const callback = args[1];
    return Object.assign(new EventEmitter(), {
      end() {
        if (typeof callback === 'function')
          queueMicrotask(() =>
            callback(
              reply(
                Buffer.alloc(0),
                { location: 'https://localhost/a.png' },
                302,
              ),
            ),
          );
      },
    }) as ReturnType<typeof request>;
  });
  vi.mocked(lookup)
    .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  await expect(
    downloadExternalImage('https://example.com/a.png'),
  ).rejects.toThrow('non-public');
  expect(request).toHaveBeenCalledTimes(1);
});

it('allows public redirects but limits their count', async () => {
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    const callback = args[1];
    return Object.assign(new EventEmitter(), {
      end() {
        if (typeof callback === 'function')
          queueMicrotask(() =>
            callback(
              reply(Buffer.alloc(0), { location: '/redirect.png' }, 302),
            ),
          );
      },
    }) as ReturnType<typeof request>;
  });
  await expect(
    downloadExternalImage('https://example.com/a.png'),
  ).rejects.toThrow('three-redirect');
  expect(request).toHaveBeenCalledTimes(4);
  expect(lookup).toHaveBeenCalledTimes(4);
});

it('bounds DNS resolution with the per-image deadline', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => undefined));
    const result = expect(
      downloadExternalImage('https://example.com/a.png'),
    ).rejects.toThrow('15 seconds');
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    body: png,
    headers: { 'content-type': 'image/svg+xml' },
    status: 200,
    error: 'passive raster',
  },
  {
    body: png,
    headers: { 'content-type': 'image/png', 'content-length': '10485761' },
    status: 200,
    error: '10 MiB',
  },
  {
    body: Buffer.alloc(10 * 1024 * 1024 + 1),
    headers: { 'content-type': 'image/png' },
    status: 200,
    error: '10 MiB',
  },
  {
    body: png,
    headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' },
    status: 200,
    error: 'Compressed',
  },
  {
    body: png,
    headers: { 'content-type': 'image/png' },
    status: 404,
    error: 'HTTP 404',
  },
])(
  'rejects invalid remote responses: $error',
  async ({ body, headers, status, error }) => {
    vi.mocked(request).mockImplementationOnce((...args: unknown[]) => {
      const callback = args[1];
      return Object.assign(new EventEmitter(), {
        end() {
          if (typeof callback === 'function')
            queueMicrotask(() => callback(reply(body, headers, status)));
        },
      }) as ReturnType<typeof request>;
    });
    await expect(
      downloadExternalImage('https://example.com/a.png'),
    ).rejects.toThrow(error);
  },
);

it.each(['md', 'html'])(
  'embeds external %s images only when opted in',
  async (extension) => {
    const directory = await mkdtemp(join(tmpdir(), 'wordconvert-external-'));
    try {
      const input = join(directory, `book.${extension}`);
      const output = join(directory, 'book.epub');
      await writeFile(
        input,
        extension === 'md'
          ? '# Book\n\n![Diagram](https://example.com/a.png)'
          : '<h1>Book</h1><img src="https://example.com/a.png" alt="Diagram">',
      );

      const warnings: string[] = [];
      const io = {
        stdout: async () => undefined,
        stderr: (value: string) => warnings.push(value),
      };
      expect(await runCli([input], io)).toBe(0);
      expect(request).not.toHaveBeenCalled();
      expect(
        await runCli([input, '--force', '--include-external-images'], io),
      ).toBe(0);
      const files = unzipSync(await readFile(output));
      expect(
        Object.keys(files).some((path) => /images\/.*\.png$/.test(path)),
      ).toBe(true);
      expect(warnings.join('')).toContain('observe your IP');
      expect(
        await runCli([input, '--offline', '--include-external-images'], io),
      ).toBe(2);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('skips a remote response with a forged image content type and retains alternative text', async () => {
  vi.mocked(request).mockImplementationOnce((...args: unknown[]) => {
    const callback = args[1];
    return Object.assign(new EventEmitter(), {
      end() {
        if (typeof callback === 'function')
          queueMicrotask(() =>
            callback(reply(Buffer.from('<script>active</script>'))),
          );
      },
    }) as ReturnType<typeof request>;
  });
  const directory = await mkdtemp(
    join(tmpdir(), 'wordconvert-external-signature-'),
  );
  try {
    const input = join(directory, 'book.md');
    await writeFile(input, '# Book\n\n![Image](https://example.com/a.png)');
    const chunks: Uint8Array[] = [];
    const errors: string[] = [];
    expect(
      await runCli([input, '--include-external-images', '-o', '-'], {
        stdout: async (data) => {
          if (data instanceof Uint8Array) chunks.push(data);
        },
        stderr: (message) => errors.push(message),
      }),
    ).toBe(0);
    const files = unzipSync(chunks[0]!);
    expect(Object.keys(files).some((path) => path.includes('/images/'))).toBe(
      false,
    );
    expect(
      Object.values(files)
        .map((data) => new TextDecoder().decode(data))
        .join('\n'),
    ).toContain('Image');
    expect(errors.join('')).toContain('cli-external-image-omitted');
    expect(errors.join('')).toContain('bytes do not match');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['md', 'html'])(
  'continues after SVG, 403, and 204 images and still includes a later valid image in %s',
  async (extension) => {
    const responses = [
      reply(Buffer.from('<svg/>'), { 'content-type': 'image/svg+xml' }),
      reply(Buffer.alloc(0), {}, 403),
      reply(Buffer.alloc(0), {}, 204),
      reply(),
    ];
    vi.mocked(request).mockImplementation((...args: unknown[]) => {
      const callback = args[1];
      return Object.assign(new EventEmitter(), {
        end() {
          if (typeof callback === 'function')
            queueMicrotask(() => callback(responses.shift()!));
        },
      }) as ReturnType<typeof request>;
    });
    const directory = await mkdtemp(
      join(tmpdir(), 'wordconvert-external-skip-'),
    );
    try {
      const input = join(directory, `book.${extension}`);
      await writeFile(
        input,
        extension === 'md'
          ? '# Report\n\nArticle text before.\n\n![Placeholder](https://example.com/a.svg)\n\n![Logo](https://example.com/b.png)\n\n![Reauth](https://example.com/c.png)\n\n![Diagram](https://example.com/d.png)\n\nArticle text after.'
          : '<h1>Report</h1><p>Article text before.</p><img src="https://example.com/a.svg" alt="Placeholder"><img src="https://example.com/b.png" alt="Logo"><img src="https://example.com/c.png" alt="Reauth"><img src="https://example.com/d.png" alt="Diagram"><p>Article text after.</p>',
      );
      const errors: string[] = [];
      expect(
        await runCli([input, '--include-external-images'], {
          stdout: async () => undefined,
          stderr: (message) => errors.push(message),
        }),
      ).toBe(0);
      const files = unzipSync(await readFile(join(directory, 'book.epub')));
      expect(
        Object.keys(files).filter((path) => /images\/.*\.png$/.test(path)),
      ).toHaveLength(1);
      const content = Object.entries(files)
        .filter(([path]) => path.endsWith('.xhtml'))
        .map(([, data]) => new TextDecoder().decode(data))
        .join('\n');
      expect(content).toContain('Article text before.');
      expect(content).toContain('Article text after.');
      expect(content).toContain('Placeholder');
      expect(content).toContain('Logo');
      expect(content).toContain('Reauth');
      expect(
        errors.filter((message) =>
          message.includes('cli-external-image-omitted'),
        ),
      ).toHaveLength(3);
      expect(errors.join('')).toContain('HTTP 403');
      expect(errors.join('')).toContain('HTTP 204');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
