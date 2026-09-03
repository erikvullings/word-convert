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
  return render(markdown, { extensions });
}
