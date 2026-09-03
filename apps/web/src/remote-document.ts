export const MAX_REMOTE_DOCUMENT_BYTES = 50 * 1024 * 1024;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RemoteTextFormat = 'html' | 'markdown' | 'text';

export type RemoteDocument =
  | {
      format: RemoteTextFormat;
      filename: string;
      sourceUrl: string;
      content: string;
    }
  | {
      format: 'pdf';
      filename: string;
      sourceUrl: string;
      file: File;
    };

export function normalizeRemoteDocumentUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError('Enter a valid document URL.');
  }
  if (url.protocol !== 'https:')
    throw new TypeError('Remote documents must use HTTPS.');
  if (url.username || url.password)
    throw new TypeError('Remote document URLs cannot contain credentials.');

  if (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') {
    const match = /^\/(?:abs|html|pdf)\/([^/]+?)(?:\.pdf)?\/?$/.exec(
      url.pathname,
    );
    if (match?.[1]) return `https://arxiv.org/html/${match[1]}`;
  }

  url.hash = '';
  return url.href;
}

export async function fetchRemoteDocument(
  input: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<RemoteDocument> {
  const requestedUrl = normalizeRemoteDocumentUrl(input);
  let response: Response;
  try {
    response = await fetcher(requestedUrl, {
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new TypeError(
      'This website does not allow browser access to the document, or the network request failed.',
      { cause },
    );
  }
  if (!response.ok)
    throw new TypeError(
      `The document request failed with HTTP ${response.status}.`,
    );
  const sourceUrl = response.url || requestedUrl;
  if (new URL(sourceUrl).protocol !== 'https:')
    throw new TypeError('The document request redirected away from HTTPS.');

  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_DOCUMENT_BYTES)
    throw new TypeError('The remote document exceeds the 50 MiB size limit.');

  const bytes = await readBoundedBody(response, signal);
  const mediaType = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  const format = detectFormat(mediaType, sourceUrl, bytes);
  const filename = responseFilename(response, sourceUrl, format);
  if (format === 'pdf') {
    const fileBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    fileBytes.set(bytes);
    return {
      format,
      filename,
      sourceUrl,
      file: new File([fileBytes], filename, { type: 'application/pdf' }),
    };
  }
  return {
    format,
    filename,
    sourceUrl,
    content: new TextDecoder().decode(bytes),
  };
}

function detectFormat(
  mediaType: string | undefined,
  url: string,
  bytes: Uint8Array,
): RemoteTextFormat | 'pdf' {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') return 'pdf';
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml')
    return 'html';
  if (
    mediaType === 'text/markdown' ||
    mediaType === 'text/x-markdown' ||
    /\.(?:md|markdown)$/i.test(new URL(url).pathname)
  )
    return 'markdown';
  if (mediaType === 'text/plain' || mediaType === undefined) return 'text';
  throw new TypeError(
    'The remote address did not return an HTML, Markdown, text, or PDF document.',
  );
}

async function readBoundedBody(
  response: Response,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_DOCUMENT_BYTES)
      throw new TypeError('The remote document exceeds the 50 MiB size limit.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REMOTE_DOCUMENT_BYTES)
        throw new TypeError(
          'The remote document exceeds the 50 MiB size limit.',
        );
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseFilename(
  response: Response,
  url: string,
  format: RemoteTextFormat | 'pdf',
): string {
  const disposition = response.headers.get('content-disposition');
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  const pathName = decodeURIComponent(
    new URL(url).pathname.split('/').at(-1) ?? '',
  );
  const candidate = (match?.[1] ?? pathName ?? 'document').trim();
  const safe = candidate.replaceAll(/[\\/:*?"<>|]/g, '-');
  const extension =
    format === 'html'
      ? '.html'
      : format === 'markdown'
        ? '.md'
        : format === 'text'
          ? '.txt'
          : '.pdf';
  return safe.toLowerCase().endsWith(extension)
    ? safe
    : `${safe || 'document'}${extension}`;
}
