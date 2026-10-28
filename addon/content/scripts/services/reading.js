/* Reading goals, evidence notes and state migration. License: AGPL-3.0-or-later */
(function () {
  const GOALS = [
    { key: "overview", zh: "判断是否值得读", en: "Screen relevance", sections: ["front", "intro", "discussion"], hintZh: "先看研究问题和主要结论，再决定是否深入。", hintEn: "Check the question and main conclusion before going deeper." },
    { key: "method", zh: "理解方法", en: "Understand the method", sections: ["method", "experiment"], hintZh: "解释关键设计为什么必要，再检查实验支持。", hintEn: "Explain why each key design is needed, then check the evidence." },
    { key: "evidence", zh: "核对证据", en: "Check the evidence", sections: ["experiment", "discussion"], hintZh: "先判断图表支持什么，再对照作者的结论与限制。", hintEn: "Interpret the figures, then compare the claims and limits." },
    { key: "reproduce", zh: "准备复现", en: "Prepare to reproduce", sections: ["method", "experiment", "appendix"], hintZh: "记录输入、关键参数、对照条件，以及还缺哪些细节。", hintEn: "Record inputs, key parameters, controls and missing details." },
  ];
  const FIELDS = [
    { key: "setup", zh: "比较谁，测量什么？", en: "What is compared and measured?" },
    { key: "observation", zh: "数据实际显示了什么？", en: "What do the data show?" },
    { key: "interpretation", zh: "支持哪个结论？有什么限制？", en: "Which claim is supported, and what are the limits?" },
  ];
  const goal = (key) => GOALS.find((g) => g.key === key) || null;
  function targets(key, sections = [], figures = []) {
    const g = goal(key);
    if (!g) return [];
    const out = [];
    if (key === "evidence" && figures.length) out.push({ kind: "figure", figure: figures[0] });
    for (const role of g.sections) {
      const section = sections.find((s) => s.role === role);
      if (section) out.push({ kind: "section", section });
    }
    return out;
  }
  const rows = (data) => (data || []).flatMap((p) => (p.paragraphs || []).map((r) => ({ ...r, pageIndex: p.pageIndex, key: `p_${p.pageIndex}_${r.paragraphIndex}` })));
  const norm = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim();

  // Paragraph IDs can change when a parser changes. Never attach a personal note
  // to a different paragraph just because its numeric ID happens to be the same.
  function carryState(state = {}, oldData, newData) {
    const next = { ...state, pointImportance: {}, notes: {}, edits: {}, hidden: {}, cardGroups: {}, readUpTo: 0 };
    const before = new Map(rows(oldData).map((p) => [p.key, p]));
    const after = rows(newData), mapped = new Map();
    for (const [key, p] of before) {
      const quote = norm(p.paragraphText);
      if (!quote) continue;
      const matches = after.filter((n) => norm(n.paragraphText) === quote);
      // A unique match is safer than reusing coordinates or fuzzy text guesses.
      if (matches.length === 1) mapped.set(key, matches[0].key);
    }
    next.unmappedNotes = [...(state.unmappedNotes || [])];
    for (const [key, note] of Object.entries(state.notes || {})) {
      const target = mapped.get(key);
      if (target) next.notes[target] = note;
      else if (note?.text) next.unmappedNotes.push({ ...note, originalKey: key, quote: before.get(key)?.paragraphText || "" });
    }
    for (const field of ["edits", "hidden"]) for (const [key, value] of Object.entries(state[field] || {})) {
      if (mapped.has(key)) next[field][mapped.get(key)] = value;
    }
    // Paper-level goals, evidence notes, self-answers and highlight density survive.
    return next;
  }
  DeepRead.Reading = { GOALS, FIELDS, goal, targets, carryState };
})();
