export const MAX_REMOTE_PDF_BYTES = 50 * 1024 * 1024;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function normalizePdfUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError('Enter a valid PDF URL.');
  }
  if (url.protocol !== 'https:')
    throw new TypeError('Remote PDFs must use HTTPS.');
  if (url.username || url.password)
    throw new TypeError('Remote PDF URLs cannot contain credentials.');
  if (
    (url.hostname === 'arxiv.org' || url.hostname === 'www.arxiv.org') &&
    url.pathname.startsWith('/abs/')
  ) {
    const identifier = url.pathname.slice('/abs/'.length).replace(/\/$/, '');
    if (!identifier)
      throw new TypeError('The arXiv URL has no paper identifier.');
    return `https://arxiv.org/pdf/${identifier}`;
  }
  url.hash = '';
  return url.href;
}

export async function fetchRemotePdf(
  input: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<File> {
  const url = normalizePdfUrl(input);
  let response: Response;
  try {
    response = await fetcher(url, {
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new TypeError(
      'This website does not allow browser access to the PDF, or the network request failed.',
      { cause },
    );
  }
  if (!response.ok)
    throw new TypeError(`The PDF request failed with HTTP ${response.status}.`);
  if (response.url && new URL(response.url).protocol !== 'https:')
    throw new TypeError('The PDF request redirected away from HTTPS.');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_PDF_BYTES)
    throw new TypeError('The remote PDF exceeds the 50 MiB size limit.');
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (
    mediaType &&
    mediaType !== 'application/pdf' &&
    mediaType !== 'application/octet-stream'
  )
    throw new TypeError('The remote address did not return a PDF document.');

  const bytes = await readBoundedBody(response, signal);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new TypeError(
      'The downloaded file does not have a valid PDF signature.',
    );
  const fileBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  fileBytes.set(bytes);
  return new File([fileBytes], responseFilename(response, url), {
    type: 'application/pdf',
  });
}

async function readBoundedBody(
  response: Response,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_PDF_BYTES)
      throw new TypeError('The remote PDF exceeds the 50 MiB size limit.');
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
      if (length > MAX_REMOTE_PDF_BYTES)
        throw new TypeError('The remote PDF exceeds the 50 MiB size limit.');
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

function responseFilename(response: Response, url: string): string {
  const disposition = response.headers.get('content-disposition');
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  const pathName = decodeURIComponent(
    new URL(url).pathname.split('/').at(-1) ?? '',
  );
  const candidate = (match?.[1] ?? pathName ?? 'document').trim();
  const safe = candidate.replaceAll(/[\\/:*?"<>|]/g, '-');
  return safe.toLowerCase().endsWith('.pdf')
    ? safe
    : `${safe || 'document'}.pdf`;
}
