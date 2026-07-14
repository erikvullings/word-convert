# Core contracts

`@wordconvert/document-model` is the stable boundary between DOCX readers, output writers, the worker adapter, and the UI. It has no browser or UI dependencies.

## Model and versioning

Every `DocumentModel` carries `schema: "wordconvert.document"` and a numeric `version`. Additive optional fields do not require a new version. Removing or changing a field, changing node meaning, or adding a required field requires a new version and a migration before readers or writers adopt it. Writers must reject unsupported versions through `validateDocumentModel` rather than guessing.

Dates and timestamps are ISO 8601 strings, never `Date` instances. The caller supplies `options.conversionDate`; readers and writers must not read the system clock. Metadata inferred or defaulted by WordConvert is wrapped in `InferredValue`, which records its source, method, confidence, and optional reason.

All nodes are plain objects selected by discriminant fields. Maps use string-keyed records. Package boundaries must not contain class instances, DOM nodes, errors, promises (except operation results), or platform handles.

## Binary and JSON conventions

In memory and across structured-clone boundaries, binary fields are `Uint8Array`. Do not rely on a view's offset into a larger buffer: construct a `Uint8Array` containing exactly the asset or output bytes. A worker may transfer its underlying `ArrayBuffer` only when it gives up ownership.

For JSON-only boundaries, use `serializeDocumentModel` and `deserializeDocumentModel`. They encode a typed array as:

```json
{ "$binary": "uint8-array", "bytes": [0, 127, 255] }
```

This representation favors an unambiguous initial contract over compactness. A later compact encoding requires a model-version decision.

## Operations

`DocxReader.read` accepts DOCX bytes and explicit options, then returns a `DocumentModel`. Text writers return strings; binary writers return `Promise<Uint8Array>`. Progress callbacks and an in-process mutable cancellation signal are runtime controls rather than model data. Worker adapters translate them to serializable `OperationControlMessage` values keyed by operation ID and must not duplicate conversion logic.

Failures crossing a package or worker boundary use `ConversionError`, a plain structured object, not an `Error` instance. Error details must not contain document text, metadata, filenames, images, formula source, or other private input.

## Future WASM boundary

A future `WasmDocxReader` implements the same `DocxReader` interface. JavaScript passes an exact `Uint8Array` plus JSON-safe reader options to WASM. WASM returns the versioned model using the documented JSON binary envelope (or an equivalent structured decoder tested against it), plus structured progress and error messages. Writers and the UI remain TypeScript consumers of `DocumentModel`; no WASM-specific object may escape the adapter.
