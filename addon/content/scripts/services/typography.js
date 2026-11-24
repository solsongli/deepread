/* PDF text alignment and translation typography. License: AGPL-3.0-or-later */
(function () {
  const bold = (c) => c?.bold === true || /bold|black|heavy|[-,]Bd(?:It|Obl)?(?:MT)?$|[-,]Medi(?:Ital)?\b|(?:^|\+)(?:cm|lm)(?:ss)?bx(?:ti|sl)?\d/i.test(c?.fontName || "");
  const italic = (c) => c?.italic === true || /italic|oblique|(?:Regu|Medi|Bold|[-,])Ital(?:MT)?\b|(?:^|\+)(?:cm|lm)(?:bxti|bxsl|ti|sl|itt|ssi)\d/i.test(c?.fontName || "");
  const monospace = c => /(?:^|\+)(?:cm|lm)(?:tt|itt)\d|mono|NimbusMon|Courier|Consolas|Menlo/i.test(c?.fontName || "");
  const normal = (s) => String(s || "").normalize("NFKD").toLowerCase().replace(/ı/g,"i")
    .replace(/[ˆˇ˘˙˚˜]/gu,"").replace(/[^\p{L}\p{N}]/gu, "");

  // Only accept an unambiguous full-text match. OCR differences retain the original fallback.
  function match(chars, text) {
    const needle = normal(text);
    if (needle.length < 8) return null;
    let haystack = "";
    const indices = [];
    chars.forEach((c, i) => {
      const value = normal(c.u);
      haystack += value;
      for (let j = 0; j < value.length; j++) indices.push(i);
    });
    const at = haystack.indexOf(needle);
    if (at < 0 || haystack.indexOf(needle, at + 1) >= 0) return null;
    let start = indices[at], end = indices[at + needle.length - 1] + 1;
    // A list bullet has no letters, so normalized matching used to drop the first one.
    let before = start - 1;
    while (before >= 0 && /^\s*$/.test(chars[before].u || "") && !chars[before].lineBreakAfter) before--;
    if (before >= 0 && /^[•‣◦▪●]$/.test(chars[before].u || "") && !chars[before].lineBreakAfter
        && Math.abs((chars[before].rect?.[1] || 0) - (chars[start].rect?.[1] || 0)) < (chars[start].fontSize || 10)) start = before;
    // Recover the exact suffix discarded by letter-only matching, e.g. the %,
    // after 46.9. Only consume symbols the source owns, on the same PDF line.
    const tail = String(text).normalize("NFKC").match(/[^\p{L}\p{N}]*$/u)[0].replace(/\s+/g, "");
    let suffix = "", next = end;
    while (suffix.length < tail.length && next < chars.length && !chars[next - 1].lineBreakAfter) {
      const piece = String(chars[next].u ?? chars[next].c ?? "").normalize("NFKC").replace(/\s+/g, "");
      if (!tail.startsWith(suffix + piece)) break;
      suffix += piece;
      next++;
    }
    if (tail && suffix === tail) end = next;
    // Older OCR text sometimes omits the terminal stop.
    while (end < chars.length && !chars[end - 1].lineBreakAfter && /^[.,:;!?。！？：；)\]]+$/.test(chars[end].u || "")) end++;
    return chars.slice(start, end);
  }

  function metrics(chars) {
    const sizes = new Map();
    for (const c of chars) {
      const size = Number(c?.fontSize);
      if (!c?.u?.trim() || !Number.isFinite(size) || size <= 0 || size > 96) continue;
      const rounded = Math.round(size * 10) / 10;
      sizes.set(rounded, (sizes.get(rounded) || 0) + 1);
    }
    const fontSize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0];
    return fontSize ? { fontSize } : null;
  }

  function styledSentence(sentence, chars) {
    const text = sentence.text || "";
    const mapping = sentence.charMapping || [];
    if (mapping.length !== text.length) return text;
    let out = "", run = "", previous = "";
    const flush = () => {
      if (!run) return;
      // Markdown emphasis cannot start or end with whitespace.
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(run);
      out += m[1] + (m[2] ? previous + m[2] + previous : "") + m[3];
      run = "";
    };
    for (let i = 0; i < text.length; i++) {
      const c = chars[mapping[i]];
      const style = (bold(c) ? "**" : "") + (italic(c) ? "*" : "");
      if (style !== previous && text[i].trim()) { flush(); previous = style; }
      run += text[i];
    }
    flush();
    return out;
  }
  // TeX sometimes prints a letter and its accent as overlapping, separate
  // glyphs in either order. Compose only neighbours on the same baseline.
  function composeAccents(chars) {
    const marks = {
      ˇ: "\u030c",
      ˆ: "\u0302",
      "´": "\u0301",
      "˙": "\u0307",
      "˘": "\u0306",
      "˚": "\u030a",
      "˜": "\u0303",
      "¨": "\u0308"
    };
    let result;
    for (let i = 0; i < chars.length; i++) {
      const accent = chars[i],
        mark = accent.u,
        rect = accent.rect;
      if ((!marks[mark] && mark !== "©") || !rect) continue;
      let best = -1,
        score = 0.5;
      for (const j of [i - 1, i + 1]) {
        const c = chars[j],
          r = c?.rect;
        if (
          !r ||
          !(mark === "©" ? c.u === "c" : /^[\p{Script=Latin}]$/u.test(c.u)) ||
          Math.abs(c.baseline - accent.baseline) > (c.fontSize || 10) * 0.25 ||
          /math|CMMI|CMSY|CMEX/i.test(c.fontName || "")
        )
          continue;
        const width = Math.min(rect[2] - rect[0], r[2] - r[0]);
        const ratio = (Math.min(rect[2], r[2]) - Math.max(rect[0], r[0])) / width;
        if (ratio > score) {
          score = ratio;
          best = j;
        }
      }
      if (best < 0) continue;
      result ||= chars.slice();
      const base = result[best],
        r = base.rect;
      result[best] = {
        ...base,
        u: mark === "©" ? "©" : ((base.u === "ı" ? "i" : base.u) + marks[mark]).normalize("NFC"),
        rect: [Math.min(r[0], rect[0]), Math.min(r[1], rect[1]), Math.max(r[2], rect[2]), Math.max(r[3], rect[3])],
        spaceAfter: base.spaceAfter || accent.spaceAfter,
        lineBreakAfter: base.lineBreakAfter || accent.lineBreakAfter,
        paragraphBreakAfter: base.paragraphBreakAfter || accent.paragraphBreakAfter
      };
      result[i] = null;
    }
    return result ? result.filter(Boolean) : chars;
  }
  DeepRead.Typography = { match, metrics, styledSentence, bold, italic, monospace, composeAccents };
})();
