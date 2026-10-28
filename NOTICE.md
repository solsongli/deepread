# NOTICE

## DeepRead

DeepRead is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE).

DeepRead is built on [Zotero](https://www.zotero.org/) (AGPL-3.0-or-later, Corporation for Digital Scholarship).

DeepRead contains code ported from **Vibero**, an AGPL-3.0 fork of Zotero, by its respective authors. Ported sections keep a
header note `Ported from Vibero (AGPL-3.0, a Zotero fork)`. DeepRead does not use Vibero's name, logo, or services, and
does not call any Vibero or Supabase endpoints.

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
