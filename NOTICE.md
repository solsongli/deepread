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

The facing-page view also ships three unmodified JavaScript files from the [RetainPDF v2026.11.22 release](https://github.com/wxyhgk/retain-pdf/releases/tag/v2026.11.22), commit `8bc2f61ebd900d091779405bb5746f8d681cc981`. Its [rendering-engine manifest](https://github.com/wxyhgk/retain-pdf/blob/8bc2f61ebd900d091779405bb5746f8d681cc981/backend/rendering-engine/UPSTREAM) pins `retain-pdf-rendering` to `f7f2f2edd48cf93902c4f6f11fd86ad6665067c9`. The files `src/text/linebreak.js`, `src/text/uax14-data.js` and `src/fit-model/rects.js` are packaged in `addon/content/lib/retainpdf/rendering/`. Copyright (c) 2026 SRT117, [MIT license](addon/content/lib/retainpdf/rendering/LICENSE). The line-breaking code and data use linebreak 1.1.0, Copyright (c) 2014-present Devon Govett, [MIT license](addon/content/lib/retainpdf/rendering/LICENSE-linebreak).

DeepRead supplies PDF.js page geometry, local font measurements, translated source units, protected graphics and the Zotero reading interface. Formula markup is rendered with the existing KaTeX library.

## Inline mathematics

The design of the facing-page reader draws on glyph-based formula detection and reinsertion in [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/0f0618d3303d064d97e7adb77557b21236c6cee0/pdf2zh/converter.py). DeepRead implements the grouping, source-coordinate matching, protected translation tokens and PDF.js canvas compositing in JavaScript for the Zotero reader.

## Vendored third-party libraries

Copies of these files are shipped inside the add-on under `addon/content/lib/`.

| Library | Version | License | Shipped paths |
|---------|---------|---------|---------------|
| [marked](https://github.com/markedjs/marked) | 18.0.14 | MIT | `addon/content/lib/marked/marked.js`, `addon/content/lib/marked/LICENSE` |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16.47 | MIT | `addon/content/lib/katex/katex.min.js`, `katex.min.css`, `auto-render.min.js`, `fonts/*.woff2`, `LICENSE` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | `addon/content/lib/pdf-lib/pdf-lib.min.js`, `LICENSE`, `licenses/` |

pdf-lib collects the pages printed by Gecko and preserves their physical dimensions. The distribution includes the notices for pdf-lib and its bundled standard-fonts, UPNG, pako and tslib packages. See the [bundled notices](addon/content/lib/pdf-lib/licenses).
