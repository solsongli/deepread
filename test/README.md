# Offline test tooling

Run the whole DeepRead pipeline inside Zotero without real MinerU / LLM services. Node built-ins and Python 3 stdlib only.

## Self-contained reading fixtures

Current layout and reading-flow regressions generate their own small PDFs locally:

```bash
npm test
python3 -E test/build-reading-fixture.py
python3 -E test/build-continuation-fixture.py
python3 -E test/build-layout-fixture.py
E2E_SKIP_SERVICES=1 E2E_PDF="$PWD/test/fixtures/reading/paragraph-layout.pdf" scripts/e2e.sh test/e2e/translationLayout.js
```

These fixtures do not require a downloaded demo dataset. End-to-end tests use isolated profiles under
`.test-profile/`; run them sequentially. The historical full-pipeline fixture remains available below for
reference comparisons.

Reading comfort and question-pane regressions (no external service calls):

```bash
E2E_SKIP_SERVICES=1 E2E_PDF="$PWD/test/fixtures/reading/typography.pdf" scripts/e2e.sh test/e2e/readingComfort.js
E2E_SKIP_SERVICES=1 scripts/e2e.sh test/e2e/questionsPane.js
```

These exercise explicit card folding, per-paper focus mode, source navigation, bounded card scrolling,
keyboard/focus behavior, note and question drafts, IME input, failed requests, narrow layouts and dark mode.
The question pane uses a local session stub inside the real Zotero DOM; the card tests use an isolated PDF reader.

Revisit flags, responsive section navigation and hover lookup:

```bash
E2E_SKIP_SERVICES=1 E2E_PDF="$PWD/test/fixtures/reading/typography.pdf" scripts/e2e.sh test/e2e/readingIssues.js
E2E_SKIP_SERVICES=1 E2E_PDF="$PWD/test/fixtures/reading/continuations.pdf" scripts/e2e.sh test/e2e/structureBar.js
python3 -E test/build-lookup-fixture.py
E2E_SKIP_SERVICES=1 E2E_PDF="$PWD/test/fixtures/reading/lookup.pdf" scripts/e2e.sh test/e2e/lookupUX.js
```

These use local source data and fixed results; they do not measure real reader learning outcomes.

## 1. Legacy demo fixture (git-ignored output in `test/fixtures/demo/`)

```
python3 test/build-fixture.py
```

Needs `.port-src/vibero/demo-paper-vibedb.json` and `demo-paper.pdf`. Produces `demo_content_list.json`
(MinerU-style content list, 99 items / 13 pages), `full.md`, `demo-paper.pdf` (import this PDF into Zotero) and
`mineru-result.zip` (files at the zip root + `images/` with 1x1 JPEG placeholders).

## 2. Fake servers

```
node test/fake-mineru.mjs [--port 18765]
node test/fake-openai.mjs [--port 18766] [--no-json-schema] [--delay-ms N]
```

- fake-mineru: self-hosted `POST /file_parse` (returns the zip), `GET /docs`, `GET /openapi.json`; official v4 emulation
  (`POST /api/v4/file-urls/batch` needs `Authorization: Bearer test-token`, `PUT /upload/b1`,
  `GET /api/v4/extract-results/batch/b1` goes waiting-file -> pending -> running x2 -> done, `GET /zip/b1`).
  Poll counter resets whenever a new batch is requested.
- fake-openai: `POST /v1/chat/completions`, `GET /v1/models`. Recognises page summary, author filter, article summary and
  outline prompts (zh and en) and returns valid JSON; anything else is a short markdown answer containing `$E=mc^2$` and
  `(p. 2)` (SSE when `stream: true`). `--no-json-schema` answers 400 (mentioning `response_format`) to `json_schema`
  requests, to test the fallback; `--delay-ms` delays each response. One log line per request.

## 3. DeepRead settings

- LLM: base URL `http://127.0.0.1:18766/v1`, model `fake`, API key anything.
- Parser, self-hosted: provider `selfhost`, URL `http://127.0.0.1:18765`.
- Parser, official: provider `mineru`, `parser.mineruBaseURL=http://127.0.0.1:18765`, token `test-token`
  (any other token gets `{code:-10002,msg:"token invalid"}`).
- Use the demo PDF `test/fixtures/demo/demo-paper.pdf` as the Zotero attachment.
