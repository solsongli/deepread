/* PDF text alignment and translation typography. License: AGPL-3.0-or-later */
(function () {
  const bold = (c) => c?.bold === true || /bold|black|heavy|semibold|demibold|[-,]Medi\b/i.test(c?.fontName || "");
  const italic = (c) => c?.italic === true || /italic|oblique/i.test(c?.fontName || "");
  const normal = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

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
    let end = indices[at + needle.length - 1] + 1;
    // Preserve trailing sentence punctuation, but do not cross the text line.
    while (end < chars.length && !chars[end - 1].lineBreakAfter && /^[.,:;!?。！？：；)\]]+$/.test(chars[end].u || "")) end++;
    return chars.slice(indices[at], end);
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
  DeepRead.Typography = { match, metrics, styledSentence };
})();
