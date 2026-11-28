/* Protect physical inline math, quantities and source styles in facing-page translation.
 * DeepRead implementation; design reference: PDFMathTranslate's glyph grouping / placeholders.
 * License: AGPL-3.0-or-later */
(function () {
  const value = (c) => String(c.u ?? c.c ?? "");
  const mathFont = (name) =>
    /CMMI|CMSY|CMEX|MS[AB]M|rsfs|txsy|wasy|stmary|math|symbol|StandardSym/i.test(name || "");
  const isHan = (lang) => /^zh(?:-|$)/i.test(lang);
  // Shift the decimal point without rounding exact counts or dropping the
  // written precision of a quantity such as “3.30 billion”.
  function chineseCount(coefficient, unit, language) {
    const sign = coefficient.match(/^[+−-]/u)?.[0] || "";
    const [whole, fraction = ""] = coefficient.slice(sign.length).replace(/,/gu, "").split(".");
    const digits = whole + fraction;
    const first = digits.search(/[1-9]/u);
    if (first < 0 && !fraction) return sign + "0";
    const exponent = {million:6,billion:9,trillion:12}[unit.toLowerCase()];
    const places = first < 0 ? exponent + 1 : whole.length + exponent - first;
    const scale = places > 12 ? 12 : places > 8 ? 8 : places > 4 ? 4 : 0;
    const point = whole.length + exponent - scale;
    const integer = (digits.slice(0,point).padEnd(point,"0") || "0").replace(/^0+(?=\d)/u,"");
    let decimals = digits.slice(point);
    if (!fraction) decimals = decimals.replace(/0+$/u,"");
    let suffix = {0:"",4:"万",8:"亿",12:"万亿"}[scale];
    if (/^zh-(?:TW|Hant|HK|MO)/iu.test(language)) suffix = suffix.replace("万","萬").replace("亿","億");
    return sign + integer + (decimals ? "." + decimals : "") + suffix;
  }
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

  // A final metadata field can share a parser paragraph with the preceding
  // prose. Identify its printed label separately from its URL annotation.
  function urlFieldLabel(chars, stream, span) {
    if (!/^[.。]?$/u.test(stream.text.slice(span.end).trim())) return;
    const urlAt = stream.map[span.start], urlGlyph = chars[urlAt];
    if (!urlGlyph?.rect) return;
    let first = urlAt;
    while (first > 0) {
      const prev = chars[first-1];
      if (prev.lineBreakAfter || prev.paragraphBreakAfter ||
          Math.abs(prev.baseline-urlGlyph.baseline) > urlGlyph.fontSize*.5) break;
      first--;
    }
    const start = stream.offsets[first][0];
    const label = stream.text.slice(start,span.start).trim();
    if (!/^[\p{L}][\p{L}\p{N} &/_.-]{0,40}[:：]$/u.test(label)) return;
    const preceding = stream.text.slice(0,start).trimEnd();
    if (preceding && !/[.!?。！？]$/u.test(preceding)) return;
    const samples = chars.slice(first,urlAt).filter(c=>c.rect && value(c).trim()).map(c=>c.rect);
    if (samples.length) return {samples,startsLine:!!preceding};
  }

  // Only isolated styled Latin letters are candidates. An italic word in prose is
  // translated as emphasis, while e.g. italic k or bold x with a superscript travels as a unit.
  function mathRuns(chars, stream, size, ocr, reserved) {
    const offsets = stream.offsets,
      text = stream.text,
      roles = [];
    const word = (i) =>
      /\p{Script=Latin}/u.test(text[i] || "") ||
      (/['’]/u.test(text[i] || "") &&
        /\p{Script=Latin}/u.test(text[i - 1] || "") &&
        /\p{Script=Latin}/u.test(text[i + 1] || ""));
    // Small capitals share their baseline with the preceding full-size letter.
    // Superscripts and subscripts shift off that baseline.
    const baselines = [];
    for (let a = 0; a < chars.length; ) {
      let b = a + 1;
      while (b < chars.length && !chars[b - 1].lineBreakAfter && !chars[b - 1].paragraphBreakAfter) b++;
      const line = chars.slice(a, b),
        full = line.filter((c) => c.fontSize >= size * 0.85 && Number.isFinite(c.baseline));
      const values = (full.length ? full : line)
        .map((c) => c.baseline)
        .filter(Number.isFinite)
        .sort((x, y) => x - y);
      const value = values[Math.floor(values.length / 2)];
      for (let i = a; i < b; i++) baselines[i] = value;
      a = b;
    }
    const operators = new Set();
    for (const m of text.matchAll(/\b(?:log|ln|exp|sinh?|cosh?|tanh?|min|max|argmin|argmax)(?=\s*(?:[A-Za-z]\s*)?\()/gu)) {
      const end = m.index + m[0].length;
      if (/[A-Za-z]/u.test(text[end] || "")) {
        // PDF extraction may join log and its subscript k as “logk(n)”.
        // Without a word boundary, require evidence of a separate variable.
        // Plain “sink (76 rounds)” and “cost (He et al.)” are whole words.
        const name = chars[stream.map[end-1]], operand = chars[stream.map[end]];
        const subscript = operand.fontSize < name.fontSize*.9 &&
          Math.abs(operand.baseline-name.baseline)>size*.07;
        if (!(ocr?.has(operand) || mathFont(operand.fontName) || subscript ||
              (operand.fontName!==name.fontName && DeepRead.Typography.italic(operand)))) continue;
      }
      for (let j = m.index; j < m.index + m[0].length; j++) operators.add(stream.map[j]);
    }
    // A dimensional adjective starts prose after an inline expression, e.g.
    // "in I_t, a 2D point tracker". Keep it available to the translator.
    const prose = new Set();
    for (const part of text.matchAll(/,\s+(?:a|an)\s+[23][dD](?=\s+[a-z]{2})/gu))
      for (let j=part.index+1;j<part.index+part[0].length;j++) prose.add(stream.map[j]);
    // “A_t. b) In the CNN ...” starts the next figure panel after a
    // formula. Its panel letter is independent of the preceding indices.
    for (const label of text.matchAll(/(?:^|[.!?])\s*[a-z]\)(?=\s+\p{Lu})/gu)) {
      const end=label.index+label[0].length;
      for (let j=end-2;j<end;j++) if (!ocr?.has(chars[stream.map[j]])) prose.add(stream.map[j]);
    }
    // Publishers commonly italicize e.g. and i.e. Their two isolated
    // letters would otherwise seed a formula and swallow the opening bracket.
    for (const abbreviation of text.matchAll(/(?:\(\s*)?\b(?:e\.\s*g|i\.\s*e)\.(?=[,;:)\s]|$),?/giu)) {
      const end = abbreviation.index + abbreviation[0].length;
      for (let j = abbreviation.index; j < end; j++) {
        if (!ocr?.has(chars[stream.map[j]])) prose.add(stream.map[j]);
      }
    }
    // A caption can use smaller type for its prose than for a formula base.
    // Baseline-aligned small capitals remain ordinary text.
    const indexGlyph = (glyph, baseline, baseEm = size) => {
      const measured = Number.isFinite(baseline) && Number.isFinite(glyph.baseline);
      return glyph.fontSize > 0 && glyph.fontSize < .82 * (measured ? baseEm : size) &&
        (!measured || Math.abs(glyph.baseline-baseline) > size*.07);
    };
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i],
        v = value(c),
        [a, b] = offsets[i];
      const bodyBaseline = baselines[i];
      if (prose.has(i) || reserved.some((span) => a < span.end && b > span.start)) {
        roles.push({ seed: false, eligible: false });
        continue;
      }
      if (/^s$/i.test(v) && /['’]/u.test(text[a - 1] || "") && !ocr?.has(c)) {
        roles.push({ seed: false, eligible: false });
        continue;
      }
      const followsA = /^[Aa]$/u.test(v) && /^(\s+)([A-Za-z][A-Za-z0-9-]+|[23]D)\b/u.exec(text.slice(b, b + 80));
      const nextWord = followsA && chars[stream.map[b + followsA[1].length]];
      // Raster labels can be separate physical rows ending mid-sentence,
      // e.g. “This is a” / “panoramic scene”. Keep the unfinished article
      // available to the translator just like an article followed by a noun.
      const trailingArticle = v === "a" && !text.slice(b).trim() &&
        /\b(?:is|was|as|with|using|creating|forming|building|constructing)\s+$/iu.test(text.slice(Math.max(0,a-22),a)) &&
        c.fontName === chars[stream.map[text.slice(0,a).trimEnd().length - 1]]?.fontName;
      const article = trailingArticle || followsA && (
        !a || /(?:^|[:.!?])\s*$/u.test(text.slice(Math.max(0, a - 4), a)) ||
        (nextWord?.fontName === c.fontName && !/^(?:is|was|denotes?|equals?|represents?|varies|takes?|and|or|in|of|to)$/iu.test(followsA[2]))
      );
      const wordPrefix = /^[A-Za-z]$/.test(v) && /^[-‐‑]\p{L}{2}/u.test(text.slice(b, b + 12));
      if ((article || wordPrefix) && !mathFont(c.fontName) && !ocr?.has(c)) {
        roles.push({ seed: false, eligible: false });
        continue;
      }
      let baseEm = size;
      if (c.fontSize >= .82*size && c.fontSize < .9*size && Number.isFinite(bodyBaseline) &&
          Math.abs(c.baseline-bodyBaseline) > size*.07 && c.rect) {
        // Sub- and superscripts can have the same x. Check one glyph farther
        // back for their common base before assigning the second index.
        for (const base of chars.slice(Math.max(0,i-2),i)) {
          if (base.rect && /^[A-Za-z\p{Script=Greek}]$/u.test(value(base)) &&
              Math.abs(base.baseline-bodyBaseline) < size*.07 &&
              Math.abs(c.rect[0]-base.rect[2]) < size*.4) baseEm=Math.max(baseEm,base.fontSize);
        }
      }
      const script = indexGlyph(c,bodyBaseline,baseEm);
      const scriptOrAccent = (neighbour) =>
        neighbour &&
        (indexGlyph(neighbour,c.baseline,Math.max(size,c.fontSize)) ||
          (mathFont(neighbour.fontName) &&
            neighbour.rect &&
            c.rect &&
            Math.min(neighbour.rect[2], c.rect[2]) - Math.max(neighbour.rect[0], c.rect[0]) > size * 0.1));
      const single =
        /^[A-Za-z]$/.test(v) &&
        (!word(a - 1) || scriptOrAccent(chars[i - 1])) &&
        (!word(b) || scriptOrAccent(chars[i + 1]));
      const seed =
        operators.has(i) ||
        ocr?.has(c) ||
        (!/^[•‣◦▪●\s]*$/u.test(v) &&
          (mathFont(c.fontName) ||
            /[\p{Sm}\p{Script=Greek}]/u.test(v) ||
            (single && (DeepRead.Typography.italic(c) || DeepRead.Typography.bold(c))) ||
            script));
      roles.push({ seed, script, eligible: seed || single || /^[\d\s()[\]{},.:;!+−–=^_×÷*\/…]+$/u.test(v) });
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
      // The closing bracket in "(vs. 53% for π₀.₅)" belongs to the
      // surrounding comparison, and must move with the translated prose.
      if (b > a && /^[)\]]$/u.test(value(chars[b - 1])) && !ocr?.has(chars[b - 1]) &&
          !chars.slice(a, b - 1).some(c => /[(\[]/u.test(value(c)))) b--;
      // An unstyled article next to a variable is prose; a delimiter belongs to the expression.
      if (b - a > 1 && !roles[a].seed && /^[aAI]$/.test(value(chars[a])) && chars[a].spaceAfter) a++;
      if (b - a > 1 && !roles[b - 1].seed && /^[aAI]$/.test(value(chars[b - 1])) && chars[b - 2].spaceAfter) b--;
      if (a < b && roles.slice(a, b).some((r) => r.seed)) {
        const run = chars.slice(a, b),
          rect = DeepRead.Overlay.unionRect(run.map((c) => c.rect).filter(Boolean));
        if (rect) {
          const body = run.filter((c,k) => !roles[a+k].script && Number.isFinite(c.baseline));
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
          for (const [k,c] of run.entries()) {
            const position =
              roles[a+k].script && c.baseline > base + size * 0.12
                ? "^"
                : roles[a+k].script && c.baseline < base - size * 0.06
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
  const terms = { "negative sampling": "负采样", "positive sampling": "正采样",
    "under sampling":"欠采样", "over sampling":"过采样" };
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
    chi: "χ",
    iota: "ι",
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
  function describe(glyphs, source, fallbackStyle, size, language, ocr, affiliation = false, heading = false, { creditList = false, excerptCommands } = {}) {
    const stream = glyphStream(glyphs),
      text = glyphs.length ? stream.text : fallbackStyle || source;
    const spans = [];
    const add = (start, end, kind, display, more = {}) => {
      if (spans.some((s) => start < s.end && s.start < end)) return false;
      spans.push({ start, end, kind, display, ...more });
      return true;
    };
    for (const m of text.matchAll(/⟦D+\d+⟧/gu)) add(m.index, m.index + m[0].length, "literal", m[0]);
    if (excerptCommands) {
      for (const word of text.matchAll(/\b[a-z][\w.-]*/gu)) {
        if (!excerptCommands.has(word[0])) continue;
        const tail = /^\s+[a-z][\w-]*(?:\s+--[\w-]+(?:\s+(?:[‘’'][^‘’']+[‘’']|[\w./-]+))?)*/u.exec(text.slice(word.index+word[0].length));
        if (tail) add(word.index,word.index+word[0].length+tail[0].length,"code",word[0]+tail[0]);
      }
      for (const m of text.matchAll(/^#{1,6}(?=\s)|\b(?:[\w.-]+\/)*[\w.-]+\.(?:py|md|json|yaml|yml|usd|urdf)\b|\b\w+\[(?:"[^"]+"|'[^']+')\]/giu))
        add(m.index,m.index+m[0].length,"code",m[0]);
    }
    if (creditList) {
      // Names retain their exact source spelling. Only the credited role is
      // translated, so a long list of names cannot be mistaken for lost prose.
      const credit = /^((?:\*{1,3})?[\p{L}][\p{L} &/-]{1,52}:(?:\*{1,3})?\s*)([^:]+)$/u.exec(text);
      if (credit) {
        const names = credit[2].trim();
        const people = names.split(",");
        if (people.length >= 2 && people.every(name => DeepRead.ParallelVisual.isName(name.trim())))
          add(credit[1].length, credit[1].length + names.length, "proper", names);
      }
    }
    if (heading) {
      const section = /^(?:\d+(?:\.\d+)*\.?|[IVXLCDM]+\.)(?=\s+\S)/u.exec(text);
      if (section) add(0, section[0].length, "section", section[0]);
    }
    if (affiliation) {
      for (const m of text.matchAll(
        /(?:\p{Lu}[\p{Script=Latin}’'-]+\s+)?\p{Lu}[\p{Script=Latin}’'-]+(?=\s+(?:Institute|Laboratory|Foundation|Society)\b)/gu
      )) {
        if (/[^\u0000-\u007f]/u.test(m[0])) add(m.index, m.index + m[0].length, "proper", m[0]);
      }
    }
    const roman = /^[IVXLCDM]+\.(?=\s+\p{Lu})/u.exec(text);
    if (roman) add(0, roman[0].length, "section", roman[0]);
    if (isHan(language)) {
      // Treat a complete date as one fact. Separate day/year tokens can
      // both survive validation while being assigned to the wrong fields.
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const date =
        /\b(?:(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-‐‑–—]\s*(\d{1,2})(?:st|nd|rd|th)?)?\s+([A-Za-z]{3,9})\.?|([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-‐‑–—]\s*(\d{1,2})(?:st|nd|rd|th)?)?),?\s+((?:18|19|20|21)\d{2})\b/gi;
      for (const m of text.matchAll(date)) {
        const word = (m[3] || m[4]).toLowerCase(),
          month = months.indexOf(word.slice(0, 3)) + 1;
        if (
          !/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/u.test(
            word
          )
        )
          continue;
        const day = Number(m[1] || m[5]), last = Number(m[2] || m[6] || day),
          year = Number(m[7]);
        if (day >= 1 && last >= day && last <= new Date(Date.UTC(year, month, 0)).getUTCDate())
          add(m.index, m.index + m[0].length, "date", year+"年"+month+"月"+day+(last===day?"":"日至"+last)+"日");
      }
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
      for (const m of text.matchAll(/\b(negative|positive|under|over)[\s‐‑-]*sampling\b/gi)) {
        const name = m[1].toLowerCase() + " sampling";
        add(m.index, m.index + m[0].length, "term", chinese(terms[name], language));
      }
      if (/\bGAMs?\b/u.test(text)) {
        for (const m of text.matchAll(/\bgrounded\s+action\s+models?\b/giu))
          add(m.index,m.index+m[0].length,"term",language==="zh-TW"?"空間定位動作模型":"空间定位动作模型");
      }
    }
    // Complete URLs, citations and OCR LaTeX are indivisible before individual numbers.
    for (const m of text.matchAll(
      /https?:\/\/[^\s<>]+|(?:[\w-]+\.)+(?:\s+)?(?:[\w-]+\.)*(?:edu|org|com|net|io)\b(?:\/[\w./%+-]*)?/gi
    )) {
      const url = m[0].replace(/[.,;:!?)]+$/u, "");
      add(m.index, m.index + url.length, "url", url.replace(/\s+/g, ""));
    }
    for (const m of text.matchAll(/\b10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/gi)) {
      const doi = m[0].replace(/[.,;:]+$/u, "");
      add(m.index, m.index + doi.length, "identifier", doi);
    }
    // A printed license abbreviation can itself carry a PDF link. Keep its
    // original glyph samples so the translated label retains the same action.
    for (const m of text.matchAll(/\bCC[-‐‑]BY(?:[-‐‑](?:NC|ND|SA))*\b/gu))
      add(m.index,m.index+m[0].length,"identifier",m[0]);
    // A bold model or dataset name can end in a size (e.g. "10K").
    // Keep the name together so that K cannot start a formula covering the
    // next statistic in "RoboUniverse-10K, 10,807 interactive ...".
    for (const m of text.matchAll(/\b[A-Z][A-Za-z][A-Za-z0-9]*(?:\.\d+)*[-‐‑]\d+(?:\.\d+)?[KMB](?:[-‐‑][A-Z]\d+[KMB]?)*\b/gu))
      add(m.index, m.index + m[0].length, "identifier", m[0]);
    for (const m of text.matchAll(texPattern)) add(m.index, m.index + m[0].length, "tex", m[0]);
    for (const m of text.matchAll(
      /\b[A-Z][\p{L}’'-]+(?:\s+et\s+al\.|\s+(?:and|&)\s+[A-Z][\p{L}’'-]+)\s*\(\s*(?:19|20)\d{2}[a-z]?\s*\)|\[(?:\d+(?:\s*[,–-]\s*\d+)*)\]/gu
    )) {
      if(glyphs.length && m[0][0]==="[" && /[∈∉]\s*$/u.test(text.slice(0,m.index))) continue;
      add(m.index, m.index + m[0].length, "citation", m[0].replace(/\s+/g, " "));
    }
    for (let i = 0; i < glyphs.length; ) {
      if (!DeepRead.Typography.monospace(glyphs[i])) {
        i++;
        continue;
      }
      let end = i + 1;
      while (
        end < glyphs.length &&
        DeepRead.Typography.monospace(glyphs[end]) &&
        !glyphs[end - 1].lineBreakAfter &&
        !glyphs[end - 1].paragraphBreakAfter
      )
        end++;
      const startAt = stream.offsets[i][0],
        endAt = stream.offsets[end - 1][1];
      const literal = text.slice(startAt, endAt).trim();
      if (/[a-z]/i.test(literal)) add(startAt, endAt, "code", literal);
      i = end;
    }
    for (const m of mathRuns(glyphs, stream, size, ocr, spans)) add(m.start, m.end, "math", m.display, m);
    if (isHan(language)) {
      const scaled = /(?<![\p{L}\p{N}_.,])([+−-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))\s+(million|billion|trillion)\b/giu;
      const protectCount = (m, unit) => {
        // A range with a shared scale, e.g. “1 to 3 billion”, is one
        // construction. Don't convert its final endpoint in isolation.
        const before=text.slice(Math.max(0,m.index-20),m.index);
        if (/[\d.][eE][+−-]?$/u.test(before) || /\d\s*(?:[-‐‑–—~±/,]|to\s+|and\s+|or\s+)\s*$/iu.test(before) ||
            (/^[−-]/u.test(m[1]) && /\d\s*$/u.test(before))) return;
        add(m.index,m.index+m[0].length,"scaled_count",chineseCount(m[1],unit,language));
      };
      for (const m of text.matchAll(scaled)) protectCount(m,m[2]);
      // Only a joined uppercase M with an explicit count noun qualifies.
      // Keep tagged model names, SI notation and other abbreviations intact.
      const millions = /(?<![\p{L}\p{N}_.,/−+‐‑–—-])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)M(?=\s+(?:sentence pairs?|sentences?|tokens?|words?)\b)/gu;
      for (const m of text.matchAll(millions)) protectCount(m,"million");
    }
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
    const emphasis = [];
    const rememberFace = (face, text, chars) => {
      const boxes = [...new Set(chars.filter(c => c?.rect && value(c).trim()).map(c => c.rect))];
      const stride = Math.max(1, Math.ceil(boxes.length / 16));
      emphasis.push({face, text, samples: boxes.filter((r, i) => i % stride === 0)});
    };
    const styled = (a, b, onEmphasis) =>
      glyphs.length
        ? DeepRead.Typography.styledSentence({ text: text.slice(a, b), charMapping: stream.map.slice(a, b) }, glyphs, onEmphasis)
        : text.slice(a, b);
    const tidy = (s) => s.replace(/\s+/gu, " ").trim();
    const sourceStyled = glyphs.length ? tidy(styled(0, text.length, spans.length ? undefined : rememberFace)) : fallbackStyle || source;
    let prefix = "D";
    while (text.includes(`⟦${prefix}`)) prefix += "D";
    let last = 0,
      modelText = "";
    const modelMap = [],
      modelGlyphs = [...glyphs];
    let modelPlain = "";
    const copyPlain = (start, end) => {
      modelPlain += text.slice(start, end);
      for (let j = start; j < end; j++) modelMap.push(stream.map[j]);
    };
    spans.forEach((s, i) => {
      s.id = `⟦${prefix}${i}⟧`;
      s.source = tidy(text.slice(s.start, s.end));
      if (glyphs.length && s.kind === "code" && s.display.includes(" ")) {
        const offset = text.indexOf(s.display,s.start);
        if (offset>=s.start && offset+s.display.length<=s.end) {
          for (const space of s.display.matchAll(/(?<=[A-Za-z0-9_]) (?=[A-Za-z0-9_])/gu)) {
            const at=offset+space.index, left=glyphs[stream.map[at-1]], right=glyphs[stream.map[at+1]];
            if (!left?.rect || !right?.rect || !Number.isFinite(left.baseline) || !Number.isFinite(right.baseline) ||
                !DeepRead.Typography.monospace(left) || left.fontName!==right.fontName ||
                Math.abs(left.baseline-right.baseline)>.1*left.fontSize) continue;
            const gap=right.rect[0]-left.rect[2];
            if (gap>=.17*left.fontSize && gap<=.85*left.fontSize)
              (s.codeSpaces ||= []).push({at:space.index,left:left.rect[2],right:right.rect[0],
                baseline:left.baseline,em:left.fontSize});
          }
        }
      }
      const owned = glyphs.length
        ? glyphs.slice(stream.map[s.start], stream.map[s.end - 1] + 1).filter((c) => value(c).trim())
        : [];
      s.bold = owned.length > 0 && owned.every(DeepRead.Typography.bold);
      s.italic = owned.length > 0 && owned.every(DeepRead.Typography.italic);
      s.mono = owned.length > 0 && owned.every(DeepRead.Typography.monospace);
      if (s.kind === "url" && owned.length) s.fieldLabel = urlFieldLabel(glyphs,stream,s);
      if (!s.rect && owned.length) s.rect = DeepRead.Overlay.unionRect(owned.map((c) => c.rect).filter(Boolean));
      if (s.kind !== "math" && owned.length)
        s.samples = owned
          .filter((c) => c.rect)
          .slice(0, 8)
          .map((c) => c.rect);
      if (glyphs.length) {
        copyPlain(last, s.start);
        const neighbours = [glyphs[stream.map[s.start - 1]], glyphs[stream.map[s.end]]].filter(Boolean);
        const face = {
          bold: s.bold && neighbours.some(DeepRead.Typography.bold),
          italic: s.italic && neighbours.some(DeepRead.Typography.italic)
        };
        const index = modelGlyphs.push(face) - 1;
        modelPlain += s.id;
        for (let j = 0; j < s.id.length; j++) modelMap.push(index);
      } else modelText += styled(last, s.start) + s.id;
      last = s.end;
    });
    if (glyphs.length && spans.length) {
      copyPlain(last, text.length);
      modelText = tidy(DeepRead.Typography.styledSentence({ text: modelPlain, charMapping: modelMap }, modelGlyphs, rememberFace));
    } else modelText = spans.length ? tidy(modelText + styled(last, text.length)) : sourceStyled;
    return { tokens: spans, modelText, styled: sourceStyled, language, emphasis };
  }

  const pattern = /⟦D+\d+⟧/gu;
  // Match copied prose against this source. Method names, citations and formula
  // identifiers can legitimately remain Latin in the middle of a Chinese sentence.
  function copiedEnglish(unit, translation) {
    if (!isHan(unit.language) || unit.verbatim) return false;
    const clean = s => (s || "").replace(pattern, " ").replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+/giu, " ").replace(/\*/gu, "");
    const source = clean(unit.modelText || unit.source);
    const target = clean(translation);
    const phrase = /[A-Za-z][A-Za-z'-]*(?:[ \t]+[A-Za-z][A-Za-z'-]*)*/gu;
    const common = /\b(?:an?|the|is|are|for|from|with|which|that|this|these|we|our|was|were|can|has|have|using|each|between|within|into|results?|methods?|training|details|figure|table|introduction|conclusions?|discussion|appendix|abstract|overview|references|loss|average|grasp|task|mean|accuracy|architecture|model|masking|input|output|robot|conditioning|frozen|trainable|view|time|role|accuracy|score|exterior|predictor|encoder|parameters|setup|algorithm|resolution|minimizes)\b/iu;
    const fold = str => str.toLowerCase().replace(/[^a-z'-]+/gu, " ").trim();
    const haystack = " " + fold(source) + " ";
    const hasHan = /\p{Script=Han}/u.test(target);
    const quotedTitles = hasHan
      ? Array.from(source.matchAll(/[“"]([^“"\n]{2,120})[”"]|‘([^\n]{2,120}?)’(?=[\s.,!?;:)\]]|$)/gu),
          match => match[1] || match[2])
          .filter(title => (title.match(/\b[A-Z][a-z]+/g)?.length || 0) >= 3)
          .map(title => " " + fold(title) + " ")
      : [];
    for (const match of target.matchAll(phrase)) {
      // Official publication names are normally retained in bibliographies.
      const venue = /\b(?:Journal|Conference|Proceedings|Transactions|Symposium|Workshop|Press)\b/u.test(match[0]) &&
        match[0].split(/\s+/u).every(w => /^(?:[A-Z][\p{L}'-]*|the|of|on|in|for|and|at)$/u.test(w));
      if (venue) continue;
      const words = fold(match[0]);
      if (!haystack.includes(" " + words + " ") || !common.test(words)) continue;
      if (quotedTitles.some(title => title.includes(" " + words + " "))) continue;
      const count = words.split(" ").length;
      if ((!hasHan && (count >= 2 || words === fold(source))) || (count >= 5 && /\b(?:the|is|are|that|we|our|was|were|with|this|these|can|have|has|which)\b/iu.test(words))) return true;
    }
    return false;
  }

  function numbers(value) {
    const spelled = ["zero","one","two","three","four","five","six","seven","eight","nine","ten"];
    const text = (value || "").normalize("NFKC").replace(pattern," ")
      .replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/giu, word=>String(spelled.indexOf(word.toLowerCase())))
      .replace(/(\d)\s*(?:per ?cent|percent|%)/giu,"$1%");
    return new Set(text.match(/\d+(?:\.\d+)*(?:%)?/gu) || []);
  }

  function issue(unit, text) {
    if (typeof text !== "string" || !text.trim()) return "missing";
    if (copiedEnglish(unit, text)) return "source_echo";
    // Training, implementation and deployment are separate claims about a
    // model. A fluent translation can keep “easy” while changing its scope.
    const source = unit.modelText || unit.source || "";
    if (isHan(unit.language) && !/…|\.{3}/u.test(source+" "+(unit.source || "")) &&
        /(?:与|與|和|跟|如|像)\s*(?:…+|\.{3,})\s*(?:相似|类似|類似|一样|一樣|相比)/u.test(text)) return "missing_comparison";
    if (isHan(unit.language) && /\b(?:easy|straightforward)\s+to\s+train\b/iu.test(source) &&
        !/\b(?:implement|deploy)\w*/iu.test(source) &&
        /(?:易于|易於|便于|便於|容易)\s*(?:实施|實施|实现|實現|部署)/u.test(text)) return "training_scope";
    if (unit.foreignNumbers?.length && [...numbers(text)].some(n=>unit.foreignNumbers.includes(n))) return "foreign_number";
    const actual = text.match(pattern) || [],
      expected = unit.tokens || [];
    if (actual.length !== expected.length || !expected.every((s) => actual.includes(s.id))) return "placeholders";
    if (
      actual.length &&
      /(?:\$[^$\n]*⟦D+\d+⟧[^$\n]*\$|<[^>]*⟦D+\d+⟧[^>]*>|`[^`]*⟦D+\d+⟧[^`]*`|\\\([^)]*⟦D+\d+⟧[^)]*\\\))/u.test(text)
    )
      return "placeholder_markup";
    const unlocked = text.replace(pattern, " ");
    if (expected.some(t=>t.kind==="scaled_count" &&
        /^(?:\s|\*)*(?:[十百千]?[万萬亿億]|million\b|billion\b|trillion\b)/iu.test(text.slice(text.indexOf(t.id)+t.id.length))))
      return "protected_value";
    if (isHan(unit.language) && /\bfrom\b/iu.test(unit.modelText || "")) {
      // Both numbers can be present yet assigned to opposite endpoints.
      // Check explicit directional wording only. Other valid Chinese word
      // orders, such as stating the result before the baseline, stay available.
      const ranges = Array.from((unit.modelText || "").matchAll(/\bfrom\s+(⟦D+\d+⟧)\s+to\s+(⟦D+\d+⟧)/giu));
      for (const [, start, end] of text.matchAll(/[从從由]\s*(⟦D+\d+⟧)\s*[\p{Script=Han}]{0,5}(?:到|至|为|為)\s*(⟦D+\d+⟧)/gu)) {
        if (ranges.some(([, a, b]) => a === end && b === start)) return "reversed_range";
      }
    }
    if(expected.some(s=>s.kind==="date" && text.includes(s.id+"年")) ||
       (expected.some(s=>s.kind==="date") && /\d{4}\s*年\s*\d{1,2}\s*月/u.test(unlocked))) return "protected_value";
    if (
      expected.some((s) => s.kind === "relation") &&
      /(?:[大小低高][于於]|超[过過]|至少|至多|[<>≤≥])\s*[-+−]?\d/u.test(unlocked)
    )
      return "protected_value";
    if (expected.some((s) => s.kind === "number" && /[%‰]/u.test(s.display)) && /\d\s*[%‰％]/u.test(unlocked))
      return "protected_value";
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
      if (got.italic < wanted.italic || got.bold < wanted.bold) return "emphasis";
      if (
        /^(?:[•‣◦▪●]\s*)?\*\*[^*]+\*\*\s*\p{L}/u.test(unit.modelText) &&
        !/^\*\*[^*]+\*\*[\s\S]*\p{L}/u.test(text)
      )
        return "emphasis";
    }
    return "";
  }
  const valid = (unit, text) => !issue(unit, text);

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
  function geometryText(text) {
    return String(text || "")
      .replace(/\\([a-zA-Z]+)/g, (raw, name) => greek[name.toLowerCase()] || raw)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/ı/g, "i")
      .replace(/c?\s*©/g, "c")
      .replace(/[ˆˇ˘˙˚˜]/gu, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }
  DeepRead.ParallelInline = { describe, valid, issue, fromLegacy, alignOCR, geometryText, numbers };
})();
