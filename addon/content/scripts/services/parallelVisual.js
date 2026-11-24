/* Physical caption and table-label frames for original-layout translation.
 * Read geometry and text only. Parser HTML is never inserted in the reader. */
(function () {
  const visual = new Set(["image", "figure", "chart", "table", "code", "code_block"]);
  const norm = (value) =>
    String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const glyph = (c) => String(c.u ?? c.c ?? "");
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3];
  const lineText = (line) =>
    (line.spans || [])
      .map((s) => (s.type === "inline_equation" ? "$" + (s.content || "") + "$" : s.content || ""))
      .join(" ")
      .trim();
  const lineKey = (line) => JSON.stringify([line.bbox, norm(lineText(line))]);

  function attachLayout(items, layout) {
    const physical = new Map();
    for (const page of layout?.pdf_info || []) {
      for (const block of page.preproc_blocks || []) {
        if (!["text", "ref_text"].includes(block.type)) continue;
        const frame = { page, block };
        for (const line of block.lines || []) {
          const key = lineKey(line);
          physical.set(key, physical.has(key) ? null : frame);
        }
      }
    }
    for (const page of layout?.pdf_info || []) {
      const [w, h] = page.page_size || [];
      if (!(w > 0 && h > 0)) continue;
      const relative = (box) => box.map((v, i) => Math.round((v * 1000) / (i % 2 ? h : w)));
      const candidates = items.filter((it) => it.page_idx === page.page_idx && valid(it.bbox));
      for (const block of page.para_blocks || []) {
        if (!valid(block.bbox)) continue;
        const box = relative(block.bbox);
        const item = candidates.find(
          (it) => it.type === block.type && box.every((v, i) => Math.abs(v - it.bbox[i]) <= 3)
        );
        if (!item) continue;
        if (!visual.has(block.type)) {
          if (!["text", "ref_text"].includes(block.type) || block.lines?.length < 2) continue;
          const groups = [];
          for (const line of block.lines || []) {
            const owner = physical.get(lineKey(line));
            if (!owner) {
              groups.length = 0;
              break;
            }
            if (groups.at(-1)?.owner !== owner) groups.push({ owner, lines: [] });
            groups.at(-1).lines.push(line);
          }
          if (groups.length > 1) {
            item.physicalParts = groups.map(({ owner, lines }) => {
              const [pw, ph] = owner.page.page_size;
              const rect = DeepRead.Overlay.unionRect(lines.map((l) => l.bbox));
              return {
                page_idx: owner.page.page_idx,
                bbox: rect.map((v, i) => Math.round((v * 1000) / (i % 2 ? ph : pw))),
                text: lines.map(lineText).join(" ")
              };
            });
          }
          continue;
        }
        const frames = [];
        for (const child of block.blocks || []) {
          if (!/_(caption|footnote)$/.test(child.type) || !valid(child.bbox)) continue;
          const fields = item[child.type] || [];
          const i = frames.filter((f) => f.role === child.type).length;
          const content = (child.lines || [])
            .flatMap((line) =>
              (line.spans || []).map((span) =>
                span.type === "inline_equation" ? "$" + (span.content || "") + "$" : span.content || ""
              )
            )
            .join(" ")
            .trim();
          const text = (Array.isArray(fields) && fields[i]) || content;
          if (typeof text === "string" && text.trim())
            frames.push({ role: child.type, text, bbox: relative(child.bbox) });
        }
        if (frames.length) item.captionFrames = frames;
      }
    }
    return items;
  }

  function pageItems(items, index) {
    const out = [];
    for (const item of items) {
      if (!item.physicalParts?.length) {
        if (item.page_idx === index) out.push(item);
        continue;
      }
      const context = item.physicalParts.map((p) => p.text);
      item.physicalParts.forEach((part, i) => {
        if (part.page_idx === index)
          out.push({
            ...item,
            ...part,
            physicalParts: undefined,
            id: String(item.id) + "@" + i,
            parentId: item.id,
            context
          });
      });
    }
    return out;
  }

  function tableRows(html) {
    if (!html || typeof html !== "string") return [];
    const entities = { amp: "&", gt: ">", lt: "<", apos: "'", quot: '"', nbsp: " " };
    const plain = (cell) =>
      cell
        .replace(/<[^>]*>/g, "")
        .replace(/&(#x[\da-f]+|#\d+|amp|gt|lt|apos|quot|nbsp);/gi, (s, k) => {
          if (k[0] !== "#") return entities[k.toLowerCase()] || s;
          const value = k[1].toLowerCase() === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1));
          return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
        })
        .replace(/\s+/g, " ")
        .trim();
    return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
      [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((cell) => plain(cell[1]))
    );
  }

  function lines(chars) {
    const rows = [];
    for (const c of chars) {
      if (!valid(c.rect) || c.rotation || !glyph(c).trim()) continue;
      const size = c.fontSize || c.rect[3] - c.rect[1],
        y = Number.isFinite(c.baseline) ? c.baseline : c.rect[1];
      let row = rows.find((r) => Math.abs(r.y - y) < Math.max(1, size * 0.28));
      if (!row) {
        row = { y, chars: [] };
        rows.push(row);
      }
      row.chars.push(c);
    }
    return rows.sort((a, b) => b.y - a.y).map((r) => r.chars.sort((a, b) => a.rect[0] - b.rect[0]));
  }

  function labels(item, chars) {
    const rows = tableRows(item.table_body);
    if (!rows.length) return [];
    // A textual header can span multiple rows. Stop at the first data row,
    // including mark matrices and rows of years or model scores.
    const header = [];
    for (const row of rows) {
      if (row.some((cell) => /[✓✔✗✘×]|\d/.test(cell) && !/^[A-Z][A-Z0-9_+-]*$/.test(cell))) break;
      header.push(...row);
      if (header.length > 60) break;
    }
    const candidates = [...new Set(header)].filter((s) => s.length <= 90 && /[a-z]{2}/.test(s));
    if (!candidates.length) return [];
    const found = [];
    for (const row of lines(chars)) {
      let text = "";
      const owners = [];
      for (const [i, c] of row.entries()) {
        const previous = row[i - 1];
        if (previous && (previous.spaceAfter || c.rect[0] - previous.rect[2] > (c.fontSize || 9) * 0.16)) {
          text += " ";
          owners.push(null);
        }
        for (const ch of glyph(c).normalize("NFKC")) {
          text += ch;
          for (let j = 0; j < ch.length; j++) owners.push(c);
        }
      }
      const canonical = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[‐‑–]/g, "-");
      const hay = canonical(text);
      for (const label of candidates) {
        const word = canonical(label);
        let at = -1;
        while ((at = hay.indexOf(word, at + 1)) !== -1) {
          if (/[\p{L}\p{N}]/u.test(hay[at - 1] || "") || /[\p{L}\p{N}]/u.test(hay[at + word.length] || ""))
            continue;
          const run = [...new Set(owners.slice(at, at + word.length).filter(Boolean))];
          if (!run.length || found.some((f) => f.run.some((c) => run.includes(c)))) continue;
          found.push({
            source: label,
            run,
            hint: [...new Set(header), ...(item.table_caption || [])].join(" | ").slice(0, 650),
            languagePairs: header.filter((s) => /^[a-z]{2}[-–][a-z]{2}$/u.test(s)).length >= 2
          });
        }
      }
    }
    return found;
  }

  function isName(text) {
    const words = text
      .replace(/\$[^$]*\$|[\d,;:&¹²³⁴]+/gu, " ")
      .replace(/\band\b/gi, " ")
      .trim()
      .split(/\s+/);
    return (
      words.length >= 2 &&
      words.length <= 14 &&
      words.every((w) => /^(?:\p{Lu}[\p{L}’'.-]*|de|van|von)$/u.test(w)) &&
      !/University|Institute|College|Laborator|Department|Centre|Center|School|Faculty|Journal|Research|Science|Machine|Abstract|Summary|Learning|Technology/i.test(
        text
      )
    );
  }

  function codeLabels(item, chars) {
    const rows = lines(chars);
    const output = [];
    const exampleTable = item.code_caption?.some((c) => /^\s*(?:table|tab\.)\s+\d/i.test(c));
    if (exampleTable) {
      // Some parsers classify a table of linguistic examples as code. Keep
      // the examples verbatim, including the deliberate spaces between letters.
      const names = String(item.code_body || "")
        .split(/\n/)
        .map((line) => /^[+]?[A-Za-z][A-Za-z-]*/u.exec(line.trim())?.[0])
        .filter(Boolean);
      for (const row of rows) {
        let stop = row.findIndex((c, i) => i > 0 && c.rect[0] - row[i - 1].rect[2] > (c.fontSize || 10) * 1.8);
        const first = names.find((name) => row.map(glyph).join("").startsWith(name));
        if (first) {
          let i = 0,
            word = "";
          while (i < row.length && word.length < first.length) word += glyph(row[i++]);
          if (word === first && row[i] && row[i].rect[0] - row[i - 1].rect[2] > (row[i].fontSize || 10) * 0.35)
            stop = i;
        }
        if (stop < 1) continue;
        const run = row.slice(0, stop),
          source = run.map(glyph).join("").trim();
        if (/^[+\p{L}][\p{L} -]{1,25}$/u.test(source) && /[a-z]{2}/.test(source))
          output.push({ source, run, role: "table_label" });
      }
      return output;
    }
    const comments = String(item.code_body || "")
      .split(/\n/)
      .map((line) => /^\s*(?:#|\/\/|--|%)\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((t) => t && /[a-z]{2,}\s+[\p{L}]/iu.test(t));
    for (const text of comments) {
      const needle = norm(text);
      for (const row of rows) {
        const marker = row.findIndex((c) => /[#/%-]/u.test(glyph(c)));
        if (marker < 0 || row.slice(0, marker).some((c) => /[A-Za-z]/.test(glyph(c)))) continue;
        const run = row.slice(marker + 1).filter((c) => !/^[/#% -]+$/.test(glyph(c)));
        if (!run.length || norm(run.map(glyph).join("")) !== needle) continue;
        output.push({ source: text, run, role: "code_comment" });
        break;
      }
    }
    return output;
  }

  function compactLabel(source, language, pairs, template) {
    if (!/^zh(?:-|$)/i.test(language)) return "";
    if (/^avg\.?$/i.test(source)) return "平均";
    if (/^rank\s*[<>≤≥]$/i.test(source)) return (template || source).replace(/rank/i, "排名");
    if (!pairs) return "";
    const codes = {
      en: "英",
      de: "德",
      fr: "法",
      es: "西",
      it: "意",
      ru: "俄",
      zh: "中",
      ja: "日",
      ko: language === "zh-TW" ? "韓" : "韩",
      ar: "阿",
      pt: "葡",
      cs: "捷",
      hi: "印地",
      nl: "荷"
    };
    const pair = /^([a-z]{2})([-–])([a-z]{2})$/u.exec(source);
    return pair && codes[pair[1]] && codes[pair[3]] ? codes[pair[1]] + pair[2] + codes[pair[3]] : "";
  }

  DeepRead.ParallelVisual = { attachLayout, pageItems, labels, codeLabels, compactLabel, lines, isName, norm };
})();
