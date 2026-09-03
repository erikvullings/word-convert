export type TexTellerAsset = 'encoder.onnx' | 'decoder.onnx' | 'tokenizer.json';

export function textTellerAssetPath(file: TexTellerAsset): string {
  return `texteller/${file}`;
}
