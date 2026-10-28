/* Sparse suggested highlights for older results without model importance. License: AGPL-3.0-or-later */
(function () {
  function defaults(pages, roleOf = () => "") {
    const out = new Set();
    const weights = { contribution: 5, result: 5, method: 4, gap: 3, limitation: 3, background: 1, prior: 1 };
    for (const page of pages || []) {
      const candidates = [];
      let count = 0;
      for (const p of page.paragraphs || []) {
        if (!["text", "text_with_equation", "list"].includes(p.paragraphType)) continue;
        const points = p.points || [];
        count += points.length;
        if (points.some((pt) => pt.importance_source === "model" || pt.importance_level > 1)) continue;
        const pt = points.find((x) => x.summary && x.rects?.length);
        if (!pt || (p.paragraphText || "").length < 60) continue;
        candidates.push({ id: pt.id, score: weights[roleOf(`p_${page.pageIndex}_${p.paragraphIndex}`)] || 2 });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates.slice(0, Math.min(3, Math.max(1, Math.ceil(count * 0.2))))) out.add(candidate.id);
    }
    return out;
  }
  function select(pages, { density = "standard", roleOf = () => "", goal = "" } = {}) {
    const settings = { sparse: [0.1, 2], standard: [0.2, 4], detailed: [0.4, 8] };
    const out = new Map();
    if (density === "manual") return out;
    const [ratio, cap] = settings[density] || settings.standard;
    const preference = goal === "method" || goal === "reproduce" ? "method" : goal === "evidence" ? "result" : "contribution";
    for (const page of pages || []) {
      const candidates = [];
      let count = 0;
      for (const p of page.paragraphs || []) {
        if (!["text", "text_with_equation", "list"].includes(p.paragraphType)) continue;
        const role = roleOf(`p_${page.pageIndex}_${p.paragraphIndex}`);
        for (const [i, pt] of (p.points || []).entries()) {
          if (!pt.rects?.length) continue;
          count++;
          const model = pt.importance_source === "model" || pt.importance_level > 1;
          if (model && !(pt.importance_level > 1)) continue;
          if (!model && (!pt.summary || (p.paragraphText || "").length < 60)) continue;
          const level = model ? Number(pt.importance_level) : 2;
          const score = (model ? level * 10 : 10) + (role === preference ? 6 : 0)
            + (["contribution", "result", "method"].includes(role) ? 2 : 0) - i * 0.1;
          candidates.push({ id: pt.id, level, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates.slice(0, Math.min(cap, Math.max(1, Math.ceil(count * ratio))))) out.set(c.id, c.level);
    }
    return out;
  }
  DeepRead.Highlights = { defaults, select };
})();
