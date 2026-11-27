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

## Typefaces for translated papers

The local print fonts in `addon/content/lib/paper-fonts/` are distributed under the SIL Open Font License 1.1. These fonts are loaded in the reader and the print frame.

- DeepRead Song is derived from Google’s Noto Serif SC, version 2.003. It includes the 6,763 GB 2312 ideographs and Chinese punctuation. The two static faces are set at weights 450 and 680 for body text and bold emphasis. Other characters fall through to fonts installed on the reader’s computer. [Upstream font and license](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifsc) · [Bundled license](addon/content/lib/paper-fonts/Noto-OFL.txt).
- DeepRead Hei is derived from Noto Sans SC, version 2.004, with static weights 400 and 700. It includes GB 2312 ideographs, Chinese punctuation and Latin letters. [Upstream font and license](https://github.com/google/fonts/tree/2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc) · [Bundled license](addon/content/lib/paper-fonts/NotoSans-OFL.txt).
- DeepRead Roman contains four static instances derived from STIX Two Text by the STIX Fonts Project Authors. It supplies text and italic faces at weight 400 and the corresponding bold faces at weight 700. [Upstream font and license](https://github.com/google/fonts/tree/718c7ee0e83f5e301cc96bbc081c9bb5ade9ed92/ofl/stixtwotext) · [Bundled license](addon/content/lib/paper-fonts/STIX-OFL.txt).

To reproduce the WOFF2 files, place the four pinned variable fonts in one directory as `NotoSerifSC.ttf`, `NotoSansSC.ttf`, `STIXTwoText.ttf` and `STIXTwoText-Italic.ttf`. Run `python3 scripts/build-paper-fonts.py DIRECTORY` with fontTools and Brotli installed. The script verifies the input checksums. System fonts supply characters outside these subsets and traditional Chinese.

## Local figure-label OCR

DeepRead uses the portable LSTM build of Tesseract.js-core 6.1.2 to read printed English plot labels on the user's computer. The worker receives only the local figure crop. [Upstream release](https://github.com/naptha/tesseract.js-core/tree/3d12e9b2d4e0e9e64bd0793e2c55b2d8f6404884) · [Apache 2.0 license](addon/content/lib/figure-ocr/LICENSE).

The bundled English weights come from the Tesseract project's tessdata_fast repository. The SHA-256 of `eng.traineddata` is `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`. The core includes Tesseract, Leptonica and its image codecs. This software is based in part on the work of the Independent JPEG Group. [English model revision](https://github.com/tesseract-ocr/tessdata_fast/blob/923915d4ced2a7235221788285785a29c4a42d4a/eng.traineddata) · [Model and component notices](addon/content/lib/figure-ocr/licenses).
