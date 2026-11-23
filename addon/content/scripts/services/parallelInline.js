/* Protect physical inline math, quantities and source styles in facing-page translation.
 * DeepRead implementation; design reference: PDFMathTranslate's glyph grouping / placeholders.
 * License: AGPL-3.0-or-later */
(function () {
  const value = (c) => String(c.u ?? c.c ?? "");
  const mathFont = (name) =>
    /CMMI|CMSY|CMEX|MS[AB]M|rsfs|txsy|wasy|stmary|math|symbol|StandardSym/i.test(name || "");
  const isHan = (lang) => /^zh(?:-|$)/i.test(lang);
  const texPattern = /(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)|\\\([^\n]+?\\\)/gu;
  const letters = (text) =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");

  // MinerU may spell εθ as $\varepsilon_\theta$. Exact surrounding prose and
  // a bounded, unambiguous gap identify the corresponding original glyphs.
  function alignOCR(chars, source) {
    const maths = [...source.matchAll(texPattern)];
    if (!maths.length || !chars.length) return null;
    let hay = "",
      end = 0;
    const owners = [],
      anchors = [];
    for (const [i, c] of chars.entries()) {
      const word = letters(value(c));
      hay += word;
      for (let j = 0; j < word.length; j++) owners.push(i);
    }
    for (const m of maths) {
      anchors.push(letters(source.slice(end, m.index)));
      end = m.index + m[0].length;
    }
    anchors.push(letters(source.slice(end)));
    if (anchors.join("").length < 8 || !hay.startsWith(anchors[0]) || !hay.endsWith(anchors.at(-1))) return null;
    let at = anchors[0].length;
    const ranges = new Map();
    for (let i = 0; i < maths.length; i++) {
      const next = anchors[i + 1],
        last = i === maths.length - 1;
      if (!last && !next) return null;
      const pos = last ? hay.length - next.length : hay.indexOf(next, at);
      if (
        pos < at ||
        (!last && hay.indexOf(next, pos + 1) >= 0) ||
        pos - at > Math.max(12, maths[i][0].length * 2)
      )
        return null;
      let a = at ? owners[at - 1] + 1 : 0,
        b = pos < hay.length ? owners[pos] : chars.length;
      while (a < b && /^[\s,.;:]+$/u.test(value(chars[a]))) a++;
      while (b > a && /^[\s,.;:]+$/u.test(value(chars[b - 1]))) b--;
      if (b <= a || chars.slice(a, b - 1).some((c) => c.lineBreakAfter || c.paragraphBreakAfter)) return null;
      // A loose MinerU box can contain a label or unrelated prose in the gap.
      // Only accept alphabetic words when the corresponding TeX spells them out.
      const gap = glyphStream(chars.slice(a, b)).text;
      const words = gap.match(/[A-Za-z]{3,}/g) || [];
      if (words.some((word) => !maths[i][0].toLowerCase().includes(word.toLowerCase()))) return null;
      const group = { tex: maths[i][0] };
      for (let k = a; k < b; k++) ranges.set(chars[k], group);
      at = pos + next.length;
    }
    return ranges;
  }

  function glyphStream(chars) {
    const offsets = [],
      map = [];
    let text = "";
    chars.forEach((c, i) => {
      const v = value(c);
      const start = text.length;
      text += v;
      offsets.push([start, text.length]);
      if ((c.spaceAfter || c.lineBreakAfter || c.paragraphBreakAfter) && !/\s$/u.test(text)) text += " ";
      while (map.length < text.length) map.push(i);
    });
    return { text, offsets, map };
  }

  // Only isolated styled Latin letters are candidates. An italic word in prose is
  // translated as emphasis, while e.g. italic k or bold x with a superscript travels as a unit.
  function mathRuns(chars, stream, size, ocr, reserved) {
    const offsets = stream.offsets,
      text = stream.text,
      roles = [];
    const word = (s) => /[A-Za-z]/.test(s || "");
    // Small capitals share their baseline with the preceding full-size letter.
    // Superscripts and subscripts shift off that baseline.
    let bodyBaseline;
    const operators = new Set();
    for (const m of text.matchAll(
      /\b(?:log|ln|exp|sin|cos|tan|min|max|argmin|argmax)(?=\s*(?:[A-Za-z]\s*)?\()/gu
    )) {
      for (let j = m.index; j < m.index + m[0].length; j++) operators.add(stream.map[j]);
    }
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i],
        v = value(c),
        [a, b] = offsets[i];
      if (!i || chars[i - 1].lineBreakAfter || chars[i - 1].paragraphBreakAfter) bodyBaseline = undefined;
      if (c.fontSize >= size * 0.85 && Number.isFinite(c.baseline)) bodyBaseline = c.baseline;
      if (reserved.some((span) => a < span.end && b > span.start)) {
        roles.push({ seed: false, eligible: false });
        continue;
      }
      const script =
        c.fontSize > 0 &&
        c.fontSize < 0.82 * size &&
        (!Number.isFinite(bodyBaseline) ||
          !Number.isFinite(c.baseline) ||
          Math.abs(c.baseline - bodyBaseline) > size * 0.07);
      const scriptOrAccent = (neighbour) =>
        neighbour &&
        (neighbour.fontSize < size * 0.82 ||
          (mathFont(neighbour.fontName) &&
            neighbour.rect &&
            c.rect &&
            Math.min(neighbour.rect[2], c.rect[2]) - Math.max(neighbour.rect[0], c.rect[0]) > size * 0.1));
      const single =
        /^[A-Za-z]$/.test(v) &&
        (!word(text[a - 1]) || scriptOrAccent(chars[i - 1])) &&
        (!word(text[b]) || scriptOrAccent(chars[i + 1]));
      const seed =
        operators.has(i) ||
        ocr?.has(c) ||
        (!/^[•‣◦▪●\s]*$/u.test(v) &&
          (mathFont(c.fontName) ||
            /[\p{Sm}\p{Script=Greek}]/u.test(v) ||
            (single && (DeepRead.Typography.italic(c) || DeepRead.Typography.bold(c))) ||
            script));
      roles.push({ seed, eligible: seed || single || /^[\d\s()[\]{},.:;!+−–=^_×÷*\/…]+$/u.test(v) });
    }
    const found = [];
    for (let i = 0; i < chars.length; ) {
      if (!roles[i].eligible) {
        i++;
        continue;
      }
      let j = i + 1;
      while (
        j < chars.length &&
        roles[j].eligible &&
        !chars[j - 1].lineBreakAfter &&
        !chars[j - 1].paragraphBreakAfter &&
        ocr?.get(chars[i]) === ocr?.get(chars[j]) &&
        chars[j].rect &&
        chars[j - 1].rect &&
        chars[j].rect[0] - chars[j - 1].rect[2] < size * 1.08
      )
        j++;
      let a = i,
        b = j;
      while (a < b && /^[\s.,:;!]+$/u.test(value(chars[a]))) a++;
      while (b > a && /^[\s.,:;!]+$/u.test(value(chars[b - 1]))) b--;
      // An unstyled article next to a variable is prose; a delimiter belongs to the expression.
      if (b - a > 1 && !roles[a].seed && /^[aAI]$/.test(value(chars[a])) && chars[a].spaceAfter) a++;
      if (b - a > 1 && !roles[b - 1].seed && /^[aAI]$/.test(value(chars[b - 1])) && chars[b - 2].spaceAfter) b--;
      if (a < b && roles.slice(a, b).some((r) => r.seed)) {
        const run = chars.slice(a, b),
          rect = DeepRead.Overlay.unionRect(run.map((c) => c.rect).filter(Boolean));
        if (rect) {
          const body = run.filter((c) => c.fontSize >= size * 0.84 && Number.isFinite(c.baseline));
          const base =
            body[0]?.baseline ?? run.find((c) => Number.isFinite(c.baseline))?.baseline ?? rect[1] + size * 0.2;
          const clip = rect.slice();
          // Delimiters such as TeX's tall parentheses may be drawn by paths or lack
          // Unicode. Include the ink in the gap, stopping before neighbouring prose.
          const prev = chars[a - 1],
            next = chars[b];
          const left = prev?.rect && !prev.lineBreakAfter ? prev.rect[2] + size * 0.035 : rect[0] - size * 0.12;
          const right =
            next?.rect && !run.at(-1).lineBreakAfter ? next.rect[0] - size * 0.035 : rect[2] + size * 0.12;
          clip[0] = Math.min(rect[0], Math.max(rect[0] - size * 0.8, left));
          clip[2] = Math.max(rect[2], Math.min(rect[2] + size * 0.8, right));
          clip[1] -= size * 0.1;
          clip[3] += size * 0.1;
          let label = "",
            script = "";
          for (const c of run) {
            const position =
              c.fontSize < size * 0.83 && c.baseline > base + size * 0.12
                ? "^"
                : c.fontSize < size * 0.83 && c.baseline < base - size * 0.06
                  ? "_"
                  : "";
            if (position !== script) {
              if (script) label += "}";
              if (position) label += position + "{";
              script = position;
            }
            label += value(c);
          }
          if (script) label += "}";
          found.push({
            start: offsets[a][0],
            end: offsets[b - 1][1],
            kind: "math",
            display: ocr?.get(chars[a])?.tex || label,
            rect,
            clip,
            baseline: base
          });
        }
      }
      i = j;
    }
    return found;
  }

  const comparisons = {
    "less than": "小于",
    "smaller than": "小于",
    "lower than": "低于",
    "greater than": "大于",
    "larger than": "大于",
    "higher than": "高于",
    "at least": "至少为",
    "at most": "至多为",
    "no more than": "不超过",
    "no less than": "不低于"
  };
  const terms = { "negative sampling": "负采样", "positive sampling": "正采样" };
  function chinese(text, language) {
    if (language !== "zh-TW") return text;
    const traditional = { 于: "於", 过: "過", 为: "為", 负: "負", 采: "採", 样: "樣", 严: "嚴" };
    return text.replace(/[于过为负采样严]/gu, (ch) => traditional[ch]);
  }
  const greek = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ε",
    varepsilon: "ε",
    zeta: "ζ",
    eta: "η",
    theta: "θ",
    kappa: "κ",
    lambda: "λ",
    mu: "μ",
    nu: "ν",
    xi: "ξ",
    pi: "π",
    rho: "ρ",
    sigma: "σ",
    tau: "τ",
    phi: "φ",
    psi: "ψ",
    omega: "ω"
  };
  function variable(s) {
    const inner = s.replace(/^\$|\$$|^\\\(|\\\)$/gu, "").trim();
    if ([...inner].length === 1) return inner;
    const name = inner.replace(/^\\/u, "");
    const letter = greek[name.toLowerCase()];
    return letter && (name[0] === name[0].toUpperCase() ? letter.toUpperCase() : letter);
  }
  function describe(glyphs, source, fallbackStyle, size, language, ocr) {
    const stream = glyphStream(glyphs),
      text = glyphs.length ? stream.text : fallbackStyle || source;
    const spans = [];
    const add = (start, end, kind, display, more = {}) => {
      if (spans.some((s) => start < s.end && s.start < end)) return false;
      spans.push({ start, end, kind, display, ...more });
      return true;
    };
    for (const m of text.matchAll(/⟦D+\d+⟧/gu)) add(m.index, m.index + m[0].length, "literal", m[0]);
    const roman = /^[IVXLCDM]+\.(?=\s+\p{Lu})/u.exec(text);
    if (roman) add(0, roman[0].length, "section", roman[0]);
    if (isHan(language)) {
      const relation =
        /(?<![\p{L}\p{N}_])(\$\s*(?:\\[a-z]+|[A-Za-z\p{Script=Greek}])\s*\$|\\\(\s*(?:\\[a-z]+|[A-Za-z\p{Script=Greek}])\s*\\\)|[\p{Script=Greek}A-Za-z])\s+(?:(?:is|was|are|were)\s+)?(?:(slightly|strictly)\s+)?(no more than|no less than|greater than|larger than|higher than|less than|smaller than|lower than|at least|at most)\s+([+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+−-]?\d+)?(?:%|‰)?)(?![\p{L}\p{N}.]\d|\p{L})/giu;
      for (const m of text.matchAll(relation)) {
        const symbol = variable(m[1]);
        if (!symbol) continue;
        const qualifier = { slightly: "略", strictly: "严格" }[m[2]?.toLowerCase()] || "";
        add(
          m.index,
          m.index + m[0].length,
          "relation",
          chinese(symbol + " " + qualifier + comparisons[m[3].toLowerCase()] + " " + m[4], language)
        );
      }
      for (const m of text.matchAll(/\b(?:negative|positive)\s+sampling\b/gi)) {
        const name = m[0].toLowerCase().replace(/\s+/g, " ");
        add(m.index, m.index + m[0].length, "term", chinese(terms[name], language));
      }
    }
    // Complete URLs, citations and OCR LaTeX are indivisible before individual numbers.
    for (const m of text.matchAll(
      /https?:\/\/[^\s<>]+|(?:[\w-]+\.)+(?:\s+)?(?:[\w-]+\.)*(?:edu|org|com|net|io)(?:\/[\w./%+-]*)?/gi
    )) {
      const url = m[0].replace(/[.,;:!?)]+$/u, "");
      add(m.index, m.index + url.length, "url", url.replace(/\s+/g, ""));
    }
    for (const m of text.matchAll(texPattern)) add(m.index, m.index + m[0].length, "tex", m[0]);
    for (const m of text.matchAll(
      /\b[A-Z][\p{L}’'-]+(?:\s+et\s+al\.|\s+(?:and|&)\s+[A-Z][\p{L}’'-]+)\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)|\[(?:\d+(?:\s*[,–-]\s*\d+)*)\]/gu
    ))
      add(m.index, m.index + m[0].length, "citation", m[0].replace(/\s+/g, " "));
    for (const m of mathRuns(glyphs, stream, size, ocr, spans)) add(m.start, m.end, "math", m.display, m);
    if (!glyphs.length)
      for (const m of text.matchAll(
        /[\p{Script=Greek}](?:[_^](?:\{[^{}\n]{1,40}\}|[\p{L}\d]))*|\b[A-Za-z](?:[_^](?:\{[^{}\n]{1,40}\}|[\p{L}\d]))+/gu
      ))
        add(m.index, m.index + m[0].length, "literal", m[0]);
    for (const m of text.matchAll(
      /(?<![\p{L}\p{N}_])(?:[+−-])?(?:\d+(?:[.,]\d+)*|\.\d+)(?:[eE][+−-]?\d+)?(?:\s?(?:[%‰°]|[kMG]?Hz\b|[kμµmunp]?m(?:\/[munµμ]?s(?:[²³])?)?\b[²³]?|[munµμ]?s\b|[mk]?g\b|DoF\b))?/gu
    ))
      add(m.index, m.index + m[0].length, "number", m[0]);
    spans.sort((a, b) => a.start - b.start);
    const styled = (a, b) =>
      glyphs.length
        ? DeepRead.Typography.styledSentence(
            { text: text.slice(a, b), charMapping: stream.map.slice(a, b) },
            glyphs
          )
        : text.slice(a, b);
    const tidy = (s) => s.replace(/\s+/gu, " ").trim();
    const sourceStyled = glyphs.length ? tidy(styled(0, text.length)) : fallbackStyle || source;
    let prefix = "D";
    while (text.includes(`⟦${prefix}`)) prefix += "D";
    let last = 0,
      modelText = "";
    spans.forEach((s, i) => {
      s.id = `⟦${prefix}${i}⟧`;
      s.source = tidy(text.slice(s.start, s.end));
      const owned = glyphs.length
        ? glyphs.slice(stream.map[s.start], stream.map[s.end - 1] + 1).filter((c) => value(c).trim())
        : [];
      s.bold = owned.length > 0 && owned.every(DeepRead.Typography.bold);
      s.italic = owned.length > 0 && owned.every(DeepRead.Typography.italic);
      if (!s.rect && owned.length) s.rect = DeepRead.Overlay.unionRect(owned.map((c) => c.rect).filter(Boolean));
      if (s.kind !== "math" && owned.length)
        s.samples = owned
          .filter((c) => c.rect)
          .slice(0, 8)
          .map((c) => c.rect);
      modelText += styled(last, s.start) + s.id;
      last = s.end;
    });
    modelText = spans.length ? tidy(modelText + styled(last, text.length)) : sourceStyled;
    return { tokens: spans, modelText, styled: sourceStyled };
  }

  const pattern = /⟦D+\d+⟧/gu;
  function valid(unit, text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const actual = text.match(pattern) || [],
      expected = unit.tokens || [];
    if (actual.length !== expected.length || !expected.every((s) => actual.includes(s.id))) return false;
    if (
      actual.length &&
      /(?:\$[^$\n]*⟦D+\d+⟧[^$\n]*\$|<[^>]*⟦D+\d+⟧[^>]*>|`[^`]*⟦D+\d+⟧[^`]*`|\\\([^)]*⟦D+\d+⟧[^)]*\\\))/u.test(text)
    )
      return false;
    const unlocked = text.replace(pattern, " ");
    if (
      expected.some((s) => s.kind === "relation") &&
      /(?:[大小低高][于於]|超[过過]|至少|至多|[<>≤≥])\s*[-+−]?\d/u.test(unlocked)
    )
      return false;
    if (expected.some((s) => s.kind === "number" && /[%‰]/u.test(s.display)) && /\d\s*[%‰％]/u.test(unlocked))
      return false;
    // Count ordinary emphasis after protected literals and complete-heading styles are handled.
    if (unit.modelText && !unit.title) {
      const counts = (s) => {
        const result = { bold: 0, italic: 0 };
        for (const m of s.matchAll(/(?<!\*)(\*{1,3})(?!\*)([^*\n]+?)\1(?!\*)/gu)) {
          if (m[1].length >= 2) result.bold++;
          if (m[1].length !== 2) result.italic++;
        }
        return result;
      };
      const wanted = counts(unit.modelText),
        got = counts(text);
      if (got.italic < wanted.italic || got.bold < wanted.bold) return false;
      if (
        /^(?:[•‣◦▪●]\s*)?\*\*[^*]+\*\*\s*\p{L}/u.test(unit.modelText) &&
        !/^\*\*[^*]+\*\*[\s\S]*\p{L}/u.test(text)
      )
        return false;
    }
    return true;
  }

  function fromLegacy(unit, translation) {
    if (!translation) return "";
    if (translation.match(pattern)?.length) return "";
    if (valid(unit, translation)) return translation;
    for (const s of unit.tokens || []) {
      if (s.kind === "math") return ""; // Old flattened math does not encode exponent ownership.
      const occupied = [...translation.matchAll(pattern)];
      let at = translation.indexOf(s.display);
      while (at >= 0) {
        const end = at + s.display.length;
        const insideToken = occupied.some((m) => at < m.index + m[0].length && end > m.index);
        const partialNumber =
          s.kind === "number" &&
          (/[+\d−-]/u.test(translation[at - 1] || "") ||
            /^(?:\d|[.%‰％]\d|[%‰％]|[eE][+−-]?\d)/u.test(translation.slice(end)));
        if (!insideToken && !partialNumber) break;
        at = translation.indexOf(s.display, at + 1);
      }
      if (at < 0) return "";
      translation = translation.slice(0, at) + s.id + translation.slice(at + s.display.length);
    }
    return valid(unit, translation) ? translation : "";
  }
  DeepRead.ParallelInline = { describe, valid, fromLegacy, alignOCR };
})();
