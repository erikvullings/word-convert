# RapidLatexOCR ONNX assets

These files are pinned to revision
`0d0a23977b50433b07cdf95513ed7b7e45d3a761` of the
`inYourOwnBrowser/rapid-latex-ocr-onnx` mirror. The mirror describes them as
unmodified ONNX exports from MIT-licensed RapidAI/RapidLaTeXOCR, derived from
MIT-licensed `lukas-blecher/LaTeX-OCR` (pix2tex). The mirror metadata declares
MIT, although the `LICENSE` file mentioned by its README is absent at this
revision; canonical upstream licensing was therefore reviewed separately.

Run `pnpm assets:formula-ocr` to download missing files and verify every recorded
size and SHA-256 hash. Conversion never contacts the mirror: Vite emits the
models as same-origin hashed assets, and the service worker caches them after
their first use.