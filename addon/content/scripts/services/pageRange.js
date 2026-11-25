/* Physical PDF page selections. Public page numbers start at one. AGPL-3.0-or-later. */
(function () {
  function parse(value, count) {
    const invalid = () =>
      new Error(
        DeepRead.bilingual(
          `页码范围为 1–${count}，可输入 1,3-5 或 8-。`,
          `Enter pages within 1–${count}, such as 1,3-5 or 8-.`
        )
      );
    if (!Number.isSafeInteger(count) || count < 1) throw invalid();
    const selected = new Set();
    for (const part of String(value ?? "")
      .normalize("NFKC")
      .trim()
      .replace(/、/gu, ",")
      .replace(/[–—－]/gu, "-")
      .split(",")) {
      const m = /^(?:(\d+)|(?:(\d*)\s*-\s*(\d*)))$/u.exec(part.trim());
      if (!m || (!m[1] && !m[2] && !m[3])) throw invalid();
      const first = Number(m[1] || m[2] || 1),
        last = Number(m[1] || m[3] || count);
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first < 1 ||
        last < first ||
        last > count
      )
        throw invalid();
      for (let i = first - 1; i < last; i++) selected.add(i);
    }
    return [...selected].sort((a, b) => a - b);
  }

  function runs(indices) {
    const groups = [];
    for (const i of indices) {
      const last = groups.at(-1);
      if (last && i === last.at(-1) + 1) last.push(i);
      else groups.push([i]);
    }
    return groups;
  }

  function format(indices) {
    return runs(indices)
      .map((group) => (group.length === 1 ? String(group[0] + 1) : group[0] + 1 + "-" + (group.at(-1) + 1)))
      .join(",");
  }

  function normalized(indices, count) {
    if (
      !Array.isArray(indices) ||
      !indices.length ||
      indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count)
    ) {
      throw new Error(DeepRead.bilingual("请选择有效的 PDF 页码。", "Choose valid PDF pages."));
    }
    return [...new Set(indices)].sort((a, b) => a - b);
  }

  function remap(items, indices) {
    return items
      .filter((it) => Number.isInteger(it.page_idx) && indices[it.page_idx] != null)
      .map((it, i) => ({
        ...it,
        id: "range:" + indices[0] + ":" + (it.id ?? i),
        page_idx: indices[it.page_idx],
        ...(it.physicalParts?.length
          ? {
              physicalParts: it.physicalParts
                .filter((p) => indices[p.page_idx] != null)
                .map((p) => ({ ...p, page_idx: indices[p.page_idx] }))
            }
          : {})
      }));
  }

  DeepRead.PageRange = { parse, runs, format, normalized, remap };
})();
