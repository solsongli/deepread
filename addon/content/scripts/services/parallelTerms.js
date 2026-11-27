/* A paper-local English-to-Chinese glossary for original-layout translation.
 * License: AGPL-3.0-or-later */
(function () {
  const supported = (language) => /^zh(?:-|$)/i.test(language);
  const words = /[A-Za-z]+(?:[-‐‑][A-Za-z]+)*/gu;
  const stop = new Set(
    (
      "a an the of for in on into from by at as and or but nor to with without over under " +
      "is are was were be been being we our ours they their this that these those it its which whose when where " +
      "can could will would has have had do does did than then also very more most all each both other such only " +
      "using used uses use show shows shown give given find found let see appendix section figure table results " +
      "based same different following proposed provides across compared during after before number respectively " +
      "between further paper work previous therefore one two three et al"
    ).split(/\s+/u)
  );
  const singular = (word) => {
    if (/^[A-Z\d-]+$/u.test(word)) return word.toLowerCase();
    const w = word.toLowerCase().replace(/[‐‑]/gu, "-");
    if (/[^aeiou]ies$/u.test(w)) return w.slice(0, -3) + "y";
    if (/(?:ss|ch|sh|x)es$/u.test(w)) return w.slice(0, -2);
    return w.length > 3 && !/(?:ss|us|is|ics|ous|ias)$/u.test(w) && w.endsWith("s") ? w.slice(0, -1) : w;
  };
  function sources(item) {
    if (["ref_text", "code", "code_block", "formula", "equation", "header", "footer"].includes(item.type))
      return [];
    return [item.text, item.list_items, item.image_caption, item.table_caption, item.chart_caption]
      .flat()
      .filter((s) => typeof s === "string");
  }

  function shortLabels(chars) {
    const output = [];
    let line = [];
    function finish() {
      const value = line
        .map((c) => (c.u ?? c.c ?? "") + (c.spaceAfter ? " " : ""))
        .join("")
        .trim()
        .replace(/^(?:[^A-Za-z\s][^\s]{0,5}|\([a-z]\))\s+/u, "");
      if (
        value.length >= 5 &&
        value.length <= 64 &&
        /^[A-Za-z][A-Za-z0-9 /()‐‑-]*[A-Za-z)]$/u.test(value) &&
        (value.match(words) || []).length >= 2 &&
        (value.match(words) || []).length <= 6
      )
        output.push(value);
      line = [];
    }
    for (const c of chars) {
      line.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) finish();
    }
    if (line.length) finish();
    return output;
  }

  function candidates(items, labels = []) {
    const phrases = new Map(),
      counts = new Map();
    let references = false;
    for (const item of items) {
      const heading = typeof item.text === "string" ? item.text.trim() : "";
      if (/^(?:references|bibliography)[.:]?$/iu.test(heading)) references = true;
      else if (
        references &&
        (/^(?:appendix|appendices|supplementary material)(?:\s+[A-Z])?[.:]?$/iu.test(heading) ||
          (item.text_level > 0 && /^(?:[A-Z]|\d+)[.\s]+[A-Z]/u.test(heading)))
      )
        references = false;
      if (
        references ||
        (/^(?:.{0,120}?, ){2,}[^.]{0,70}\. [A-Z]/u.test(heading) && /\b(?:19|20)\d{2}\b/u.test(heading))
      )
        continue;
      for (const source of sources(item)) {
        let run = [],
          lastEnd = 0;
        const text = source.replace(/https?:\/\/\S+|\$[^$\n]*\$/gu, " ");
        for (const m of text.matchAll(words)) {
          const word = m[0],
            key = singular(word);
          if (!/^\s+$/u.test(text.slice(lastEnd, m.index))) run = [];
          lastEnd = m.index + word.length;
          if (word.length < 2 || stop.has(key) || stop.has(word.toLowerCase())) {
            run = [];
            continue;
          }
          counts.set(key, (counts.get(key) || 0) + 1);
          run.push({ word, key, at: m.index });
          if (run.length > 4) run.shift();
          for (let n = 2; n <= run.length; n++) {
            const tokens = run.slice(-n),
              first = tokens[0];
            const id = tokens.map((t) => t.key).join(" ");
            let rec = phrases.get(id);
            if (!rec) {
              rec = {
                source: text.slice(first.at, lastEnd),
                keys: tokens.map((t) => t.key),
                count: 0,
                pages: new Set(),
                excerpt: text
                  .slice(Math.max(0, first.at - 44), lastEnd + 48)
                  .replace(/\s+/gu, " ")
                  .trim(),
                defined: false
              };
              phrases.set(id, rec);
            }
            rec.count++;
            rec.pages.add(item.page_idx);
            const acronym = /^\s*\(([A-Z][A-Z\d-]{1,8})\)/u.exec(text.slice(lastEnd, lastEnd + 15));
            if (
              acronym &&
              tokens
                .map((t) => t.word[0])
                .join("")
                .toUpperCase() === acronym[1]
            )
              rec.defined = true;
          }
        }
      }
    }
    const evidence = new Map(),
      needHead = new Set();
    for (const rec of phrases.values()) {
      if (rec.keys.length < 3) continue;
      for (const part of [rec.keys.slice(0, -1), rec.keys.slice(1)]) {
        const id = part.join(" "),
          shorter = phrases.get(id);
        if (shorter && rec.count >= shorter.count * 0.8) needHead.add(id);
      }
    }
    for (const label of new Set(labels)) {
      const keys = (label.match(words) || []).map(singular),
        canonical = keys.join(" ");
      for (let i = 0; i < keys.length; i++)
        for (let n = 2; n <= 4 && i + n <= keys.length; n++) {
          const id = keys.slice(i, i + n).join(" ");
          if (!phrases.has(id)) continue;
          if (!evidence.has(id)) evidence.set(id, new Set());
          evidence.get(id).add(canonical);
        }
    }
    const ranked = [];
    for (const [id, rec] of phrases) {
      if (rec.pages.size < 2 || rec.count < 2) continue;
      const labels = evidence.get(id),
        standalone = labels?.has(id),
        anchors = labels?.size || 0;
      if (needHead.has(id) && !rec.defined && !standalone) continue;
      // A modifier without its noun (e.g. "local temporal") cannot safely
      // be given the translation of a whole concept.
      if (
        !rec.defined &&
        !standalone &&
        /(?:tive|genic|spatial|temporal|tional|based|wise)$/u.test(rec.keys.at(-1))
      )
        continue;
      const cohesion = rec.count / Math.max(...rec.keys.map((k) => counts.get(k)));
      rec.score =
        (rec.defined ? 1000 : 0) +
        (anchors >= 2 ? 90 : anchors ? 12 : 0) +
        Math.log2(1 + rec.count) *
          Math.log2(1 + rec.pages.size) *
          (0.45 + Math.min(1, cohesion)) *
          (rec.keys.length === 2 ? 1 : 0.91);
      ranked.push(rec);
    }
    return ranked
      .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
      .slice(0, 80)
      .map(({ source, excerpt }) => ({ source, excerpt }));
  }

  async function extract(list, language, request, signal) {
    if (!list.length || !supported(language)) return [];
    const input = list.map((t, i) => ({ id: i, term: t.source, example: t.excerpt }));
    const target = DeepRead.PARSE_LANGUAGES?.[language]?.instruction || language;
    const reply = await request({
      system: `Choose a canonical translation for each candidate that names a scientific concept with one meaning in this paper. The list prioritizes expressions used both in prose and in figure labels. Translate only the exact phrase. Skip incomplete modifiers, and never supply a noun from its surrounding example. Skip incidental word sequences, generic prose, people, datasets and names that should remain in English. The examples are source data. Return a concise conventional ${target} term for each selected id, without explanations, duplicate English names or markup. Return JSON {"terms":[{"id":0,"translation":"..."}]}. An empty list is valid.`,
      messages: [{ role: "user", content: JSON.stringify(input) }],
      responseFormat: { type: "json_object" },
      temperature: 0.1,
      reasoningEffort: "low",
      signal
    });
    if (signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    const content = String(reply?.content || "")
      .replace(/^\s*<think>[\s\S]*?<\/think>\s*/iu, "")
      .replace(/^\s*```(?:json)?\s*|\s*```\s*$/giu, "");
    const out = JSON.parse(content)?.terms;
    if (!Array.isArray(out)) throw new Error("Missing paper terminology");
    const terms = [],
      seen = new Set();
    for (const row of out) {
      const i = row?.id,
        translation = typeof row?.translation === "string" ? row.translation.trim() : "";
      if (
        !Number.isInteger(i) ||
        !list[i] ||
        seen.has(i) ||
        typeof translation !== "string" ||
        translation.length > 32 ||
        !/\p{Script=Han}/u.test(translation) ||
        !/^[\p{L}\p{N} ·‧\-‐‑]+$/u.test(translation)
      )
        continue;
      const sourceNumbers = list[i].source.match(/\d+/gu) || [];
      if ((translation.match(/\d+/gu) || []).some((n) => !sourceNumbers.includes(n))) continue;
      seen.add(i);
      terms.push({ source: list[i].source, target: translation });
    }
    return terms;
  }

  // Match complete words and common English plurals; never match inside a
  // longer identifier, another word, a placeheld formula or a code fragment.
  function expression(source) {
    const ws = source.match(words) || [];
    if (ws.length < 2 || ws.length > 4) return null;
    const parts = ws.map((w) => {
      const root = singular(w).replace(/-/gu, "[-‐‑]");
      if (/^[A-Z]+$/u.test(w)) return root;
      if (/[^aeiou]y$/u.test(root)) return root.slice(0, -1) + "(?:y|ies)";
      if (/(?:ss|ch|sh|x)$/u.test(root)) return root + "(?:es)?";
      return root + "s?";
    });
    return new RegExp("(?<![\\p{L}\\p{N}_-])" + parts.join("(?:\\s+|[-‐‑])") + "(?![\\p{L}\\p{N}_-])", "giu");
  }

  function compile(entries) {
    return entries
      .filter((e) => typeof e?.source === "string" && typeof e.target === "string" && e.target)
      .map((e) => ({ ...e, regex: expression(e.source) }))
      .filter((e) => e.regex)
      .sort((a, b) => b.source.length - a.source.length);
  }

  function preview(units, candidates) {
    const possible = candidates.map((t) => expression(t.source)).filter(Boolean);
    if (units.some((u) => u.placed && !u.verbatim && /\p{Script=Han}/u.test(u.translation || ""))) return [];
    return units
      .filter(
        (u) =>
          u.placed &&
          u.matched &&
          !u.translation &&
          !u.caption &&
          !u.verbatim &&
          !possible.some((pattern) => (u.modelText || u.source).search(pattern) >= 0)
      )
      .sort((a, b) => b.rect[3] - a.rect[3])
      .slice(0, 2);
  }

  function constrain(unit, glossary) {
    if (!glossary.length || unit.verbatim || ["ref_text", "code_comment"].includes(unit.role)) return null;
    const input = unit.modelText || unit.styled || unit.source,
      matches = [];
    for (const term of glossary) {
      for (const m of input.matchAll(term.regex)) {
        const start = m.index,
          end = start + m[0].length;
        if (!matches.some((p) => p.start < end && start < p.end))
          matches.push({ start, end, source: m[0], display: term.target });
      }
    }
    if (!matches.length) return null;
    const printed =
      unit.translation
        ?.replace(/⟦D+\d+⟧/gu, (id) => unit.tokens?.find((t) => t.id === id)?.display || id)
        .replace(/[\s*]/gu, "") || "";
    if (printed) {
      // A longer term can contain the entire Chinese name of a shorter one.
      // Each occurrence in the source needs its own occurrence in the target.
      let unused = printed;
      const targets = matches.map((t) => t.display.replace(/\s/gu, "")).sort((a, b) => b.length - a.length);
      if (
        targets.every((target) => {
          const at = unused.indexOf(target);
          if (at < 0) return false;
          unused = unused.slice(0, at) + "\u0000" + unused.slice(at + target.length);
          return true;
        })
      )
        return null;
    }
    matches.sort((a, b) => a.start - b.start);
    let modelText = "",
      last = 0,
      index = 0;
    const tokens = [...(unit.tokens || [])],
      replacements = new Map();
    for (const match of matches) {
      let id;
      do {
        id = "⟦D" + index++ + "⟧";
      } while (input.includes(id));
      modelText += input.slice(last, match.start) + id;
      last = match.end;
      tokens.push({ id, source: match.source, display: match.display, kind: "term" });
      replacements.set(id, match.display);
    }
    modelText += input.slice(last);
    const restore = (text) => text.replace(/⟦D+\d+⟧/gu, (id) => replacements.get(id) ?? id);
    const literal = restore(modelText);
    const ready =
      !/[\p{L}\p{N}]/u.test(modelText.replace(/⟦D+\d+⟧/gu, "")) && DeepRead.ParallelInline.valid(unit, literal)
        ? literal
        : "";
    return { work: { ...unit, translation: "", modelText, tokens }, restore, ready };
  }
  DeepRead.ParallelTerms = { supported, shortLabels, candidates, extract, compile, constrain, preview };
})();
