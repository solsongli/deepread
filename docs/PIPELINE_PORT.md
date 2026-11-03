# Reader pipeline: provenance and original integration

This document records the initial integration of Vibero-derived code. The instructions and source slices below
describe that historical work, not a requirement that current implementations remain unchanged. DeepRead has since
added parsing options, structured translation, continuation handling and reading interfaces. Current module contracts
are in `DEV_NOTES.md`; the retained code's attribution and licensing scope are in `../NOTICE.md`.

Source (git-ignored, local only): `.port-src/vibero/`. These are verbatim slices of Vibero's reader bundle
(`chrome/content/reader/reader.js`, class `Reader`, 8-space indented methods) and Zotero-side helpers.

| file | content |
|---|---|
| `pipeline_main.js` | Reader methods from `setParseResultInSummaryManager` through `_buildPagePrompt` |
| `onflow.js` | `_onFlowReparse` — the orchestration we re-create as `Pipeline.run()` (ends inside `_destroyAllVibeReadingLayers`; ignore the tail) |
| `pdfcoords.js`, `bboxrect.js`, `utils.js` | coordinate helpers and block utilities used by the pipeline |
| `summary_manager.js` | `class SummaryManager` (the slice is cut inside `printAllData`; drop that debug method and close the class) |
| `parse_languages.js` | `PARSE_LANGUAGES`, `SOURCE_LANGUAGE_OPTIONS`, `FRANC_TO_SOURCE_LOCALE` constants |
| `reader-llm-response-formats.js` | `ReaderLLMResponseFormats` (json_schema `response_format` builders) |
| `pdfParser.js` | Zotero-side `llmRequest` and `_parseLLMResponse` (semantics of `_call_llm_api`) |
| `llmapi.js`, `MinerU.js` | reference only (they talk to Vibero's paid proxy — do not port the network code) |

## Target files

### `addon/content/scripts/pipeline/languages.js`
- `DeepRead.PARSE_LANGUAGES`, `DeepRead.SOURCE_LANGUAGE_OPTIONS`, `DeepRead.FRANC_TO_SOURCE_LOCALE` copied verbatim.
- `DeepRead.detectLanguage(text)` → ISO 639-3 code like franc (`"eng"`, `"cmn"`, `"jpn"`, `"kor"`, `"tha"`, `"rus"`,
  `"arb"`, `"fra"`, `"spa"`, `"deu"`, `"ita"`, `"por"`, `"nld"`, `"tur"`, `"vie"`) or `"und"` when text is shorter than
  40 non-space chars or undecidable. Heuristic: script ratios (Han → if kana present ≥5% `jpn` else `cmn`; Hangul
  `kor`; Thai `tha`; Cyrillic `rus`; Arabic `arb`), else Latin stop-word scoring for the Latin languages; Vietnamese by
  its diacritics (ạ ả ấ ầ ẩ ẫ ậ ắ ằ ẳ ẵ ặ ẹ ẻ ẽ ế ề ể ễ ệ ỉ ị ọ ỏ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ụ ủ ứ ừ ử ữ ự ỳ ỵ ỷ ỹ đ).

### `addon/content/scripts/pipeline/responseFormats.js`
`DeepRead.ResponseFormats` = the object the UMD factory in `reader-llm-response-formats.js` returns (same functions,
same output). Replace the UMD wrapper with a plain assignment.

### `addon/content/scripts/pipeline/summaryManager.js`
`DeepRead.SummaryManager = class SummaryManager { ... }` — all methods except `printAllData`. Change
`_convertMinerUBboxToRects(bbox, pageIndex)` to use real page sizes: add `setPageSizes(map)` / `this.pageSizes`
(`{ [pageIndex]: { width, height } }`, PDF points) and fall back to 612×792 only when unknown.

### `addon/content/scripts/pipeline/pipeline.js`
`DeepRead.Pipeline = class Pipeline { ... }`. Keep the ported method bodies as close to the original as possible
(re-indent to 2 spaces inside the class). Mechanical replacements:

| Vibero | DeepRead |
|---|---|
| `getLocalizedString(key, args)` | `this._l10n(key, args)` (map the few keys to `DeepRead.t`/`DeepRead.bilingual` strings) |
| `franc(value, { minLength: 40 })` | `DeepRead.detectLanguage(value)` |
| `PARSE_LANGUAGES`, `FRANC_TO_SOURCE_LOCALE` | `DeepRead.PARSE_LANGUAGES`, `DeepRead.FRANC_TO_SOURCE_LOCALE` |
| `llm_response_formats.` | `DeepRead.ResponseFormats.` |
| `MAX_CONCURRENCY = 50` in `_generateSummaryAndTranslationByPage` | `this._concurrency` |

Drop these methods (UI / login / credits — not ported): `regenerateArticleSummary`, `_syncNativeOutlineToSummaryManager`,
`_updateOutlineSidebarState`, `_getOutlineCreditsNeeded`, `_getArticleSummaryCreditsNeeded`, `ensureOutlineForSidebar`,
`generateOutlineForSidebar`, `_renderBboxOverlays`. Read their bodies only to re-create the data flow below.

Constructor and shims:

```js
constructor({
  getPdfApp,      // () => PDFViewerApplication of the reader's primary view (pdfDocument.getPageData, getPage, pdfViewer)
  llm,            // async ({ messages, responseFormat, maxTokens, temperature, signal }) => ({ content })  (DeepRead.LLM.complete)
  parsePDF,       // async ({ excludedPageIndices, onStatus }) => ({ resultDir, contentList, markdown })   (DeepRead.Parser.parsePDF)
  onProgress,     // ({ percent?, message? }) => void
  notify,         // (message, type /* "info" | "warning" | "error" */) => void
  language = "zh",// key of DeepRead.PARSE_LANGUAGES used for summaries/translations
  paperTitle = "",
  concurrency = 8,
  filterAuthors = true,
  signal,         // AbortSignal; abort → throw DOMException-like Error("aborted") at the next checkpoint
})
```
- `this._summaryManager = new DeepRead.SummaryManager()`; `this._state = {}`; `_updateState(patch)` merges into
  `_state`; `this._readerRef = { current: null }`; initialise every `this._…` field the ported code reads
  (`_reparsePageLanguageSampleCache = new Map()`, `_pageLLM…`, `_sourceTextSegmenterLocale`, …).
- `get _primaryView()` returns `{ _iframeWindow: { PDFViewerApplication: this._getPdfApp() } }` so ported code works.
- `_getCurrentLlmPromptLanguage()` → `this._llmPromptLanguage`; `_bilingual(zh, en)` → `DeepRead.bilingual(zh, en)`.
- `_setFlowProgress({percent, message})`, `_setFlowProgressMessage(message)` → `onProgress`;
  `_scheduleClearFlowProgress`, `_buildAndRenderMindMapView`, `_renderMindMapEmptyState` → no-ops.
- `_showNotification(message, type)` → `notify`; `_showAPIErrorDialog()` → `notify(<rate-limit message>, "error")`.
- `_checkFlowAborted()` → throws when `signal.aborted`; also call it between the major steps of `run()` and before
  each page LLM request.
- `_readMarkdownFile(resultDir)` → returns the markdown captured from the last `parsePDF` result.
- `_parsePDF(optionsJson, onPoll)` → calls `parsePDF` and returns Vibero's shape
  `{ success: true, pdfProcessResult: { resultDir, contentList } }` or `{ success: false, error, message }`.
- `_call_llm_api(prompt, options)` must reproduce Vibero's `Zotero.pdfParser.llmRequest` contract
  (see `pdfParser.js` `llmRequest` + `_parseLLMResponse`): build
  `messages = [{role:"system", content: options.system}?, {role:"user", content: prompt}]`, pass
  `options.response_format` as `responseFormat`, `options.max_tokens` as `maxTokens`, `options.temperature`;
  then parse the returned content: JSON array → return the array; JSON object → return the raw content string;
  unparseable → return raw content; empty → `""`; errors propagate unchanged.

New public API (re-creating `_onFlowReparse`, `generateOutlineForSidebar`, `regenerateArticleSummary` without UI,
login or credits):

```js
async run({ excludedPageIndices = [] } = {})
  // parse → setParseResultInSummaryManager → collect chars from pdfDocument.getPageData({pageIndex}) for every
  // included page (char.offset = global index, char.pageIndex = i) → processParagraphData → selectMainBlocks →
  // filterAuthorListByLLM (only if filterAuthors) → _detectSourceTextLanguageForSegmentation → bboxMatch →
  // processSentenceData → Promise.allSettled([articleSummaryRequest(mainBlocks, contentList), llmRequest(sentenceData)])
  // (article summary failure = warning, page failure = throw) → set page sizes on the SummaryManager (from
  // _getPageDimensions) → buildHierarchicalData. Same progress percents/messages as onflow.js.
  // returns { resultDir, contentList, markdown, hierarchicalData, articleSummary, blockMapping, sourceLocale }
async generateOutline()            // needs loadState() or run() first; returns the outline root node (sections)
async regenerateArticleSummary()   // returns { articleSummary, blockMapping }
loadState({ resultDir, contentList, markdown, hierarchicalData, articleSummary, blockMapping, sections })
getState()                         // same keys, read back from the SummaryManager
```

Excluded pages (`excludedPageIndices`) can be left unsupported in `run()` (pass `[]`), but keep the helper methods.

## Done when
- `node --check` passes for all four files.
- `node test/pipeline-smoke.mjs` passes: loads `util.js`, `l10n.js` (with a stub `Zotero`), `languages.js`,
  `responseFormats.js`, `summaryManager.js`, `pipeline.js` into a `vm` context, constructs a `Pipeline` with stub
  callbacks, and checks: `selectMainBlocks` on a small MinerU-style content list returns page groups;
  `_buildPagePrompt` contains the paragraph id; `_call_llm_api` returns an array for `'[{"a":1}]'`, the raw string for
  `'{"a":1}'`, and strips a ```json fence; `_isPointSplitValidWithTranslation` accepts `[[0],[1]]` for 2 sentences.
