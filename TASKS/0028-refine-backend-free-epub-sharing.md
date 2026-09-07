# 0028 Refine backend-free EPUB sharing

Status: done
Priority: medium
Subsystem: frontend
Depends on: 0014

## Context

WordConvert already keeps generated EPUB bytes in browser memory, offers local
download, and exposes a `Mail document` action. The existing `mailEpub` helper
creates an EPUB `File`, defensively calls `canShare` with that real file, opens
the native share sheet when supported, suppresses user cancellation in the
controller, and otherwise opens a subject-only `mailto:` draft. No EPUB data is
uploaded and no backend or external sharing service is involved.

The current behavior does not yet match the intended UX and API boundaries:

- The button is always labelled `Mail document`, even when it opens a general
  OS share sheet with non-mail targets.
- Capability is checked only after the click, so the UI does not distinguish
  `Share EPUB` from the unsupported `Email…` fallback.
- The mail fallback neither downloads the EPUB first nor tells the user to
  attach the downloaded file manually.
- An unexpected native-share failure silently opens email instead of reporting
  the failure and offering an explicit fallback.
- Cancellation is represented by a rejected promise and interpreted in the
  controller rather than by a framework-independent typed result.
- Filename normalization and capability/result behavior do not have the full
  focused coverage required for a reusable share service.

## Acceptance Criteria

- Framework-independent EPUB export helpers create an
  `application/epub+zip` `File`, preserve case-insensitive `.epub` extensions,
  and append `.epub` when absent.
- Runtime detection requires both `navigator.share` and `navigator.canShare`
  and tests the actual generated EPUB `File`; partial or throwing browser APIs
  are treated as unsupported without user-agent sniffing.
- Sharing returns explicit `shared`, `cancelled`, `unsupported`, and `failed`
  results. Closing the native share sheet produces no error or automatic
  download.
- When the real EPUB can be shared, the EPUB actions show `Download EPUB` and
  `Share EPUB`; sharing is invoked directly from the user action with the EPUB
  file, title, and concise text.
- When EPUB file sharing is unsupported, the actions show `Download EPUB` and
  `Email…`. Email first completes a local download, then opens a prefilled
  `mailto:` subject/body that explicitly asks the user to attach the named
  downloaded file manually.
- Unexpected share failures produce concise in-app feedback and retain an
  explicit download fallback rather than silently changing transport.
- Existing EPUB download behavior remains functional, including native save
  picker cancellation and browser-download fallback.
- Vitest coverage includes filename normalization, absent/partial/throwing
  browser APIs, `canShare` false, successful sharing, cancellation, unexpected
  failure, and email URL content. UI tests cover capability-dependent labels
  and EPUB-only visibility.
- Sharing remains entirely client-side: no upload, backend, tracking endpoint,
  provider integration, non-standard `mailto` attachment parameter, Blob URL
  in email, or EPUB data in the URL is introduced.
- Browser evidence records the actual EPUB `navigator.canShare({ files })`
  result and observed behavior for available desktop Chrome/Edge, macOS
  Safari, and Firefox environments. iOS/iPadOS Safari and Android Chrome are
  recorded when devices are available; unavailable platforms are marked
  untested rather than inferred.
- `documentation/hardening.md` describes secure-context/user-activation
  assumptions, explicit fallback behavior, privacy properties, and dated
  representative browser results.

## Implementation Notes

- Start from `apps/web/src/download/index.ts`, where `mailEpub` already owns the
  current Web Share and `mailto:` behavior. Extract or replace it without
  duplicating the existing `saveDownload` path.
- The generated artifact is currently `DownloadOutput` (`ArrayBuffer`, filename,
  and media type), not a `Blob`. Keep EPUB generation and worker protocol
  unchanged; construct the `Blob`/`File` only at the export boundary.
- Update `apps/web/src/app.ts` and `apps/web/src/controller.ts` using existing
  Mithril button, state, and error-reporting patterns. Do not add another UI
  framework or state owner.
- Capability rendering may use the real in-memory output file. Recheck with the
  same file immediately before `navigator.share` because browser support can be
  partial and file-type-specific.
- Keep the generated EPUB available after download so the email fallback can
  open its draft after a successful save. If the save picker is cancelled, do
  not open email.
- Native share-sheet targets and attachment delivery require manual testing;
  browser automation can verify feature detection, labels, fallback UI, and
  calls but cannot prove the selected native application received the file.

## Agent Notes

- 2026-09-07 GitHub Copilot: Reviewed the existing implementation. Useful
  foundations are already present in `apps/web/src/download/index.ts`, with
  focused tests in `apps/web/src/download/download.test.ts` and controller tests
  in `apps/web/src/controller.test.ts`. The main work is API/UX refinement and
  browser evidence, not adding a new transport. Existing privacy documentation
  is in `documentation/hardening.md`.
- 2026-09-07 GitHub Copilot: Implementation started at the framework-independent
  download/share boundary. Existing unrelated worktree changes are being kept
  intact; validation and staging will remain scoped to 0028.
- 2026-09-07 GitHub Copilot: Added typed EPUB file, capability, sharing, and
  email helpers; capability-dependent Mithril actions; explicit share-failure
  feedback; and download-before-email behavior that retains EPUB output and
  skips email when saving is cancelled. Updated privacy/security documentation
  with dated runtime evidence: macOS Chrome 146 and Edge 152 both accepted the
  real EPUB file in secure localhost contexts; native target selection and
  Safari/Firefox/mobile platforms remain explicitly untested. Validation: 67
  affected tests, recursive typecheck, lint, and scoped formatting passed. The
  full suite passed 373 tests with 2 skipped before one unrelated existing
  CodeMirror duplicate-`@codemirror/state` failure; production build/static
  verification could not run because the current build requires an unavailable
  `WORDCONVERT_TEXTELLER_MODEL_DIR` bundle. Focused code review found no defects.