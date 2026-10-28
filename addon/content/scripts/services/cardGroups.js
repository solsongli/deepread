/* Card grouping independent of AI explanation storage. License: AGPL-3.0-or-later */
(function () {
  const textType = (p) => ["text", "text_with_equation", "list"].includes(p?.paragraphType);
  const key = (p) => `p_${p.pageIndex}_${p.paragraphIndex}`;
  const bounds = (p) => {
    const r = (p.rects || []).filter((r) => r?.length === 4);
    return r.length ? [Math.min(...r.map((v) => v[0])), Math.min(...r.map((v) => v[1])),
      Math.max(...r.map((v) => v[2])), Math.max(...r.map((v) => v[3]))] : null;
  };
  function continues(a, b) {
    if (!textType(a) || !textType(b)) return false;
    const left = (a.paragraphText || "").trim(), right = (b.paragraphText || "").trim();
    if (left.length < 15 || !/^\p{Ll}/u.test(right) || /[.!?。！？:：;；][\s"'”’)]*$/.test(left)) return false;
    // Cross-page continuity needs the joint-translation confirmation below.
    if (b.pageIndex !== a.pageIndex) return false;
    const A = bounds(a), B = bounds(b);
    if (!A || !B) return false;
    const size = a.typography?.fontSize || 10;
    const gap = A[1] - B[3];
    return gap >= -size * 0.3 && gap <= size * 1.8 && Math.abs(A[0] - B[0]) <= size * 2
      && Math.abs((A[2] - A[0]) - (B[2] - B[0])) <= Math.max(size * 3, (A[2] - A[0]) * 0.3);
  }
  function build(pages, explanations = {}, overrides = {}, auto = true) {
    const rows = (pages || []).flatMap((page) => (page.paragraphs || []).map((p) => ({ ...p, pageIndex: page.pageIndex })));
    const order = new Map(rows.map((p, i) => [key(p), i]));
    const parent = new Map(rows.map((p) => [key(p), key(p)]));
    const root = (k) => { while (parent.has(k) && parent.get(k) !== k) k = parent.get(k); return k; };
    const join = (a, b, acrossVisual = false) => {
      const i = order.get(a), j = order.get(b);
      if (i === undefined || j === undefined || j <= i || !textType(rows[i]) || !textType(rows[j])) return;
      if (j !== i + 1 && !(acrossVisual && rows.slice(i + 1, j).every((p) => DeepRead.Continuations?.isVisual(p)
        || ["image", "table", "chart", "figure"].includes(p.paragraphType)))) return;
      const x = overrides[a], y = overrides[b];
      if ((x || y) && !(Array.isArray(x) && Array.isArray(y) && x.includes(b) && y.includes(a))) return;
      parent.set(root(b), root(a));
    };
    for (const entry of Object.values(explanations)) {
      const members = entry?.members || [];
      for (let i = 1; i < members.length; i++) join(members[i - 1], members[i]);
    }
    for (const row of rows) {
      const members = row.continuation?.keys || [];
      for (let i = 1; i < members.length; i++) join(members[i - 1], members[i], true);
    }
    if (auto) for (let i = 1; i < rows.length; i++) if (continues(rows[i - 1], rows[i])) join(key(rows[i - 1]), key(rows[i]));
    for (const members of Object.values(overrides)) {
      if (!Array.isArray(members)) continue;
      for (let i = 1; i < members.length; i++) join(members[i - 1], members[i]);
    }
    const groups = new Map(), leads = new Map();
    for (const p of rows) {
      const k = key(p), lead = root(k);
      leads.set(k, lead);
      if (!groups.has(lead)) groups.set(lead, []);
      groups.get(lead).push(k);
    }
    return { groups, leads, rows, order };
  }
  DeepRead.CardGroups = { build, continues, textType };
})();
