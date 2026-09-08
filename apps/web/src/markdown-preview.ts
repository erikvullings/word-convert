import { render } from 'slimdown-js';
import { katexExtension } from 'slimdown-katex';

const extensions = [
  katexExtension({
    output: 'mathml',
    strict: 'error',
    throwOnError: false,
    trust: false,
  }),
];

export function renderMarkdownPreview(markdown: string): string {
  return render(resolveMarkdownEscapes(markdown), {
    extensions,
    pageBreaks: true,
  });
}

function resolveMarkdownEscapes(markdown: string): string {
  const segments = markdown.split(/(\r?\n)/);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index] ?? '';
    const content = line.replace(/^(?: {0,3}> ?)+/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(content)?.[1];
    if (fence) {
      const closing = new RegExp(
        `^ {0,3}\\${fence.marker}{${fence.length},}[ \\t]*$`,
      );
      if (closing.test(content)) fence = undefined;
      continue;
    }
    if (marker) {
      fence = {
        marker: marker[0] as '`' | '~',
        length: marker.length,
      };
      continue;
    }
    segments[index] = resolveInlineMarkdownEscapes(line);
  }
  return segments.join('');
}

function resolveInlineMarkdownEscapes(value: string): string {
  let result = '';
  let codeFenceLength = 0;
  let mathFenceLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (character === '`' && mathFenceLength === 0) {
      const length = characterRun(value, index, '`');
      if (codeFenceLength === 0) codeFenceLength = length;
      else if (length === codeFenceLength) codeFenceLength = 0;
      result += value.slice(index, index + length);
      index += length - 1;
      continue;
    }
    if (character === '$' && codeFenceLength === 0) {
      const length = Math.min(characterRun(value, index, '$'), 2);
      if (mathFenceLength === 0) mathFenceLength = length;
      else if (length === mathFenceLength) mathFenceLength = 0;
      result += value.slice(index, index + length);
      index += length - 1;
      continue;
    }
    const escaped = value[index + 1];
    if (
      character === '\\' &&
      codeFenceLength === 0 &&
      mathFenceLength === 0 &&
      escaped !== undefined &&
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(escaped)
    ) {
      result += `&#${escaped.codePointAt(0)};`;
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

function characterRun(value: string, start: number, character: string): number {
  let length = 0;
  while (value[start + length] === character) length += 1;
  return length;
}
