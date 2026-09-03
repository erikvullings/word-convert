export const MAX_REMOTE_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_COUNT = 100;
const MAX_REMOTE_STYLESHEET_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_STYLESHEET_COUNT = 20;
const REMOTE_IMAGE_CONCURRENCY = 6;
const REMOTE_IMAGE_TIMEOUT_MS = 15_000;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RemoteTextFormat = 'html' | 'markdown' | 'text';

export interface RemoteImageResource {
  url: string;
  mediaType:
    'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  data: Uint8Array;
}

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

export async function fetchRemoteHtmlImages(
  html: string,
  sourceUrl: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<RemoteImageResource[]> {
  const source = new URL(sourceUrl);
  const document = new DOMParser().parseFromString(html, 'text/html');
  const root = remoteHtmlContentRoot(document);
  const urls = [
    ...new Set(
      [...root.querySelectorAll<HTMLImageElement>('img[src]')]
        .map((image) =>
          safeSameOriginUrl(image.getAttribute('src') ?? '', source),
        )
        .filter((url): url is string => url !== undefined),
    ),
  ].slice(0, MAX_REMOTE_IMAGE_COUNT);
  const timeout = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const fetched = Array.from<RemoteImageResource | undefined>({
    length: urls.length,
  });
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < urls.length) {
      const index = nextIndex++;
      const url = urls[index];
      if (!url) continue;
      fetched[index] = await fetchRemoteImage(
        url,
        source,
        fetcher,
        requestSignal,
        signal,
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(REMOTE_IMAGE_CONCURRENCY, urls.length) },
      () => worker(),
    ),
  );
  const resources: RemoteImageResource[] = [];
  let totalBytes = 0;
  for (const resource of fetched) {
    if (!resource) continue;
    if (totalBytes + resource.data.byteLength > MAX_REMOTE_DOCUMENT_BYTES)
      break;
    totalBytes += resource.data.byteLength;
    resources.push(resource);
  }
  return resources;
}

export async function fetchRemoteHtmlStylesheets(
  html: string,
  sourceUrl: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const source = new URL(sourceUrl);
  if (isArxivHost(source)) return [];
  const document = new DOMParser().parseFromString(html, 'text/html');
  const urls = [
    ...new Set(
      [
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel~="stylesheet"][href]',
        ),
      ]
        .map((link) =>
          safeSameOriginUrl(link.getAttribute('href') ?? '', source),
        )
        .filter((url): url is string => url !== undefined),
    ),
  ].slice(0, MAX_REMOTE_STYLESHEET_COUNT);
  const timeout = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const stylesheets = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetcher(url, {
          credentials: 'omit',
          mode: 'cors',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal: requestSignal,
        });
        if (!response.ok || !safeSameOriginUrl(response.url || url, source))
          return undefined;
        const mediaType = response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        if (mediaType && mediaType !== 'text/css') return undefined;
        return new TextDecoder().decode(
          await readBoundedBody(
            response,
            requestSignal,
            MAX_REMOTE_STYLESHEET_BYTES,
          ),
        );
      } catch (cause) {
        if (signal?.aborted) throw cause;
        return undefined;
      }
    }),
  );
  return stylesheets.filter(
    (stylesheet): stylesheet is string => stylesheet !== undefined,
  );
}

function remoteHtmlContentRoot(document: Document): ParentNode {
  return (
    document.querySelector('article.ltx_document') ??
    document.querySelector('main, article') ??
    document.body
  );
}

function isArxivHost(url: URL): boolean {
  return url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org';
}

async function fetchRemoteImage(
  url: string,
  source: URL,
  fetcher: Fetcher,
  requestSignal: AbortSignal,
  userSignal?: AbortSignal,
): Promise<RemoteImageResource | undefined> {
  try {
    const response = await fetcher(url, {
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: requestSignal,
    });
    if (!response.ok) return undefined;
    if (!safeSameOriginUrl(response.url || url, source)) return undefined;
    const mediaType = imageMediaType(response.headers.get('content-type'));
    if (!mediaType) return undefined;
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_IMAGE_BYTES)
      return undefined;
    const data = await readBoundedBody(
      response,
      requestSignal,
      MAX_REMOTE_IMAGE_BYTES,
    );
    return { url, mediaType, data };
  } catch (cause) {
    if (userSignal?.aborted) throw cause;
    return undefined;
  }
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
  maxBytes = MAX_REMOTE_DOCUMENT_BYTES,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new TypeError('The remote resource exceeds its size limit.');
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
      if (length > maxBytes)
        throw new TypeError('The remote resource exceeds its size limit.');
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

function safeSameOriginUrl(value: string, source: URL): string | undefined {
  try {
    const url = new URL(value, source);
    url.hash = '';
    return url.protocol === 'https:' && url.origin === source.origin
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function imageMediaType(
  value: string | null,
): RemoteImageResource['mediaType'] | undefined {
  const mediaType = value?.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'image/avif' ||
    mediaType === 'image/gif' ||
    mediaType === 'image/jpeg' ||
    mediaType === 'image/png' ||
    mediaType === 'image/webp'
    ? mediaType
    : undefined;
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
