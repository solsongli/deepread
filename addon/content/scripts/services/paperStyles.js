/* Document-wide type roles in physical PDF points. License: AGPL-3.0-or-later */
(function () {
  const sessions = new WeakMap();
  const indices = new WeakMap();
  const quarter = (n) => Math.round(n * 4) / 4;
  const textOf = (p) => String(p.source ?? p.paragraphText ?? "");
  const captionLead =
    /^(fig(?:ure)?\.?|tab(?:le)?\.?|chart|algorithm|图|圖|表|算法)\s*(?:[A-Z]?\d+(?:[.\-]\d+)*[a-z]?|[IVXLCDM]+)(?=[\s.:：、—–-]|[\u3400-\u9fff]|$)/iu;
  const bibliographyHeading =
    /^(?:[\d.]+\s+)?(?:references(?: and notes)?|bibliography|literature cited|works cited|参考文献|參考文獻)[.:：]?$/iu;

  function make(base = 10, proseStep, language = "zh") {
    const simplified = /^(?:zh|zh-CN|zh-Hans)$/iu.test(language);
    const bodySize = simplified ? .955 : 1.025, bodyWeight = simplified ? 500 : 400;
    const captionWeight = simplified ? 550 : 400;
    const rows = {
      body: [bodySize, 1.35, 0.45, 0.45, "serif", bodyWeight],
      list: [bodySize, 1.35, 0.25, 0.25, "serif", bodyWeight],
      documentTitle: [1.8, 2.12, 0.8, 0.55, "serif", 700],
      runningTitle: [1, 1.2, 0, 0, "serif", bodyWeight],
      heading: [1.25, 1.52, 0.7, 0.4, "serif", 700],
      subheading: [1.05, 1.32, 0.55, 0.35, "serif", 700],
      figureCaption: [0.9, 1.15, 0.25, 0.25, "serif", captionWeight],
      tableCaption: [0.9, 1.15, 0.25, 0.25, "serif", captionWeight],
      algorithmCaption: [0.9, 1.15, 0.25, 0.25, "serif", captionWeight],
      reference: [0.88, 1.08, 0.22, 0.22],
      footnote: [0.8, 1.0, 0.22, 0.22],
      metadata: [0.85, 1.06, 0.22, 0.22],
      contents: [0.9, 1.15, 0.25, 0.25]
    };
    const roles = {};
    for (const [role, [size, step, before, after, family = "serif", weight = 400]] of Object.entries(rows)) {
      roles[role] = {
        role,
        size: quarter(base * size),
        step: quarter(base * step),
        before: quarter(base * before),
        after: quarter(base * after),
        family,
        weight
      };
    }
    if (proseStep) {
      // Keep the document rhythm and enough leading for Chinese punctuation and math.
      const step = Math.max(proseStep, quarter(base * 1.025) * 1.23);
      roles.body.step=roles.list.step=quarter(step);
    }
    return { base, roles };
  }
  const fallback = make();

  function countPage(chars, scale, counts, leading) {
    let line = [],
      previous;
    function finish() {
      const letters = line.filter((c) => /[\p{L}]/u.test(c.u || c.c || ""));
      if (letters.length < 22 || line.some((c) => c.rotation || c.diagonal)) {
        previous = null;
        return;
      }
      const sizes = new Map();
      for (const c of letters) {
        const size = quarter(c.fontSize * scale);
        if (size >= 4 && size <= 32) sizes.set(size, (sizes.get(size) || 0) + 1);
      }
      const dominant = [...sizes].sort((a, b) => b[1] - a[1])[0];
      if (dominant && dominant[1] >= letters.length * 0.55) {
        const [size, n] = dominant;
        counts.set(size, (counts.get(size) || 0) + Math.min(65, n));
        if (leading) {
          const prose = letters.filter(
            (c) => quarter(c.fontSize * scale) === size && c.rect && Number.isFinite(c.baseline)
          );
          if (!prose.length) {
            previous = null;
            return;
          }
          const y = prose.map((c) => c.baseline * scale).sort((a, b) => a - b)[Math.floor(prose.length / 2)];
          const left = prose[0].rect[0] * scale;
          if (previous?.size === size && Math.abs(previous.left - left) < size * 1.7) {
            const step = Math.round((previous.y - y) * 100) / 100;
            if (step >= size * 1.04 && step <= size * 1.85) {
              if (!leading.has(size)) leading.set(size, new Map());
              const votes = leading.get(size);
              votes.set(step, (votes.get(step) || 0) + 1);
            }
          }
          previous = { size, y, left };
        }
      }
    }
    for (const c of chars) {
      line.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) {
        finish();
        line = [];
      }
    }
    if (line.length) finish();
  }

  function resolve(session) {
    const doc = session.overlay?.app?.pdfDocument;
    if (!doc || !session.pdfAdapter) return Promise.resolve(fallback);
    const language = DeepRead.prefs?.language?.() || session.data?.language || "zh";
    const old = sessions.get(session);
    if (old?.doc === doc && old.language === language) return old.promise;
    const state = { doc, language, profile: null };
    const adapter = session.pdfAdapter().pdfDocument;
    const count = adapter.numPages || doc.numPages;
    const pages = new Set(
      [0, 1, 2, 3, Math.floor(count * 0.32), Math.floor(count * 0.58)].filter((i) => i < count)
    );
    state.promise = (async () => {
      const counts = new Map(),
        leading = new Map();
      for (const index of pages) {
        try {
          const [data, page] = await Promise.all([
            adapter.getPageData({ pageIndex: index }),
            adapter.getPage(index + 1)
          ]);
          const t = page.getViewport({ scale: 1 }).transform;
          countPage(data.chars || [], Math.hypot(t[0], t[1]), counts, leading);
          if (index === 0 && DeepRead.TextLayerParser?.buildContentList) {
            // This sample is already in memory even if the reader opened in
            // the middle of a PDF without a document-wide parser result.
            const cover = DeepRead.TextLayerParser.buildContentList([
              {pageIndex:0,viewBox:page.view,chars:data.chars || []}
            ], {includePublicationNotes:true});
            const title = cover.findIndex(it => it.text_level === 1);
            state.cover = title < 0 ? [] : cover.slice(title,title+3);
          }
        } catch (error) {
          DeepRead.log?.("No type sample on page " + (index + 1), String(error));
        }
      }
      const winner = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      const size = winner?.[0] || 10;
      const pitch = [...(leading.get(size) || [])].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      return (state.profile = make(size, pitch?.[1] >= 4 ? pitch[0] : null, language));
    })();
    sessions.set(session, state);
    return state.promise;
  }

  function bibliographyBeforeAppendix(items) {
    // In a single-page preview the preceding REFERENCES heading may lie on
    // an unloaded page. This page may finish the bibliography in the left
    // column and start an appendix in the right column.
    if (!items[0]?.page_idx || items[0].page_idx !== items.at(-1)?.page_idx) return -1;
    const appendix = items.findIndex(it => /^appendi(?:x|ces)\b/iu.test(it.text || ""));
    if (appendix < 2) return -1;
    const entries = items.slice(0, appendix);
    const named = entries.map(it => /^\p{Lu}[\p{L}’'.-]+\s+\p{Lu}[\p{L}’'.-]+,\s+(?:and\s+)?\p{Lu}[\p{L}\s',.\-’]{3,180}\.\s+(?:19|20)\d\d[a-z]?\./u.test(it.text || ""));
    const start = named.findIndex((yes,i) => yes && named[i+1]);
    if (start < 0) return -1;
    const continuation = entries[start-1]?.text || "";
    return /^\p{Ll}/u.test(continuation) && /\b(?:Proceedings of|Conference on|Journal of|Press)\b/u.test(continuation)
      ? start-1 : start;
  }

  function documentStructure(items) {
    if (!items?.length) return null;
    if (indices.has(items)) return indices.get(items);
    const ids = new Set(),
      referenceBoxes = new Map(),
      levels = new Set();
    let references = false,
      documentTitle,
      sectionLevel = Infinity;
    const continuation = bibliographyBeforeAppendix(items);
    for (const [index, item] of items.entries()) {
      const s = typeof item.text === "string" ? item.text.trim() : "";
      const heading = bibliographyHeading.test(s);
      // Some small-cap REFERENCES headings disappear in the PDF text layer.
      // Two consecutive IEEE entries with initials and a publication year
      // distinguish the bibliography from an in-text numeric citation.
      const firstEntry = !references && /^\[1\]\s+\p{Lu}\.\s+\p{Lu}/u.test(s) &&
        /\b(?:19|20)\d{2}\b[\s\S]*?\[2\]\s+\p{Lu}\.\s+\p{Lu}/u.test(
          items.slice(index, index+4).map(it => it.text || "").join(" ").slice(0,3500));
      if (item.text_level > 0) {
        if (
          documentTitle == null &&
          item.page_idx === 0 &&
          item.text_level === 1 &&
          !/^(abstract|摘要|introduction)$/iu.test(s)
        )
          documentTitle = item.id;
        else {
          levels.add(Number(item.text_level));
          sectionLevel = Math.min(sectionLevel, Number(item.text_level));
        }
      }
      if (heading || firstEntry || index === continuation) {
        references = true;
      } else if (
        references &&
        item.type !== "ref_text" && !/^\[\d+\]/u.test(s) &&
        (item.text_level || item.type === "title" || /^(?:appendix|appendices|supplementary material)\b/iu.test(s))
      )
        references = false;
      if ((references && ["text", "title", "list", "ref_text"].includes(item.type)) || item.type === "ref_text") {
        if (!heading && item.id != null) ids.add(item.id);
        for (const part of item.physicalParts?.length ? item.physicalParts : [item]) {
          if (!part.bbox) continue;
          if (!referenceBoxes.has(part.page_idx)) referenceBoxes.set(part.page_idx, []);
          referenceBoxes.get(part.page_idx).push(part.bbox);
        }
      }
    }
    const result = {
      references: ids,
      referenceBoxes,
      documentTitle,
      sectionLevel: Number.isFinite(sectionLevel) ? sectionLevel : 1,
      levelCount: levels.size
    };
    indices.set(items, result);
    return result;
  }

  function captionRole(p) {
    const s = textOf(p).trim(),
      type = p.role || p.paragraphType;
    if (p.captionKind === "table" || type === "table") return "tableCaption";
    if (p.captionKind === "figure" || ["image", "figure", "chart"].includes(type)) return "figureCaption";
    const m = captionLead.exec(s);
    if (m) {
      const rest = s.slice(m[0].length).trimStart();
      if (
        type !== "caption" &&
        /^(?:shows?|provide[sd]?|compares?|summari[sz]es?|gives?|presents?|reports?|lists?|depicts?|illustrates?|demonstrates?|displays?|describes?|suggests?|contains?|indicates?|is|are)\b|^(?:中(?:的|所示)|表明|显示|所示|给出)/iu.test(
          rest
        )
      )
        return null;
      const styled = /^\s*\*{1,3}(?:fig|tab|chart|图|圖|表)/iu.test(p.styled || "");
      if (type === "caption" || styled || /^[.:：、—–-]/u.test(rest) || /^[A-Z\u3400-\u9fff]/u.test(rest))
        return /^(?:algorithm|算法)/iu.test(m[1])
          ? "algorithmCaption"
          : /^(?:tab|表)/iu.test(m[1])
            ? "tableCaption"
            : "figureCaption";
    }
    return type === "caption" ? "figureCaption" : null;
  }

  function role(p, profile, structure) {
    const type = p.role || p.paragraphType,
      s = textOf(p).trim();
    if (
      (p.documentTitle ||
        (p.title && structure?.documentTitle != null && (p.owner ?? p.minerUid) === structure.documentTitle)) &&
      !/^(?:abstract|摘要|references|appendix)$/iu.test(s)
    )
      return "documentTitle";
    if (p.layoutPart === "contents") return "contents";
    if (p.layoutPart === "runningTitle") return "runningTitle";
    if (
      p.layoutPart === "algorithm" ||
      p.verifiedLabel ||
      ["figure_label", "table_label", "algorithm_step", "formula_note", "code_comment"].includes(type)
    )
      return null;
    // Small-cap section headings sometimes come from the parser as plain text.
    // Assign their visual role without changing any cached translation tokens.
    const numberedSection = p.rects?.length === 1 &&
      /^\d+(?:\.\d+)*\.?\s+(?:results and discussion|discussion and conclusions?)$/iu.test(s);
    if (p.title || type === "title" || numberedSection) {
      if (/^(?:I|V|X|[IVXLCDM]{2,})\.\s+|^第[一二三四五六七八九十百\d]+章|^[一二三四五六七八九十]+、/u.test(s))
        return "heading";
      if (
        /^(?:\d+|[A-Z])\.\d+\b|^[(（][a-z一二三四五六七八九十\d]+[)）]/u.test(s) ||
        /^第[一二三四五六七八九十百\d]+节/u.test(s)
      )
        return "subheading";
      if (/^[A-Z]\.\s/u.test(s)) return p.size >= profile.base * 1.15 ? "heading" : "subheading";
      if (
        /^(?:\d+[.)]?|[IVXLCDM]+\.?|[A-Z])\s+\S/u.test(s) ||
        /^(?:abstract|references|bibliography|appendix|introduction|methods?|materials and methods|methodology|results|discussion|related work|experiments?|background|conclusions?|acknowledg\w+|摘要|附录|引言|方法|实验|讨论|结论|参考文献)$/iu.test(
          s
        )
      )
        return "heading";
      if (structure?.levelCount > 1 && p.headingLevel > 0)
        return p.headingLevel > structure.sectionLevel ? "subheading" : "heading";
      return p.headingLevel > (structure?.sectionLevel || 1) || (p.size && p.size < profile.base * 1.12)
        ? "subheading"
        : "heading";
    }
    if (p.captionKind === "footnote" || ["footnote", "page_footnote", "header", "footer"].includes(type))
      return "footnote";
    const caption = captionRole(p);
    if (caption) return caption;
    if (
      type === "ref_text" ||
      structure?.references.has(p.owner ?? p.minerUid) ||
      (/^\s*(?:\[\d+\]\s*)?\p{Lu}[\p{L}.'’-]+[, ]/u.test(s) &&
        /\b(?:19|20)\d{2}\b/u.test(s) &&
        /\b(?:arXiv preprint|Proceedings of|Transactions on|International Conference on|Journal of)\b/iu.test(
          s
        ) &&
        !/^(?:We|The|Our|This)\b/u.test(s))
    )
      return "reference";
    if (p.frontMatter || /^(?:date|correspondence|doi|keywords?|received|accepted|contact)\s*:/iu.test(s))
      return "metadata";
    if (p.marker || type === "list") return "list";
    if (p.verbatim || (p.direction && Math.abs(p.direction[1]) > 0.1)) return null;
    // Some text-layer parsers return chart legends, repeated tick values and
    // cell headers as ordinary text. They still belong to the graphic.
    if (/^(?:\d+(?:[.,]\d+)?\s+){2,}/u.test(s)) return null;
    if (
      s.length < 165 &&
      !/[,.!?:;，。！？：；][”’"']?$/u.test(s) &&
      !p.context?.length &&
      !/^(?:\p{Ll}|We\s|Our\s|The\s|This\s|These\s|To\s|Let\s|In\s)/u.test(s) &&
      (p.size < profile.base * 0.87 || s.split(/\s+/u).length <= 8) &&
      !/\b(?:is|are|was|were|has|have|will|can)\b/iu.test(s)
    )
      return null;
    if (p.rects?.length === 1 && s.length < 65 && p.size < profile.base * 0.75) return null;
    return "body";
  }

  function classify(units, profile, refs, view, userUnit = 1) {
    const base = profile.base / userUnit;
    for (const u of units) {
      u.typeRole = role(u, { base }, refs);
      if (
        view &&
        u.typeRole === "body" &&
        u.rect &&
        u.rect[1] < view[1] + (view[3] - view[1]) * 0.24 &&
        u.rect[3] < view[1] + (view[3] - view[1]) * 0.30 &&
        u.size < base * 0.94 &&
        /^[\d¹²³†‡*∗]{1,3}\s*(?=\p{Lu})/u.test(u.source) &&
        u.source.length > 5
      )
        u.typeRole = "footnote";
    }
    // A caption often has a bold lead and several separately parsed plain
    // lines. Follow its physical column, stopping at a paragraph gap or heading.
    const ordered = units
      .filter((u) => u.rect && u.placed && Math.abs(u.direction?.[1] || 0) < 0.1)
      .sort((a, b) => b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
    // A strip of images can have a short paragraph below each frame. Its
    // native type is often half the size of the body text on the same page.
    // Preserve those narrow, parallel text boxes as individual figure labels.
    const notes = ordered.filter(u => view && u.matched && u.role === "text" && !u.layoutPart &&
      !u.frontMatter && u.typeRole !== "footnote" && u.typeRole !== "reference" &&
      !u.title && !u.marker && u.size < base * .84 && u.rect[2] - u.rect[0] < (view[2] - view[0]) * .29);
    for (const u of notes) {
      const peers = notes.filter(v => Math.abs(v.rect[3] - u.rect[3]) < base * .65 &&
        Math.abs(v.size - u.size) < Math.max(.7, u.size * .16));
      const starts = new Set(peers.map(v => Math.round(v.rect[0] / base)));
      if (starts.size >= 3 && peers.some(v => v.rects.length > 1)) {
        u.typeRole = null;
        u.role = "figure_label";
        u.verifiedLabel = true;
      }
    }
    for (const u of ordered) {
      if (!(u.typeRole === "list" || u.title) || !u.matched || u.rects.length !== 1 || u.size >= base * .9)
        continue;
      const panels = ordered.filter(note => note.verifiedLabel && note.role === "figure_label" &&
        note.size < base * .84 && note.rect[0] >= u.rect[0] - base && note.rect[0] <= u.rect[2] &&
        note.rect[3] < u.rect[1] && u.rect[1] - note.rect[3] < base * 12);
      if (panels.length >= 2) {
        u.typeRole = null;
        u.role = "figure_label";
        u.verifiedLabel = true;
        u.labelBold = u.boldTitle;
      }
    }
    for (const u of ordered)
      if (u.typeRole === "list" && /^\([a-z]\)\s/iu.test(u.source)) {
        if (
          ordered.some(
            (c) =>
              c.typeRole === "figureCaption" &&
              c.rect[3] <= u.rect[1] + 1 &&
              c.rect[3] >= u.rect[1] - base * 4 &&
              c.rect[0] <= u.rect[0] + profile.base &&
              c.rect[2] >= u.rect[2] - profile.base
          )
        )
          u.typeRole = "figureCaption";
      }
    for (const u of ordered) {
      if (
        !u.title &&
        (u.typeRole === "body" || !u.typeRole) &&
        !u.layoutPart &&
        !u.verifiedLabel &&
        u.role === "text" &&
        u.rects.length <= 2 &&
        u.source.length < 110 &&
        !/[.!?。！？]$/u.test(u.source) &&
        (u.boldTitle || u.allItalic) &&
        u.size >= base * 0.98 &&
        ordered.some(
          (v) =>
            v !== u &&
            v.typeRole === "body" &&
            v.rects.length > 2 &&
            Math.abs(v.rect[0] - u.rect[0]) < base * 1.5 &&
            u.rect[1] - v.rect[3] >= -0.5 &&
            u.rect[1] - v.rect[3] < base * 2
        )
      )
        u.typeRole = role({ ...u, title: true }, { base }, refs);
    }
    const active = [];
    for (const u of ordered) {
      const isCaption = u.typeRole?.endsWith("Caption");
      if (
        !isCaption &&
        (!u.typeRole || ["body", "list"].includes(u.typeRole)) &&
        !u.verifiedLabel &&
        !u.layoutPart &&
        u.size <= base * 0.96 &&
        !u.verbatim
      ) {
        const prev = active.findLast((c) => {
          const gap = c.rect[1] - u.rect[3];
          return (
            gap >= -1 &&
            gap <= Math.max(c.size, u.size) * 0.61 &&
            Math.abs(c.rect[0] - u.rect[0]) <= base * 1.35 &&
            Math.min(c.rect[2], u.rect[2]) - Math.max(c.rect[0], u.rect[0]) > base * 3
          );
        });
        if (prev) {
          u.typeRole = prev.typeRole;
          u.captionGroup = prev.captionGroup;
        }
      }
      if (u.typeRole?.endsWith("Caption")) {
        u.captionGroup ??= u.owner ?? ordered.indexOf(u);
        active.push(u);
      }
    }
  }

  function captionLabel(fragment) {
    const doc = fragment.ownerDocument,
      walker = doc.createTreeWalker(fragment, 4),
      nodes = [];
    let prefix = "";
    while (prefix.length < 48 && walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement?.closest("[role=math],.katex,math")) break;
      nodes.push(n);
      prefix += n.data;
    }
    const label =
      /^\s*(?:(?:Fig(?:ure)?\.?|Table|Tab\.?|Chart|Algorithm)\s*|(?:[图圖表]|算法)\s*)(?:[A-Z]?\d+(?:[.‐-]\d+)*[a-z]?|[IVXLCDM]+)(?:[.:：、])?/iu.exec(
        prefix
      );
    if (!label) return;
    let left = label[0].length;
    for (const node of nodes) {
      if (!left) break;
      const length = Math.min(left, node.length);
      left -= length;
      if (!length || node.parentElement?.closest("strong,b")) continue;
      if (length < node.length) node.splitText(length);
      const bold = doc.createElementNS("http://www.w3.org/1999/xhtml", "strong");
      node.replaceWith(bold);
      bold.append(node);
    }
  }

  function styleFor(unit, profile) {
    const style = profile?.roles[unit.typeRole];
    if (style?.role === "runningTitle" && unit.boldTitle) return {...style,weight:700};
    if ((unit.typewriterBody || unit.typewriterHeading) && unit.size > 0 && profile?.roles.body) {
      const prose = unit.typewriterBody && unit.role !== "code_comment";
      const size = quarter(unit.size * (prose ? 1.07 : 1));
      return {...(style || profile.roles.body), size, step:quarter(size * (prose ? 1.26 : unit.pitch || 1.2)),
        before:0, after:0, family:"sans", weight:unit.typewriterHeading ? 700 : 400};
    }
    if (!style) return style;
    const heading = ["documentTitle", "heading", "subheading"].includes(style.role);
    if (!heading && !style.role.endsWith("Caption")) return style;
    const family = unit.fontFamily || style.family;
    const italic = !!(heading && unit.allItalic);
    if (family === style.family && !italic) return style;
    const weight = family === "sans" && style.weight === 550 ? 500 : style.weight;
    return { ...style, family, italic, weight };
  }

  // Match native table cells and diagram labels to their measured face.
  // Tiny axes and OCR labels without font metadata retain regular strokes.
  function labelFace(unit, language) {
    const table = unit.role === "table_label";
    if (!table && unit.role !== "figure_label") return null;
    const simpleHan = /^(?:zh|zh-CN|zh-Hans)$/iu.test(language);
    const native = unit.matched && !unit.inkMask && !!unit.fontFamily;
    const family = simpleHan && (table || native) ? (unit.fontFamily || "serif")
      : !table || (unit.sans && !/^zh(?:-|$)/iu.test(language)) ? "sans" : "serif";
    const medium = simpleHan && (table || (native && unit.size >= 6));
    return {family, weight:unit.labelBold ? 700 : medium ? 500 : 400};
  }

  function applyLabelFace(node, unit, language) {
    const style = labelFace(unit,language);
    if (!style) return;
    node.classList.toggle("dr-paper-sans",style.family === "sans");
    node.style.fontWeight = String(style.weight);
  }

  function sourceFamily(name) {
    if (
      /sans|NimbusSan|Helvetica|Arial|OptimisticDisp|CMSS|LMSans|Calibri|Aptos|Roboto|Inter(?=[-_.]|$)|Gothic|Biolinum/iu.test(
        name
      )
    )
      return "sans";
    if (/serif|Times|TeXGyreTermes|NimbusRom|STIX|Palatino|CMR|CMBX|LMRoman|SFRM|SFBX|Mincho|Libertine/iu.test(name))
      return "serif";
  }

  function apply(node, style, scale = 1) {
    node.dataset.typeRole = style.role;
    node.style.setProperty("--dr-paragraph-gap", style.after * scale + "px");
    node.style.fontSize = style.size * scale + "px";
    node.style.lineHeight = style.step * scale + "px";
    node.style.fontWeight = String(style.weight);
    node.style.fontStyle = style.italic ? "italic" : "normal";
    node.classList.toggle("dr-paper-sans", style.family === "sans");
  }
  DeepRead.PaperStyles = {styleFor,labelFace,applyLabelFace,sourceFamily,referenceHeading: text => bibliographyHeading.test(text.trim()),
    make,
    resolve,
    peek: (session) => sessions.get(session)?.profile || fallback,
    cover: session => sessions.get(session)?.cover || [],
    countPage,
    documentStructure,
    role,
    classify,
    captionLabel,
    apply
  };
})();
