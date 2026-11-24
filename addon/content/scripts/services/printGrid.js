/* Restore the reader's baselines in Gecko's generated PDF text operators.
 * This operates only on the newly printed sheet, never on source PDFs.
 * License: AGPL-3.0-or-later */
(function () {
  const identity = [1, 0, 0, 1, 0, 0];
  const delimiter = /[\s\x00()[\]<>\/%]/u;
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
  const number = (value) => String(Number(value.toFixed(6)));

  function multiply(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  // Skip complete literal strings, names, arrays and hex strings. In particular
  // a font's encoded bytes inside TJ are never interpreted as PDF instructions.
  function endOf(data, start) {
    const c = data[start];
    let i = start + 1;
    if (c === "(") {
      let depth = 1;
      while (i < data.length && depth) {
        const ch = data[i++];
        if (ch === "\\") i++;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      return depth ? -1 : i;
    }
    if (c === "%") {
      while (i < data.length && data[i] !== "\n" && data[i] !== "\r") i++;
      return i;
    }
    if (c === "[" || (c === "<" && data[i] === "<")) {
      const end = c === "[" ? "]" : ">>";
      if (end === ">>") i++;
      while (i < data.length) {
        if (data.startsWith(end, i)) return i + end.length;
        if (/\s/u.test(data[i])) {
          i++;
          continue;
        }
        i = endOf(data, i);
        if (i < 0) return -1;
      }
      return -1;
    }
    if (c === "<") {
      const end = data.indexOf(">", i);
      return end < 0 ? -1 : end + 1;
    }
    while (i < data.length && !delimiter.test(data[i])) i++;
    return i;
  }

  function correction(m, ctm, lines, box) {
    const full = multiply(ctm, m);
    const size = Math.hypot(full[0], full[1]);
    if (!size) return null;
    const ux = full[0] / size,
      uy = -full[1] / size;
    const x = full[4] - box.x,
      y = box.y + box.height - full[5];
    const along = ux * x + uy * y;
    let best = null,
      error = 1.3;
    for (const line of lines) {
      if (
        Math.abs(line.size - size) > 0.04 ||
        ux * line.ux + uy * line.uy < 0.9999 ||
        along < line.left - 1.5 ||
        along > line.right + 1.5
      )
        continue;
      const diff = line.baseline - (-uy * x + ux * y);
      if (Math.abs(diff) < error) {
        error = Math.abs(diff);
        best = diff;
      }
    }
    if (best == null || error < 0.0005) return null;
    const dx = -uy * best,
      dy = -ux * best,
      det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    if (Math.abs(det) < 1e-9) return null;
    return [
      ...m.slice(0, 4),
      m[4] + (ctm[3] * dx - ctm[2] * dy) / det,
      m[5] + (-ctm[1] * dx + ctm[0] * dy) / det
    ];
  }

  function snap(data, lines, box) {
    if (!lines.length) return null;
    let ctm = identity,
      line = identity,
      leading = 0,
      active = false,
      shifted = false,
      last = 0;
    const stack = [],
      args = [],
      pieces = [];
    for (let i = 0; i < data.length; ) {
      if (/\s|\x00/u.test(data[i])) {
        i++;
        continue;
      }
      const start = i,
        c = data[i];
      i = endOf(data, i);
      if (i <= start) return null;
      if (c === "%") continue;
      const word = data.slice(start, i);
      if (c === "(" || c === "[" || c === "<" || c === "/" || numeric.test(word)) {
        args.push({ at: start, n: numeric.test(word) ? Number(word) : NaN });
        continue;
      }
      if (word === "BI" || word === "'" || word === '"') return null;
      const values = args.map((a) => a.n);
      if (word === "q") stack.push(ctm);
      else if (word === "Q") ctm = stack.pop() || identity;
      else if (word === "cm" && values.length === 6 && values.every(Number.isFinite))
        ctm = multiply(ctm, values);
      else if (word === "BT") {
        active = true;
        line = identity;
        shifted = false;
      } else if (word === "ET") {
        active = false;
        shifted = false;
      } else if (active && word === "TL") leading = values[0];
      else if (active && ["Tm", "Td", "TD", "T*"].includes(word)) {
        const expected = word === "Tm" ? 6 : word === "T*" ? 0 : 2;
        if (values.length !== expected || !values.every(Number.isFinite)) return null;
        if (word === "Tm") line = values;
        else if (word === "T*") line = multiply(line, [1, 0, 0, 1, 0, -leading]);
        else {
          line = multiply(line, [1, 0, 0, 1, values[0], values[1]]);
          if (word === "TD") leading = -values[1];
        }
        const adjusted = correction(line, ctm, lines, box);
        if (adjusted || (shifted && word !== "Tm")) {
          const pos = args[0]?.at ?? start;
          pieces.push(
            data.slice(last, pos),
            word === "TD" ? number(leading) + " TL\n" : "",
            (adjusted || line).map(number).join(" ") + " Tm"
          );
          last = i;
        }
        shifted = !!adjusted;
      }
      args.length = 0;
    }
    return pieces.length ? pieces.join("") + data.slice(last) : null;
  }
  DeepRead.PrintGrid = { snap };
})();
