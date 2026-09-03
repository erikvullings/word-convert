declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*?raw' {
  const source: string;
  export default source;
}

declare const __WORDCONVERT_BASE_PATH__: string;

declare module 'virtual:wordconvert-formula-recognizer' {
  import type { PdfFormulaRecognizer } from '@wordconvert/pdf-reader';

  export function createConfiguredFormulaRecognizer(): PdfFormulaRecognizer;
}
