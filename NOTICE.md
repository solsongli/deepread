# NOTICE

## DeepRead

DeepRead is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE).

DeepRead is built on [Zotero](https://www.zotero.org/) (AGPL-3.0-or-later, Corporation for Digital Scholarship).

DeepRead is maintained as a separate plugin for official Zotero. Its current features and integrations are developed
in this repository. Independent maintenance does not change the provenance of retained upstream code.

## Vibero-derived pipeline code

DeepRead contains code ported from **Vibero**, an AGPL-3.0 fork of Zotero, by its respective authors. The following
files retain upstream implementations alongside DeepRead modifications:

| File | Retained origin and subsequent work |
| --- | --- |
| `addon/content/scripts/pipeline/pipeline.js` | Reader pipeline, coordinate helpers and prompt-processing methods; extended with DeepRead adapters, translation structure and continuation handling. |
| `addon/content/scripts/pipeline/summaryManager.js` | Summary data management; extended with page geometry and translation metadata. |
| `addon/content/scripts/pipeline/languages.js` | Language-option constants; the language-detection heuristic is implemented locally. |
| `addon/content/scripts/pipeline/responseFormats.js` | Response-schema builders; extended with importance levels and layout translations. |

Their `Ported from Vibero` headers and AGPL notices remain in place. Reader presentation files also retain their
existing design acknowledgements. The original integration record is in `docs/PIPELINE_PORT.md`; it records
provenance and does not describe every feature added since that integration.

DeepRead uses its own product name and interface branding. It does not call Vibero or Supabase service endpoints.

## RetainPDF layout rules

`addon/content/scripts/services/translationLayout.js` adapts list-marker recognition and source-line indentation
estimation from [wxyhgk/retain-pdf](https://github.com/wxyhgk/retain-pdf), commit
`a665c2aea2cd0860c737e7f9685d8071fbef1b3a`, particularly
`backend/pipeline/retainpdf_pipeline/render/layout/payload/first_line_indent.py` and `line_structure.py`.
These parts are MIT-licensed, Copyright (c) 2026 RetainPDF contributors. The full license is shipped in
[`addon/content/lib/retainpdf/LICENSE`](addon/content/lib/retainpdf/LICENSE).
DeepRead's fixed translation-unit protocol and Zotero DOM renderer are implemented in this plugin.

## Vendored third-party libraries

Copies of these files are shipped inside the add-on under `addon/content/lib/`.

| Library | Version | License | Shipped paths |
|---------|---------|---------|---------------|
| [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT | `addon/content/lib/marked/marked.js`, `addon/content/lib/marked/LICENSE` |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.47 | MIT | `addon/content/lib/katex/katex.min.js`, `katex.min.css`, `auto-render.min.js`, `fonts/*.woff2`, `LICENSE` |

All vendored libraries are MIT-licensed; their full license texts are included in the respective `LICENSE*` files.
