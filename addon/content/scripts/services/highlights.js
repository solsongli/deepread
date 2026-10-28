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
  DeepRead.Highlights = { defaults };
})();
