# DeepRead — developer notes and module contracts

Current reading-flow branch: `services/reading.js` owns goal definitions and safe carry-over of personal records on reparse; `userState.readingGoal`, `figureNotes`, `recallAnswers`, `highlightDensity` and `unmappedNotes` persist locally.

Current reading-flow branch: glossary, flashcards and code repository panels/services have been removed.
Their historical contracts below are retained as version history, not current runtime entry points.
Legacy SQLite columns/tables are preserved. New runtime helpers are `services/cardGroups.js` (AI/manual/
continuation grouping without rewriting paragraph keys) and `services/highlights.js` (sparse legacy fallback).
Current regression: `test/readingFlow.test.mjs` and offline `test/e2e/readingFlow.js`; research rationale:
`docs/READING_METHODS.md`. UI navigation opens cards explicitly; only source pointer clicks request toggling.

DeepRead is a Zotero 7–10 plugin (bootstrapped, no build step for runtime code). It rebuilds the AI reading features of
"Vibero" (an AGPL fork of Zotero 8): MinerU PDF structure parsing → per-paragraph LLM summary / key points / point
translations → overlays in the PDF reader, plus article summary cards, AI outline and AI chat. All network calls go to
services **the user configures with their own keys**. Never call Vibero/Supabase endpoints.

Primary test target: Zotero 10.0.6 at `~/.local/opt/zotero-10.0.6` (Gecko 140 / Firefox ESR 140 JS engine).

## Runtime code conventions (addon/content/scripts/**)

- Files are loaded with `Services.scriptloader.loadSubScript(url, scope)` in the order listed in
  `addon/content/scripts/index.js`. **No `import`/`export`, no `require`, no ES modules.**
- Every module attaches to the shared namespace object `DeepRead` (e.g. `DeepRead.LLM = {...}`,
  `DeepRead.Pipeline = class Pipeline {...}`). Do not declare top-level `const`/`let`/`class` names other than through
  `DeepRead.*` (top-level lexical names from different files share one scope and collide). Wrapping a file body in an
  IIFE is fine.
- Globals available in the scope: `Zotero, Services, Components, ChromeUtils, Cc, Ci, Cu, IOUtils, PathUtils, fetch,
  URL, URLSearchParams, TextDecoder, TextEncoder, Blob, FormData, AbortController, crypto, btoa, atob, structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval, console`. No `window`/`document` globals — get a document from
  the element you are given or `Zotero.getMainWindow()`.
- Files and dirs: use `IOUtils` / `PathUtils` (async). Zip reading: `nsIZipReader`
  (`Components.Constructor("@mozilla.org/libjar/zip-reader;1", "nsIZipReader", "open")`), files via
  `Zotero.File.pathToFile(path)`.
- Logging: `DeepRead.log(...)` (goes to Zotero debug output). User-facing strings: `DeepRead.t(key, args)`
  (`scripts/l10n.js`), add keys for both `zh` and `en`.
- Prefs: `DeepRead.prefs.get("llm.model")` etc. (keys under `extensions.zotero.deepread.*`, defaults in `addon/prefs.js`).
  Helpers `DeepRead.prefs.llmConfig({chat})` and `DeepRead.prefs.parserConfig()` return normalized config objects.
- Each file starts with a short header comment and `License: AGPL-3.0-or-later`. Code ported from Vibero keeps a note
  `Ported from Vibero (AGPL-3.0, a Zotero fork)`.
- Style: 2-space indent, double quotes in new code (ported code may keep its quoting), semicolons.
- Quick syntax check for any runtime file: `node --check <file>` (it is a script, not a module).

## Module contracts

### DeepRead.LLM — `scripts/services/llm.js`
OpenAI-compatible Chat Completions client (`POST {baseURL}/chat/completions`).

```js
DeepRead.LLM.complete({
  messages,              // [{role, content}]; content may be string or OpenAI content-parts array
  system,                // optional string, prepended as a system message
  responseFormat,        // optional: { type: "json_schema", json_schema: {name, strict, schema} } | { type: "json_object" }
  maxTokens, temperature, signal, timeoutMs, config, // config defaults to DeepRead.prefs.llmConfig()
}) → Promise<{ content: string, usage?: object, raw: object }>

DeepRead.LLM.stream({ messages, system, signal, config, temperature, maxTokens,
                      onDelta(deltaText, fullText) }) → Promise<string /* full text */>

DeepRead.LLM.testConnection(config?) → Promise<{ ok: boolean, message: string }>
DeepRead.LLM.isConfigured(config?) → boolean   // baseURL and model set (apiKey may be empty for local servers)
```
Rules:
- `config.jsonMode` (pref `llm.jsonMode`) decides what is actually sent when a caller passes `responseFormat`:
  `"json_schema"` → send as given; `"json_object"` → always send `{type:"json_object"}`; `"none"` → send nothing.
  If the server answers 400/422 and the body mentions `response_format`/`json_schema`/`json_object`, retry once
  downgraded (json_schema → json_object → none).
- Headers: `Content-Type: application/json`, `Authorization: Bearer <apiKey>` when apiKey is non-empty, plus
  `config.extraHeaders`.
- Errors: throw `Error` whose message contains the HTTP status number (the pipeline checks `message.includes("429")`),
  status text and up to 500 chars of the body; set `error.status`.
- Retries: network errors and 5xx → retry up to 2 times (1s, 3s backoff). 429 → honor `Retry-After` (cap 20s), up to
  3 retries, then throw. Never retry other 4xx.
- `content`: `choices[0].message.content` (string; if array of parts, join text parts). Strip a leading
  `<think>…</think>` block. If `content` is empty but `reasoning_content` exists, do not use reasoning as content.
- Streaming: SSE (`stream: true`), parse `data:` lines, `choices[0].delta.content`, stop on `[DONE]`; support abort.
- Default timeout 240 s for `complete`, none for `stream` (abort via signal).

### DeepRead.Parser — `scripts/services/parser.js`
```js
DeepRead.Parser.parsePDF({ filePath, attachmentKey, onStatus, signal })
  → Promise<{ resultDir: string, contentList: object[], markdown: string }>
DeepRead.Parser.testConnection(config?) → Promise<{ ok, message }>
DeepRead.Parser.isConfigured(config?) → boolean
```
- Providers (pref `parser.provider`): `"mineru"` = official mineru.net API v4 with the user's token;
  `"selfhost"` = MinerU FastAPI (`mineru-api`) or any compatible third-party deployment (`POST {selfHostURL}/file_parse`).
- `resultDir = await DeepRead.Store.resultDirFor(attachmentKey)`; empty it before writing; unzip the result there and
  flatten a single wrapping folder.
- `contentList`: parsed MinerU `*_content_list.json` (bbox values are per-mille 0–1000, top-left origin, `page_idx`
  0-based), then each item gets `id: <index>` added (`{ id: index, ...item }`).
- `markdown`: content of `full.md` (or the first `*.md`), "" if absent.
- `onStatus({ phase, message, extractedPages, totalPages })`, phases: `upload | queued | running | download | extract`.

### DeepRead.Store — `scripts/services/store.js` (done)
`getPaper(key)`, `savePaper(key, itemID, fields)`, `deletePaper(key)`, `getChat(key)`, `saveChat(key, messages)`,
`resultDirFor(key)`. Paper fields: `result_dir, language, content_list, hierarchical_data, article_summary,
block_mapping, sections, markdown, github_url, user_state`.

### DeepRead.Pipeline — `scripts/pipeline/pipeline.js` (+ `summaryManager.js`, `languages.js`, `responseFormats.js`)
Port of Vibero's reader-side pipeline. See `docs/PIPELINE_PORT.md`.

### Reader integration, panes — `scripts/reader/*`, `scripts/panes/*`
Owned by the lead; not part of delegated tasks.

## Item pane / Fluent IDs (locale/<lang>/deepread.ftl)
Section headers use `.label`, sidenav buttons and section buttons use `.tooltiptext`:
`deepread-pane-summary-header`, `deepread-pane-summary-sidenav`, `deepread-pane-outline-header`,
`deepread-pane-outline-sidenav`, `deepread-pane-chat-header`, `deepread-pane-chat-sidenav`,
`deepread-section-button-regenerate`, `deepread-section-button-clear-chat`.

## Testing
- Offline fixtures: `test/fixtures/` (demo paper + MinerU-style content list rebuilt from Vibero's demo data).
- Fake services: `test/fake-openai.mjs` (OpenAI-compatible), `test/fake-mineru.mjs` (MinerU `/file_parse`).
- A separate Zotero profile + data dir is used for testing; never touch the user's real profile
  (`~/.zotero` → `~/Applications/Zotero/profile`) or data dir (`~/Applications/Zotero/data`).

## Zotero 10 / Gecko 140 gotchas (learned the hard way)
- `applications.zotero.update_url` and `strict_max_version` are **required**; otherwise the add-on is rejected
  silently and a sideloaded XPI is deleted from the profile.
- Developer proxy files (a text file with the source path) are detected but never installed; sideload a built XPI.
- Zotero starts plugins sequentially and awaits each `startup()`; never block startup on long work.
- The bootstrap sandbox has no `console`; `bootstrap.js` injects a shim (verbose logs need pref `deepread.debug`).
- `Services.parserUtils` is gone; use `Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils)`.
  HTML fragment parsing is unavailable in the XHTML main window: sanitize → DOMParser → importNode.
- Values resolved from content promises come back as Xrays: pdf.js getters (`page.view`, `getViewport`) are
  invisible until you `.wrappedJSObject` them. Clone arguments into content with `Cu.cloneInto`.
- Listeners added by privileged code to content nodes ignore untrusted (synthetic) events.
- Close `Zotero.DBConnection`s on app quit (`Zotero.addShutdownListener`): a non-empty `-wal` makes Zotero run a
  blocking integrity check with a progress popup on the next start.
- Preference-pane scripts run before the pane fragment is inserted; Zotero then dispatches a non-bubbling
  `load` event on the pane root (listen in the capture phase).

## v0.2 contracts

### Session additions (`reader/session.js`, owned by the lead — use, don't edit)
- `session.flashcards` (array or null until loaded), `await session.loadFlashcards()`,
  `await session.saveFlashcard(card)` → saved card (upsert), `await session.deleteFlashcard(id)`,
  `await session.navigateToFlashcard(card)`, `session.flashcardContext(pageIndex)` → `{ title, abstract, pageText }`.
  Emits `"flashcards"` (payload `{ id }`) after every change.
- `session.githubRepo` ("owner/repo" or null, persisted in papers.github_url), `await session.setGitHubRepo(fullName|null)`
  (emits `"github"`), `await session.paperText(maxChars)` → abstract + parsed text (or Zotero full-text cache).
- `session.askAI({ text, pageIndex })` quotes text into the chat pane; `session.reader.navigate(location)`.
- Pane renderers: `DeepRead.Panes.renderers.<kind> = (ctx) => {}` with `ctx = { body, doc, session, event, h }`.
  Events: `change | progress | ask | chat | chat-delta | flashcards | github`. Return early for events you don't need
  (re-rendering on every progress tick destroys input focus). `h(tag, props, ...children)` = `DeepRead.util.h`.
  Shared helpers: `DeepRead.Markdown.render(doc, text, contextEl)` → sanitized fragment (marked + KaTeX),
  `DeepRead.Markdown.wireLinks(container)`, `DeepRead.Panes.reportError(session, error)`, CSS classes in
  `content/styles/panes.css` (`dr-pane`, `dr-muted`, `dr-error`, `dr-empty`, `dr-primary-button`, `dr-link-button`,
  `dr-clickable`, `dr-markdown`, `dr-chip`). Put new pane CSS in your own stylesheet file and tell the lead.

### DeepRead.Flashcards — `services/flashcards.js`
Card: `{ id, pageIndex, rects: [[x1,y1,x2,y2]] /* PDF coords */, quote, question, answer, color, source:
"selection"|"paragraph"|"manual", createdAt, updatedAt }` (ISO strings).
```js
await DeepRead.Flashcards.init()                 // CREATE TABLE IF NOT EXISTS flashcards (... ) on DeepRead.Store.db
await DeepRead.Flashcards.list(attachmentKey)    // → cards in reading order (DeepRead.Flashcards.sort)
DeepRead.Flashcards.sort(cards)                  // pageIndex asc, then top (max y) desc, then createdAt
await DeepRead.Flashcards.save(attachmentKey, card) // upsert; assigns id "fc_<12 hex>" and timestamps; returns card
await DeepRead.Flashcards.remove(attachmentKey, id)
await DeepRead.Flashcards.generate({ quote, context, signal })  // → { question, answer } via DeepRead.LLM (JSON)
await DeepRead.Flashcards.answer({ question, quote, context, signal }) // → markdown answer string
await DeepRead.Flashcards.exportToNote(parentItem, cards, { title }) // → new child note (HTML) in Zotero
```
`context` = `session.flashcardContext(pageIndex)`; answer language = `DeepRead.PARSE_LANGUAGES[DeepRead.prefs.language()]`.

### DeepRead.GitHub — `services/github.js`
```js
DeepRead.GitHub.parseRepo(urlOrFullName)   // → { owner, repo, fullName, url } | null
DeepRead.GitHub.findReposInText(text)      // → [{ fullName, url, count, firstIndex }] most relevant first
await DeepRead.GitHub.search(title, { signal })  // → [{ fullName, url, description, stars, language, updatedAt }]
await DeepRead.GitHub.getRepo(fullName)    // → { fullName, url, description, stars, forks, language, license, updatedAt, defaultBranch, topics, homepage, archived }
await DeepRead.GitHub.getReadme(fullName)  // → { markdown, htmlURL } | null
await DeepRead.GitHub.listDir(fullName, path = "", ref)   // → [{ name, path, type: "file"|"dir", size }]
await DeepRead.GitHub.getFile(fullName, path, ref)        // → { text, size, truncated, binary, htmlURL }
```
Optional token pref `github.token` (Bearer). Errors name the step, include status; rate limit → message with reset time.

### DeepRead.DeepWiki — `services/deepwiki.js`
Client for DeepWiki's public MCP server (pref `deepwiki.endpoint`, default `https://mcp.deepwiki.com/mcp`):
`callTool(name, args, { signal })` → text; `readWikiStructure(fullName)`, `readWikiContents(fullName)`,
`askQuestion(fullName, question, { signal })`. Handles MCP initialize/session id and JSON or SSE responses.

## v0.3 parser providers (lightweight / local)

`DeepRead.Parser.parsePDF` dispatches on pref `parser.provider`:
`"builtin"` (new default) | `"grobid"` | `"mineru"` | `"selfhost"`. Every provider must return a **MinerU-style
content list**: items in reading order, each `{ type: "text"|"image"|"table"|"equation", text?, text_level? (1 for
titles/headings), bbox: [x0, y0, x1, y1] (per-mille 0–1000 of the page box, TOP-LEFT origin), page_idx (0-based) }`;
images `{ type:"image", img_path:"", image_caption:[...], image_footnote:[] }`, tables `{ type:"table", img_path:"",
table_caption:[...], table_body:"", table_footnote:[] }`, equations `{ type:"equation", text, text_format:"latex"|"text" }`.
Headers, footers, page numbers and marginal stamps (e.g. the rotated arXiv id) are omitted. `Parser` adds `id`.
Per-mille conversion from a PDF rect `[x1,y1,x2,y2]` (bottom-left origin) on a page with view box `[vx0,vy0,vx1,vy1]`:
`x = (X - vx0) / (vx1 - vx0) * 1000`, `y = (vy1 - Y) / (vy1 - vy0) * 1000` (so y0 comes from the rect's top).

### DeepRead.TextLayerParser — `services/textLayerParser.js` (provider "builtin", no service)
```js
await DeepRead.TextLayerParser.parse({ pdfApp, onStatus, signal }) // → { contentList, markdown }
DeepRead.TextLayerParser.buildContentList(pages)                    // pure function (unit-testable)
//   pages = [{ pageIndex, viewBox: [x0,y0,x1,y1], chars: [...] }] as returned by pdfApp.pdfDocument.getPageData
```
`pdfApp` is the session's pdf adapter (`pdfDocument.numPages`, `pdfDocument.getPageData({pageIndex})` → `{ chars,
viewBox }`). Chars (Zotero's structured text): `{ c, u, rect:[x1,y1,x2,y2], fontSize, fontName, bold, italic, baseline,
rotation, spaceAfter, lineBreakAfter, paragraphBreakAfter, inlineRect }`, in reading order (columns handled).

### DeepRead.GrobidParser — `services/grobidParser.js` (provider "grobid", local Docker service)
```js
await DeepRead.GrobidParser.parse({ filePath, config, onStatus, signal }) // → { contentList, markdown }
DeepRead.GrobidParser.teiToContentList(teiXmlString, { DOMParser })       // pure function (unit-testable)
await DeepRead.GrobidParser.testConnection(config)                        // → { ok, message }
```
Config: `parser.grobidURL` (default `http://127.0.0.1:8070`). `POST {url}/api/processFulltextDocument` with
`teiCoordinates` for head, p, s, figure, formula, title; page sizes from `<facsimile><surface>`.

v0.4–v0.5 (ReadFlow client, built-in full-document translation, translated-PDF export) were removed in v0.6; see git tag v0.5.0.

## v0.6: reading interactions

- **Hover → in-place translation.** `overlay._setHover(p)` draws the outline at once and, after
  `TRANSLATION_DELAY` (160 ms) on the same paragraph, sets `overlay.trPara = p` and paints the paragraph's point
  translations (`_paragraphTranslation`) over its bbox (`.dr-translation`, transient sublayer). Layout comes from
  the paragraph's own line rects (`_lineMetrics`: rects on one line merged; font size = median line-box height,
  line height = median line pitch, first-line indent), shrunk together only when the text overflows. Text goes
  through `DeepRead.Overlay.inlineMarkdown(doc, text)` (marked + KaTeX, sanitized), so `$…$` renders; KaTeX CSS is
  injected into the PDF and reader documents. Titles (`paragraphType === "title"`) are bold, left-aligned.
  Original instead of translation when: Alt is held (`altDown`), pref `view.translationPopup` is off, the
  paragraph is an equation, or it was pressed / drag-selected (`_suppressPara`, cleared when the pointer leaves it).
- **Click → open the card.** Capture-phase `pointerdown`/`pointerup` on the PDF window; a press that moved
  < `CLICK_SLOP` px, without modifiers, not on a link, calls `overlay.openParagraph(p | null)`:
  rail active → `rail.openParagraph(p)` (sets `rail.focusKey`; `rail.isOpen(key)` = expanded or focused; the card
  gets `.dr-open`, is never compact, is stacked anchored at its paragraph — cards above stack upwards — and the
  PDF scrolls so the card is fully visible: `_revealFocus`). Rail off → the floating card is shown and pinned
  (`overlay.cardPinned`) until a blank click or scroll. A click on blank page area closes.
- Synthetic events don't reach these privileged listeners; `test/e2e/interact.js` calls the handlers directly.
- Split rails: a page uses the left rail only if it has narrow body-text blocks on both halves
  (`rail._isTwoColumn`), so headings on one-column pages stay on the right.
- Reader toolbar and in-place updates: the reader dispatches `renderToolbar` only when its toolbar mounts
  (CustomSections effect), and `registerEventListener` does not re-dispatch for open readers. After an
  in-place update (auto-update / 检查更新) open tabs kept the previous version's buttons, wired to unloaded code.
  `Toolbar.register` therefore draws a fresh toolbar into every open reader (`div.end > div.custom-sections`,
  replacing any older `.deepread-toolbar`), and `Toolbar.unregister` (shutdown) removes ours.
  Test: `E2E_BASE_XPI=<released.xpi> E2E_UPDATE_XPI=<new.xpi> scripts/e2e.sh test/e2e/upgrade.js`;
  `test/e2e/restart.js` covers disable/enable.

## v0.7: cards built around the AI explanation

- `DeepRead.Explainer` (`services/explainer.js`): per-page batches → `{"explanations":[{key, explanation}]}`; keys
  `p_<page>_<para>`; `eligible()` = text / text_with_equation ≥ 40 chars. Stored in `papers.explanations`
  ({ key: { text, at } }, column added by a migration in `Store.init`). Session: `explanations`, `explaining`,
  `explainAll({ only })` (auto after `run()` unless pref `cards.autoExplain` is false; `onPage` fills cards
  progressively), `explainParagraph(key)` (card "讲", and on open when missing), `missingExplanations()`.
- Card order: summary · explanation (Markdown + KaTeX) · key points · folded translation (`▸ 译文`, default from
  pref `cards.translationOpen`, per-card flips in `rail.trToggled`) · 我的理解 · attached flashcards.
- Sizing: CSS vars `--dr-rail-width` / `--dr-card-font` from prefs `view.railWidth` (200–520) / `view.cardFontSize`
  (10–18), updated live by pref observers; `.dr-resize` drag handle on the rail edge facing the PDF; −/+ rows
  in the ▾ menu. Card CSS sizes are in em so everything scales with the font.
- Hover translation is now a panel below the paragraph (above when the page has no room), paragraph outlined.
- Chat: system prompt gets "# Paragraph blocks" (label `[p. 3 ¶2]`, summary, AI explanation, reader's note; ≤30% of
  `chat.maxContextChars`); quotes from cards carry `block`. `linkPageRefs` links `p. 3 ¶2` →
  `session.openBlock(page, para)`. `DeepRead.ChatPane.systemPrompt(session)` is exposed for tests.
- e2e: `test/e2e/cards.js`.

## v0.8: feature modules, roles, section bar, figure cards, three channels

- **Modules** (`reader/modules.js`). `DeepRead.Modules.LIST` = cards / hoverTranslation / highlights / structureBar /
  figureCards, each backed by a global pref (`view.*`). Effective state: `session.userState.modules[key]` (per-paper
  override, saved with the user state) if boolean, else the pref. `Modules.set(session, key, value, "paper"|"default")`
  — "default" writes the pref and drops this paper's override. Everything that draws asks `Modules.enabled(session, key)`;
  `session.applyModules()` pushes the state to overlay / rail / structure bar and emits `"modules"`. New modules
  (v0.9: question-led reading, hover check, skim layers) are added to `LIST` and nothing else in the toolbar.
- **Toolbar 「功能 n/m ▾」** (`reader/toolbar.js`, `openMenu`): scope switch 仅本文 / 设为默认, one
  `.dr-feature[role=menuitemcheckbox]` row per module (re-renders in place, menu stays open), card font / width rows,
  then 重新精读 · 生成 AI 讲解 · 显示隐藏的卡片 · 设置 · 删除本文精读结果.
- **Paragraph roles.** The explainer asks for one role per paragraph (`Explainer.ROLES`: background, gap, prior,
  contribution, method, result, limitation; unknown values dropped). `explanations[key] = { text, role, at }`;
  `session.paragraphRole(key)`. Cards: `.dr-para[data-role]`, a `.dr-role` pill (`Rail.roleLabel`), tinted
  `.dr-phead`, importance dot; compact cards show `.dr-badges` (闪卡 N / 理解).
- **Section bar** (`reader/structureBar.js`, `services/structure.js`). `Structure.sections(contentList)` →
  `[{ id, title, label, number, role, start, end }]` with `start`/`end` as fractional page positions
  (page index + y‰/1000); roles front / intro / background / method / experiment / discussion / references /
  appendix. The bar is `#deepread-bar` in the reader document at `top: 41px` (under the toolbar); while it is shown,
  `body.deepread-has-bar` moves `#split-view` to `top: 71px`. Segment flex = section length; read part drawn as a
  hard-stop gradient from `userState.readUpTo` (max position seen at 85% of the viewport). "Current" uses a reading
  line 20% down the viewport. Click scrolls `viewerContainer` so the heading sits 24 px below the top —
  `reader.navigate({position})` would centre it.
- **Figure cards** (`services/figures.js`). `Figures.list(contentList)` → `{ id: "fig_3"|"tab_I", kind, label: "图 3",
  title, caption, pageIndex, bbox }`; `Figures.mentions(figures, contentList)`; `Figures.explain(figures, {…})` →
  `Map(id → { title, steps: [{ text, panel }] })`, stored in `papers.figure_guides`. Session: `figures()` (cached),
  `figureMentionCount(id)`, `figureGuide(id)`, `explainFigures({ force })` (after `run()` when the module is on, and once
  lazily from the rail). Rail items `g_<id>` (`kind: "figure"`) anchored at `overlay.permilleRect(page, bbox)`: label,
  title, mention count, a thumbnail copied from the rendered page canvas (`_drawThumb`, redrawn on `pagerendered`),
  numbered steps. Clicking a paragraph that mentions the figure (`Rail.figureMention`) links the card and highlights
  the step for the mentioned panel.
- **Parser fallback.** For any provider other than builtin, a non-abort failure reports status "fallback" and
  reruns with the built-in text layer (`{ …result, fallback: true }`).
- **Settings: three channels.** ① 精读 API — provider profiles in the CC Switch style: `llm.profiles` (JSON list of
  `{ id, name, preset, baseURL, apiKey, model, chatModel, jsonMode, temperature, concurrency, extraHeaders }`) and
  `llm.activeProfile`; the active profile is mirrored into the flat `llm.*` prefs, which the runtime keeps reading
  (`prefs.profiles()` / `activeProfile()` are read-only helpers). ② 文档解析 — radio cards over `parser.provider`.
  ③ Agent (preparation for v1.0, nothing runs yet): `agent.kind` none / codex / claude / api / import,
  `agent.command`, `agent.skills` (default `nature-paper-xray,nature-paper-card`), `agent.timeoutMin`,
  `agent.api.*`. 「检测」 only looks for the executable on PATH and the skills' `SKILL.md`
  (`~/agents/codex/skills`, `~/.codex/skills`, `~/.claude/skills`); it never executes anything.
- e2e: `test/e2e/v08.js` (fallback, roles, bar + jump, figure card, refreshed cards, 功能 menu scopes).

## v0.8.1: reading feedback

- **Hover translation** (`overlay._drawTranslation`): the panel has the paragraph's width and (min-)height; its font
  scale is binary-searched in `FIT_MIN`–`FIT_MAX` × the original's line-box size so the text fills the box (cached per
  paragraph and page width in `overlay._trFit`). On a two-column page (`overlay.isTwoColumn(page)`, moved here from the
  rail) a narrow paragraph's panel is mirrored into the other column at the same top (`data-side` right/left); otherwise
  below/above as before.
- **Merged cards.** `Explainer.explainPages(…, { group })` (session passes pref `cards.groupParagraphs`) lets the model
  return `{"cards":[{keys, role, title, explanation}]}`; keys of a card are consecutive within a page batch (≤ 4).
  Result: Map(lead → text) + `.roles` (all members), `.groups` (lead → keys), `.titles`; `onPage(page, map, roles,
  { groups, titles })`. Session stores `explanations[lead] = { text, role, at, members, title }` and
  `explanations[member] = { lead, role, at }` (`_storeExplanations`); `groupLead(key)`, `groupMembers(key)`,
  `groupTitle(key)`, `groupLabel(key)` ("p. 3 ¶2–4"). The rail makes one item per lead (`item.members`), skips
  followers, opens the lead for a click on any member, outlines all members on hover (`overlay.outlineParagraphs`).
  `explainParagraph(key)` re-explains a merged card as a group (`explainAll({ only: members })`). Chat blocks list a
  merged card once under its range label.
- **Keep open** (pref `cards.keepOpen`, default true): `rail.openParagraph` moves the previously focused card into
  `rail.expanded`; a blank click no longer folds it. `rail.collapseAll()`, `rail.openCount`.
- **Highlighter** (pref `highlight.colors`, JSON list of 1–6 "#rrggbb"; `prefs.highlightColors()` /
  `setHighlightColors()`): point level 1 = none, level n ≥ 2 = colour n−1 (beyond the list: last colour);
  `session.nextPointLevel(point)` cycles back to 1 after the last colour; `session.levelColor(level)`. Cards set
  `li.dr-hl` + `--dr-hl`; PDF rects use the colour at `HIGHLIGHT_ALPHA`. The session observes the pref and redraws.
- **Folding rails** (prefs `view.railCollapsedLeft/Right`): `.dr-collapse` button per rail, `.dr-collapsed` = 24 px
  strip (click to unfold); `_layout` skips folded sides.
- **Figures** (`Figures.list`): visual types image/table/chart/figure; caption = first line in any caption field
  (`image_caption`, `table_caption`, `chart_caption`, `img_caption`, `caption`) that starts like a caption, earlier
  lines are panel labels; uncaptioned parts within `MERGE_GAP` (30‰) join the nearest captioned figure (repeated, so
  rows of panels chain); leftover clusters try a nearby caption text block; unused caption text blocks become
  `captionOnly` figures (no thumbnail). Cards carry `data-kind` figure (amber) / table (teal).
- e2e: `test/e2e/v081.js` (needs `E2E_PARSER=builtin E2E_PDF2=<two-column pdf>`).

## v0.9: skim layers, hover lookup, question-led reading

Three more entries in `DeepRead.Modules.LIST` (prefs `view.skim`, `view.lookup`, `view.questions`).

- **Skim** (`services/skim.js`, pure): `Skim.tiers(hierarchicalData, { role })` → `{ tier: Map(key → key|normal|minor),
  keyPoints }` from the paragraph role (weights in `ROLE_WEIGHT`, no role = neutral) plus the LLM point importance
  bonus; references / acknowledgements are minor; titles, equations, figures get no tier. `readingTime(paragraphs,
  { tier, mode })`, `nextKey/prevKey(entries, from)`. Session: `skimDepth` (per paper in `userState.skimDepth`, default
  pref `skim.depth`), `setSkimDepth()` (emits "skim"), `skimTiers()` (cached until change / explanations).
  Overlay `_renderPage` draws `.dr-dim` (minor; all text in margin mode, `.dr-dim-strong`) and `.dr-keyline` under the
  key points; the rail folds minor cards (all in margin mode). The section strip hosts the depth switch, reading time
  and "next key" (`structureBar.goKey(±1)`, keys N / Shift+N in the PDF window); the strip shows when either the
  section bar or skim is on.
- **Lookup** (`reader/lookup.js`, `services/references.js`, `services/glossary.js`): `DeepRead.Lookup` per session
  listens to pointermove in the PDF window, after a 280 ms dwell reads the page's chars
  (`pdfDocument.getPageData` → `{ u, rect, spaceAfter, lineBreakAfter }`), rebuilds the line under the pointer
  (`Lookup.lineAt`) and classifies the text at the offset (`find`): citation (`References.citationAt` + `resolve`
  against `session.references()`), figure/table reference (→ `session.figures()`), term (`Glossary.termAt`), symbol
  (`Glossary.matchSymbol` on the non-space run). Popover `.deepread-lookup` in the reader document; library match
  via `Lookup.findInLibrary(ref)` (DOI, then title) with "open" → best attachment. `References.list(contentList)` reads
  `ref_text` items (new MinerU) or the text after the References heading (split on "[n]" / numbered starts).
  Glossary: one request after the deep read (`session.buildGlossary()`, column `papers.glossary`).
- **Questions** (`services/questions.js`, `panes/questionsPane.js`): `Questions.generate({ blocks, … })` answers the
  five standard questions with block keys; `ask(question, …)` for the reader's own. Session: `questions = { items:
  [{ id, question, answer, keys, custom? }] }` (column `papers.questions`), `generateQuestions()` (waits for the
  explanations after a run), `askQuestion()`, `removeQuestion()`, `questionsForKey(key)` (card badges `.dr-q`),
  `questionReached(q)` (all answer paragraphs above `userState.readUpTo`), `questionProgress()`. The strip draws
  `.dr-qmark` per question; the toolbar shows `.dr-questions-button` ("问题 n/m", opens the section). The strip keeps
  tracking `readUpTo` even when it is hidden, while the questions module is on, and emits "questions" when the
  reached count changes. Pref `questions.hideAnswers` hides answers until reached.
- `session._autoGenerate()` writes the glossary / questions once per session for papers read before v0.9 and after
  every deep read (flags reset by `run()` / `clearResults()`); `blocks()` is the shared prompt input.
- Store: columns `questions`, `glossary` (migration loop in `Store.init`).
- e2e: `test/e2e/v09.js` (`E2E_PARSER=builtin`, so the demo paper's references are parsed from the PDF).

## v1.0: guided reading (带读) through the ③ Agent channel

Module `guided` (pref `view.guided`). Contract (JSON shape, enums, labels): `docs/GUIDE_SCHEMA.md`.

- **Stage A — the agent writes Markdown.** `session.runGuide()` by `agent.kind`:
  - codex / claude: `_runLocalAgent` → `AgentRunner.findSkills(agent.skills)` (SKILL.md under `~/agents/codex/skills`,
    `~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills`), `prepareWorkdir` under `<data dir>/deepread/agent/<key>/<time>/`
    with `paper.md` (`Guide.paperMarkdown`: paragraphs prefixed `[p. 3 ¶2]`), prompt `Guide.agentPrompt` (skill paths, PDF
    path, write `xray.md` + `paper-card.md`, print `DEEPREAD_DONE`), argv from `AgentRunner.buildArgv` (default templates;
    `agent.command` may carry `{prompt}` `{workdir}` `{skills}` or just the program words — missing template groups are
    appended), program resolved with `findExecutable` (PATH, ~/.local/bin, nvm, …). `AgentRunner.run` uses Gecko
    `Subprocess.call` without a shell, closes stdin, streams stdout+stderr into `guideRun.log`, kills on timeout
    (`agent.timeoutMin`) or cancel. `collect(workdir)` reads the two files.
  - api: `Guide.writeWithApi` with `prefs.agentApiConfig()` (agent.api.*, rest from the reading API) and the SKILL.md texts.
  - import: `pickGuideFile()` → `importGuide(path)` → `Guide.parseImported` (our JSON → used as is; Markdown → card / xray).
- **Stage B — structure.** `Guide.structure({ markdown, blocks })` with the reading API → guide JSON normalized against the
  paragraph keys (labels in text become keys). Stored as `papers.guide` = `{ …guide, markdown: { xray, card }, meta: { kind,
  skills, model, startedAt, finishedAt, source } }`. `guideRun` = `{ status: running | structuring | error, startedAt, log,
  error }` (not stored); a failed or cancelled run keeps the previous guide.
- **UI.** `DeepRead.GuidePanel` (per session) puts `.deepread-guide` (440 px) into `#primary-view`; while open
  `#primary-view.deepread-guide-open` hides the right rail. `DeepRead.GuideView.render(doc, host, state, actions)` draws the
  header, five tabs and the step body (pure view; `stepCounts`, label helpers). Toolbar `.dr-guide-button`. Cards get
  `.dr-guide-notes` from `session.guideNotesForKey(key)` (`Guide.notesForKey`: components, hedges, chain claims, key moves).
  `saveGuideNote()` → child note via `Guide.toNoteHTML`.
- Tests: `test/guide.test.mjs`, `test/agentRunner.test.mjs`, `test/guideView.test.mjs`; e2e `test/e2e/v10.js` runs
  `test/fake-agent.mjs` through the real Subprocess path (agent.command = `"<node>" "<repo>/test/fake-agent.mjs" --cd
  {workdir} {prompt}`), plus api / import / cancel / failure.
