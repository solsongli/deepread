/* Place measured lines in continuous source columns, between fixed artwork.
 * License: AGPL-3.0-or-later */
(function () {
  const right = (r) => r.left + r.width,
    bottom = (r) => r.top + r.height;
  function turn(r, q, w, h) {
    if (q === 1) return { left: r.top, top: w - right(r), width: r.height, height: r.width };
    if (q === 2) return { left: w - right(r), top: h - bottom(r), width: r.width, height: r.height };
    if (q === 3) return { left: h - bottom(r), top: r.left, width: r.height, height: r.width };
    return { ...r };
  }
  const screen = (frame, q, page) =>
    turn(frame, (4 - q) % 4, q % 2 ? page.height : page.width, q % 2 ? page.width : page.height);
  const overlaps = (a, b, t = 0.3) =>
    Math.min(right(a), right(b)) - Math.max(a.left, b.left) > t &&
    Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top) > t;

  // Integral image of ink left on the page after the English paragraphs were
  // erased. Even a thin rule or a formula missed by the parser separates runs.
  function backdrop(canvas, page) {
    const scale = Math.min(1, 1000 / Math.max(page.width, page.height));
    const sample = canvas.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    sample.width = Math.ceil(page.width * scale);
    sample.height = Math.ceil(page.height * scale);
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    const w = sample.width,
      h = sample.height,
      stride = w + 1,
      sums = new Uint32Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
      let count = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 211) count++;
        sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + count;
      }
    }
    sample.width = sample.height = 0;
    return (r) => {
      const x0 = Math.max(0, Math.ceil(r.left * scale)),
        x1 = Math.min(w, Math.floor(right(r) * scale));
      const y0 = Math.max(0, Math.ceil(r.top * scale)),
        y1 = Math.min(h, Math.floor(bottom(r) * scale));
      return (
        x1 > x0 &&
        y1 > y0 &&
        sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0] > 0
      );
    };
  }

  function folios(page) {
    const boxes = [],
      view = page.view;
    let run = [];
    function finish() {
      if (!run.length) return;
      const text = run
        .map((c) => c.u ?? c.c ?? "")
        .join("")
        .replace(/\s+/gu, "");
      if (!/^(?:page)?(?:\d{1,4}|[ivxlcdm]{1,6})(?:\/\d{1,4})?$/iu.test(text)) return;
      const rect = DeepRead.Overlay.unionRect(run.map((c) => c.rect));
      if (rect[3] <= view[1] + (view[3] - view[1]) * 0.075)
        boxes.push(DeepRead.ParallelInk.project(rect, page.transform));
    }
    for (const c of page.chars || []) {
      if (c.rect) run.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) {
        finish();
        run = [];
      }
    }
    finish();
    return boxes;
  }

  // Lay out continuous prose between fixed artwork, using the source column
  // and its paragraph/heading gaps. Empty space left by a shorter translation
  // is shared across the section, with one bounded leading for its body text.
  function alignedColumns(entries,page) {
    const base=page.styleProfile.base;
    const reading=entries.filter(e=>e.style && ["body","list","heading","subheading"].includes(e.style.role));
    const bounds=e=>e.sourceRect || e.rect;
    for (let i=1;i<reading.length;i++) {
      const left=reading[i-1], rightHead=reading[i], a=bounds(left), b=bounds(rightHead);
      if (!left.metrics?.prose || !rightHead.metrics?.prose || left.angle || rightHead.angle ||
          !left.unit.matched || !rightHead.unit.matched || left.overflow || rightHead.overflow ||
          a.width>=page.width*.5 || Math.abs(a.width-b.width)>base ||
          b.left-right(a)<base*.6 || b.left-right(a)>base*8 ||
          bottom(a)<page.height*.70 || bottom(a)-b.top<page.height*.35) continue;
      const lhs=left.unit.source.trim(), rhs=rightHead.unit.source.trim();
      const citation=/\bet\s+al\.$/iu.test(lhs) && /^[([]\s*(?:19|20)\d{2}/u.test(rhs);
      const number=/^\((\d{1,3})\)/u.exec(rhs);
      const enumeration=number && Number(number[1])>1 && /\b(?:and|or)\s*$/iu.test(lhs) &&
        lhs.includes("("+String(Number(number[1])-1)+")");
      const continuing=!/[.!?。！？:：;；][”’)"'\]]?$/u.test(lhs) &&
        (/^\p{Ll}/u.test(rhs) || enumeration);
      if (!citation && !continuing) continue;
      const inColumn=(r,c)=>Math.abs(r.left-c.left)<base*2 && r.width<c.width+base*2;
      if (reading.some(e=>e!==left && inColumn(bounds(e),a) && bounds(e).top>bottom(a)-base*.25) ||
          reading.some(e=>e!==rightHead && inColumn(bounds(e),b) && bottom(bounds(e))<b.top+base*.25)) continue;
      return {left,rightHead};
    }
    return null;
  }

  function alignParagraphs(entries, page, hasInk, crossing) {
    const base = page.styleProfile.base;
    const source = e => e.sourceRect || e.frame;
    const heading = e => e.style?.role === "heading" || e.style?.role === "subheading";
    const groups = [];
    const eligible = entries.filter(e => e.angle === 0 && e.unit.matched && e.metrics?.setLeading &&
      !e.metrics.wide && e.metrics.lines.length && (["body","list"].includes(e.style?.role) ||
        (heading(e) && e.metrics.lines.length === 1 && !e.unit.centered)));
    for (const entry of eligible.sort((a,b) => source(a).top - source(b).top)) {
      const rect = source(entry);
      const group = groups.findLast(run => {
        const prev = run.at(-1), previous = source(prev), gap = rect.top - bottom(previous);
        const listIndent = prev.style.role === "list" || entry.style.role === "list";
        const column = run.find(e => !heading(e));
        return gap >= -base * .2 && gap <= base * (heading(prev) || heading(entry) ? 3.6 : 1.95) &&
          Math.abs(previous.left - rect.left) <= base * (listIndent ? 2.2 : 1) &&
          (heading(entry) || !column || Math.abs(right(source(column))-right(rect)) <= base) &&
          !hasInk({left:rect.left, top:bottom(previous), width:rect.width, height:Math.max(0,gap)});
      });
      if (group) group.push(entry);
      else groups.push([entry]);
    }
    for (const run of groups) {
      // Keep a lone title with the section that follows it.
      if (heading(run.at(-1))) run.pop();
      if (!run.length || (run.length === 1 && (!run[0].overflow || run[0].metrics.lines.length < 4))) continue;
      const first=run[0], last=run.at(-1), body=run.find(e=>!heading(e));
      if (!body) continue;
      const start = first.anchorTop + first.metrics.lines[0].top;
      let room = bottom(source(last)) - start;
      let intervals = 0, glyphHeight = 0;
      const gaps = [];
      const ordinary = [];
      for (const [i,e] of run.entries()) {
        const m = e.metrics, n = m.lines.length - 1;
        intervals += n;
        glyphHeight += m.inkHeight - m.lines[0].top - n * m.step;
        if (!i) continue;
        const special = heading(e) || heading(run[i-1]);
        const printed = source(e).top - bottom(source(run[i-1]));
        const gap = Math.max(base*(special ? .65 : .35), Math.min(base*(special ? 3.6 : 1.95), printed));
        gaps.push(gap);
        if (!special) ordinary.push(gap);
      }
      if (!intervals) continue;
      ordinary.sort((a,b)=>a-b);
      for (let i=0; i<gaps.length; i++)
        if (!heading(run[i]) && !heading(run[i+1])) gaps[i]=ordinary[Math.floor(ordinary.length/2)];
      const desired = gaps.reduce((a,b)=>a+b,0);
      let minimumStep = body.style.step;
      if (run.some(e => e.overflow)) {
        minimumStep = Math.max(body.style.size * 1.18, body.style.step * .9);
        for (const {metrics} of run) {
          for (let j = 1; j < metrics.lines.length; j++) {
            const prev = metrics.lines[j-1], next = metrics.lines[j];
            const clear = next.top - prev.top - prev.height;
            minimumStep = Math.max(minimumStep, metrics.step - clear + .35);
          }
        }
      }
      const lendsSpace = crossing?.left===last;
      if (lendsSpace) {
        // Keep one complete continuation line available when the existing
        // column can do so at its ordinary body leading and paragraph gaps.
        const natural=glyphHeight+intervals*minimumStep+desired;
        room-=Math.min(body.style.step*1.65,Math.max(0,room-natural));
      }
      // Two narrow text columns often have more lines of short translated
      // prose. Use slightly more leading within those paired columns before
      // putting the spare space in visibly larger paragraph/section breaks.
      const column=source(body);
      const overlapsColumnHeight = r => r.top<bottom(source(last)) && bottom(r)>source(first).top;
      const facingArtwork=entries.some(e => {
        if (!(e.unit.verifiedLabel || e.style?.role.endsWith("Caption"))) return false;
        const r=source(e);
        return (r.left>right(column) || right(r)<column.left) && overlapsColumnHeight(r);
      });
      const paired=!facingArtwork && column.width<page.width*.49 && eligible.some(other=>{
        const r=source(other);
        return other!==body && !heading(other) && other.metrics.lines.length>1 &&
          Math.abs(r.width-column.width)<base*1.8 && (r.left>right(column) || right(r)<column.left) &&
          overlapsColumnHeight(r);
      });
      // Small type in dense parallel columns can use a more open baseline
      // grid. A 16 pt ceiling on the extra leading keeps larger body faces
      // from displacing intervening headings; the normal em limit still
      // applies when the original type is already larger.
      const ordinaryLimit = body.style.size * 1.48;
      const maximumStep = lendsSpace ? ordinaryLimit : paired
        ? Math.min(body.style.size * 1.65, Math.max(16, ordinaryLimit))
        : ordinaryLimit;
      const step = Math.max(minimumStep, Math.min(maximumStep, (room-glyphHeight-desired)/intervals));
      // If the Chinese copy needs another line, tighten gaps only to their
      // document rhythm. Oversized groups fall back to the collision-safe frames.
      const spacing = desired ? Math.max(.8, Math.min(run.some(heading) ? 1.45 : 1.12,
        (room-glyphHeight-intervals*step)/desired)) : 1;
      const placedGaps = gaps.map((gap,i) => {
        const scaled=gap*spacing;
        if (!paired) return scaled;
        if (heading(run[i])) return Math.min(scaled,base*1.5);
        if (heading(run[i+1])) return Math.min(scaled,base*2.9);
        return scaled;
      });
      let spare = room - glyphHeight - intervals * step - placedGaps.reduce((a,b)=>a+b,0);
      let nextTop = start, lastAnchor = 0;
      for (const [i,e] of run.entries()) {
        // In a long column, short translated paragraphs can move a later
        // section upward by many lines. Distribute free room across its
        // preceding paragraph breaks, keeping the heading near the source.
        const columnEnd = !lendsSpace && i === run.length - 1 && !heading(e) && run.length >= 3 &&
          room > page.height * .35 && bottom(source(last)) > page.height * .78;
        const drift = columnEnd ? spare : source(e).top - nextTop;
        if (i > lastAnchor && spare > 0 && (heading(e) || columnEnd) && drift > body.style.step * 3) {
          const capacity = gaps.slice(lastAnchor,i).map((gap,j) => {
            const target = lastAnchor+j+1;
            // A heading and the opening line beneath it stay together. For
            // the final paragraph of a full column, spread the slack across
            // readable paragraph breaks without creating a large final gap.
            if (heading(run[target-1]))
              return columnEnd ? 0 : Math.max(0, base * 1.65 - placedGaps[target-1]);
            const limit = base * (columnEnd ? 2 : heading(run[target]) ? 3 : 4);
            return Math.max(0, Math.min(limit, gap * (columnEnd ? 2 : 6)) - placedGaps[target-1]);
          });
          const total = capacity.reduce((sum,gap) => sum+gap,0);
          const extra = Math.min(spare,total,drift - body.style.step * (columnEnd ? .6 : 2));
          if (extra > 0) {
            capacity.forEach((gap,j) => { placedGaps[lastAnchor+j] += extra * gap / total; });
            nextTop += extra;
            spare -= extra;
            lastAnchor = i;
          }
        }
        const m=e.metrics;
        nextTop += m.inkHeight-m.lines[0].top+(m.lines.length-1)*(step-m.step)+(placedGaps[i] || 0);
      }
      const reserved = entries.filter(e => !run.includes(e)).map(e => e.occupied);
      const placements = [];
      let y = start;
      for (const [i,e] of run.entries()) {
        const m = e.metrics, top = y - m.lines[0].top, delta = step - m.step;
        const lines = m.lines.map((line,j) => ({...line,top:line.top+j*delta}));
        const hits = lines.some(line => {
          const rect = {...line,left:e.frame.left+line.left,top:top+line.top};
          return reserved.some(r=>overlaps(r,rect)) || hasInk(rect);
        });
        if (hits) break;
        const height = m.inkHeight + (lines.length-1)*delta;
        placements.push({e,top,height,lines});
        y=top+height+(placedGaps[i] || 0);
      }
      if (placements.length !== run.length || y > bottom(source(last))+.5) continue;
      if (crossing && run[0]===crossing.rightHead) crossing.following=run.slice(1);
      for (const {e,top,height,lines} of placements) {
        if (lines.length > 1) {
          e.metrics.setLeading(step);
          e.metrics.step=step;
        }
        Object.assign(e.metrics,{lines,inkHeight:height,height:lines.length*e.metrics.step});
        Object.assign(e,{top,height,overflow:false,paintRect:{...e.frame,top,height}});
        e.occupied={...e.frame,top:top+lines[0].top,height:height-lines[0].top};
      }
    }
  }

  function flowAcrossColumns(crossing,entries,page,hasInk) {
    const {left,rightHead,following}=crossing;
    if (!following?.length) return;
    const prose=rightHead.metrics.prose, tail=left.metrics.lines.at(-1);
    const em=left.style.size, step=left.metrics.step;
    const inset=tail.left+tail.width+em*.15;
    const join=inset+em*3<left.frame.width;
    const baseline=left.top+left.metrics.firstBaseline+(left.metrics.lines.length-(join?1:0))*step;
    const limit=bottom(left.sourceRect || left.frame);
    const room=limit-baseline+em;
    if (room<em) return;
    const ends=[];
    for (const match of prose.text.matchAll(/[。！？!?]+[”’」』）】]*/gu)) {
      const end=match.index+match[0].length;
      ends.push(end);
    }
    ends.push(prose.text.length);
    const reserved=entries.filter(e=>e!==left && e!==rightHead && !following.includes(e));
    const free=(line,others)=>!others.some(e=>overlaps(line,e.occupied)) && !hasInk(line);
    const fits=(metrics,x,y,low,others)=>!metrics.wide && metrics.lines.every(l=>{
      const r={left:x+l.left,top:y+l.top,width:l.width,height:l.height};
      return bottom(r)<=low+.25 && free(r,others);
    });
    let selected=null, endAt=0, prefixTop=0;
    for (const end of new Set(ends)) {
      if (!prose.text.slice(0,end).trim()) continue;
      const part=prose.part(0,end,join?inset:0,left.frame.width,step);
      const y=baseline-part.metrics.firstBaseline;
      if (!fits(part.metrics,left.frame.left,y,limit,reserved.concat(following))) {
        part.block.remove();
        break;
      }
      selected?.block.remove(); selected=part; endAt=end; prefixTop=y;
    }
    if (!selected) return;
    const suffix=prose.text.slice(endAt).trim()
      ? prose.part(endAt,prose.text.length,0,rightHead.frame.width,rightHead.metrics.step) : null;
    const suffixTop=rightHead.top+rightHead.metrics.firstBaseline-(suffix?.metrics.firstBaseline||0);
    const newBottom=suffix ? suffixTop+suffix.metrics.inkHeight : rightHead.top;
    const shift=bottom(rightHead.occupied)-newBottom;
    if (shift<em*.7 || (suffix && !fits(suffix.metrics,rightHead.frame.left,suffixTop,
        bottom(rightHead.occupied)+.25,reserved.concat(left)))) {
      selected.block.remove(); suffix?.block.remove(); return;
    }
    const move=[];
    for (const e of following) {
      const y=e.top-shift;
      const swept={left:e.frame.left,top:y,width:e.frame.width,height:shift};
      if (!free(swept,reserved) || !fits(e.metrics,e.frame.left,y,page.height,reserved)) break;
      move.push(e);
    }
    if (!move.length) {selected.block.remove();suffix?.block.remove();return;}
    let offsets=move.map(()=>shift);
    const last=move.at(-1), sourceEnd=bottom(last.sourceRect || last.frame);
    // When the column ends at fixed printed matter, moving every section by
    // exactly the same amount leaves all of the freed space at that boundary.
    // Return a small part across existing section/paragraph breaks. The
    // first heading and its opening stay with the continuation; head-to-body
    // spacing, body leading, font sizes and the fixed object are preserved.
    let anchor;
    if (last.style.role==="body" && shift>em*.85) {
      const searchEnd=Math.min(sourceEnd+4*em,page.height-em*2);
      for (let y=sourceEnd; y<searchEnd; y+=2) {
        const band={left:last.frame.left,top:y,width:last.frame.width,height:2};
        if ((page.folios||[]).some(r=>overlaps(band,r))) break;
        if (hasInk(band) || reserved.some(e=>overlaps(band,e.occupied))) {anchor=y;break;}
      }
    }
    let fixedBibliography=false, fixedFootnote=false;
    if (anchor!==undefined && anchor-bottom(last.occupied)+shift>4*em) {
      const heading=(page.chars || []).filter(c=>{
        if (!c.rect || c.rotation) return false;
        const r=DeepRead.ParallelInk.project(c.rect,page.transform);
        const x=r.left+r.width/2, y=r.top+r.height/2;
        return x>=last.frame.left-.5 && x<=right(last.frame)+.5 && y>=anchor-em*.15 && y<=anchor+em;
      }).map(c=>(c.u||c.c||"")+(c.spaceAfter?" ":"")).join("");
      fixedBibliography=shift>2*em && DeepRead.PaperStyles.referenceHeading(heading);
      // A footnote separator is often the first remaining ink before its
      // note. Match the classified source note in this column; a rule by
      // itself could just as easily belong to a figure or display equation.
      fixedFootnote=reserved.some(e=>{
        if (e.style?.role!=="footnote" || e.angle!==0 || !e.unit.matched) return false;
        const note=e.sourceRect || e.frame;
        return Math.abs(note.left-last.frame.left)<em*1.5 && note.width>=last.frame.width*.55 &&
          note.top>=anchor-em*.5 && note.top<=anchor+em*1.25;
      });
    }
    if (fixedBibliography || fixedFootnote) {
      const gaps=move.map((e,i)=>{
        const prev=move[i-1];
        // In front of a fixed note, also use the real paragraph break after
        // the continued sentence. Never widen a heading-to-body gap.
        if (prev ? prev.style.role!=="body" : !(fixedFootnote && suffix && e.style.role==="body")) return 0;
        const gap=e.occupied.top-bottom((prev || rightHead).occupied);
        return gap>em*.3 && gap<em*3.8 ? Math.min(em*.75,gap*.38) : 0;
      });
      const capacity=gaps.reduce((sum,gap)=>sum+gap,0);
      if (capacity) {
        const release=fixedFootnote ? Math.min(last.metrics.step,shift,capacity)
          : Math.min(em,shift*.35,capacity);
        let paid=0;
        const planned=gaps.map(gap=>{
          paid+=release*gap/capacity;
          return shift-paid;
        });
        if (move.every((e,i)=>fits(e.metrics,e.frame.left,e.top-planned[i],page.height,reserved)))
          offsets=planned;
      }
    }
    const fragments=[];
    function place(block,metrics,x,y,width,lines) {
      const height=lines.at(-1).top+lines.at(-1).height;
      const bounds={left:x,top:y,width,height};
      block.style.visibility="";
      block.style.width=width+"px";
      block.style.height=height+"px";
      block.dataset.paintRect=[x,y,width,height].join(" ");
      fragments.push({...rightHead,block,metrics:{...metrics,lines,inkHeight:height},
        frame:bounds,paintRect:bounds,occupied:bounds,top:y,height});
    }
    const {block,metrics}=selected;
    const lines=metrics.lines;
    if (join) {
      // The translated owners share only this baseline. Give its suffix a
      // tight box so the preceding text remains selectable and hoverable.
      const firstBox=block.cloneNode(false);
      const copy=block.querySelector(".dr-parallel-copy");
      const firstCopy=copy.cloneNode(false),row=copy.firstElementChild;
      firstCopy.append(row);firstBox.append(firstCopy);block.before(firstBox);
      row.firstElementChild.style.left="0px";
      place(firstBox,metrics,left.frame.left+lines[0].left,prefixTop,lines[0].width+.2,[{...lines[0],left:0}]);
      const leftRows=left.metrics.lines, last=leftRows.at(-1);
      const lastTop=left.top+last.top;
      left.block.dataset.paintRects=JSON.stringify([
        ...(leftRows.length>1 ? [[left.frame.left,left.top,left.frame.width,lastTop-left.top]] : []),
        [left.frame.left+last.left,lastTop,last.width,last.height]
      ]);
      if (lines.length>1) place(block,metrics,left.frame.left,prefixTop+step,left.frame.width,
        lines.slice(1).map(l=>({...l,top:l.top-step})));
      else block.remove();
    } else place(block,metrics,left.frame.left,prefixTop,left.frame.width,lines);
    if (suffix) place(suffix.block,suffix.metrics,rightHead.frame.left,suffixTop,rightHead.frame.width,suffix.metrics.lines);
    // part() inserted siblings before the original owner in source order.
    // Remove that one original rendering only after both replacements fit.
    rightHead.block.remove();
    entries.splice(entries.indexOf(rightHead),1,...fragments);
    for (const [i,e] of move.entries()) {
      const dy=offsets[i];
      e.top-=dy; e.paintRect={...e.paintRect,top:e.paintRect.top-dy};
      e.occupied={...e.occupied,top:e.occupied.top-dy};
    }
    return true;
  }

  function arrange(entries, page, hasInk) {
    for (const e of entries) {
      e.frame = turn(e.rect, e.angle, page.width, page.height);
      e.occupied = e.rect;
    }
    const base = page.styleProfile.base,
      styled = entries.filter((e) => e.style);
    // A contents label stops at its last letter, before the printed dot
    // leaders. Use the measured blank gap before allowing the label to wrap.
    for (const e of styled) {
      const quote = e.style.role === "body" && /^[“"].+[”"]$/u.test(e.unit.source);
      const comment = e.unit.typewriterBody && e.unit.role === "code_comment";
      const title = e.style.role === "documentTitle" && e.unit.centered;
      if ((!quote && !comment && !title && e.style.role !== "contents") || e.unit.rects.length !== 1 ||
          !(e.metrics.lines?.length > 1) || !e.metrics.rewrap) continue;
      const sides = quote || title ? [-1, 1] : [1];
      const f = e.frame;
      const natural = e.metrics.lines.reduce((sum, line) => sum + line.width, 0);
      const needed = Math.ceil((natural + 2 - f.width) / sides.length);
      let room = 0;
      for (let d = 1; d <= Math.min(needed, base * (comment ? 12 : 5)); d++) {
        const blocked = sides.some(side => {
          const x = side === 1 ? right(f) + d - 1 : f.left - d;
          const strip = screen({...f, left:x, width:1}, e.angle, page);
          return strip.left < 0 || right(strip) > page.width || hasInk(strip) ||
            entries.some(other => other !== e && overlaps(strip, other.occupied));
        });
        if (blocked) break;
        room = d;
      }
      if (!room) continue;
      if (quote || title) f.left -= room;
      f.width += room * sides.length;
      e.metrics = e.metrics.rewrap(f.width);
      e.rect = e.occupied = screen(f, e.angle, page);
    }
    // A one-line source frame often covers just its ink. Give the translation
    // the rest of the verified column if the neighboring area is empty.
    for (const e of styled) {
      const list = e.style.role === "list";
      const narrowProse = (e.style.role === "body" || list) && e.unit.matched;
      if (
        (!narrowProse && !["heading", "subheading", "documentTitle", "reference"].includes(e.style.role)) ||
        e.unit.rects.length !== 1 ||
        !(e.metrics.lines?.length > 1) ||
        !e.metrics.rewrap
      )
        continue;
      const frame = e.frame,
        middle = frame.left + frame.width / 2;
      const columnRole = e.style.role === "reference" ? "reference" : "body";
      const columns = styled.filter((o) => o.angle === e.angle &&
        (o.style.role === columnRole || (list && o.style.role === "list")));
      let column;
      if (e.style.role === "documentTitle" && e.unit.centered && columns.length) {
        const left = Math.min(...columns.map((o) => o.frame.left));
        const end = Math.max(...columns.map((o) => right(o.frame)));
        column = { left, width: end - left };
      } else {
        column = columns
          .map((o) => o.frame)
          .filter(
            (r) =>
              Math.min(Math.abs(r.top - bottom(frame)), Math.abs(frame.top - bottom(r))) < base * 8 &&
              r.width > frame.width &&
              (Math.abs(r.left - frame.left) <= base * 1.65 ||
                (e.unit.centered && Math.abs(r.left + r.width / 2 - middle) < base))
          )
          .sort((a, b) => Math.abs(a.top - bottom(frame)) - Math.abs(b.top - bottom(frame)))[0];
      }
      if (!column) continue;
      const room = e.unit.centered
        ? Math.min(frame.left - column.left, right(column) - right(frame))
        : right(column) - right(frame);
      if (room < 1) continue;
      const strips = [{ ...frame, left: right(frame), width: room }];
      if (e.unit.centered) strips.push({ ...frame, left: frame.left - room, width: room });
      if (
        strips.some((r) => {
          const box = screen(r, e.angle, page);
          return hasInk(box) || entries.some((o) => o !== e && overlaps(box, o.occupied));
        })
      )
        continue;
      if (e.unit.centered) frame.left -= room;
      frame.width += room * strips.length;
      e.metrics = e.metrics.rewrap(frame.width);
      e.rect = e.occupied = screen(frame, e.angle, page);
    }
    for (const e of styled) {
      if (!e.metrics.wide || !e.metrics.rewrap || e.unit.justified) continue;
      const amount = Math.ceil(e.metrics.excess + 1);
      const edge = e.angle % 2 ? page.height : page.width;
      if (!(amount > 0 && amount <= base * 4 && right(e.frame) + amount < edge)) continue;
      const strip = screen(
        { left: right(e.frame), top: e.frame.top, width: amount, height: e.frame.height },
        e.angle,
        page
      );
      if (hasInk(strip) || entries.some((o) => o !== e && overlaps(strip, o.occupied))) continue;
      e.frame.width += amount;
      e.metrics = e.metrics.rewrap(e.frame.width);
      e.rect = e.occupied = screen(e.frame, e.angle, page);
    }
    const scale = page.transform ? Math.hypot(page.transform[0], page.transform[1]) : 1;
    for (const e of styled) {
      // Use the original baseline even when a title gained side room or the
      // source bounds include a tall superscript. OCR-only frames use their top.
      let top = e.frame.top;
      if (Number.isFinite(e.unit.sourceBaseline) && Number.isFinite(e.metrics.firstBaseline)) {
        const source = turn(e.sourceRect || e.rect, e.angle, page.width, page.height);
        top = source.top + (e.unit.rect[3] - e.unit.sourceBaseline) * scale - e.metrics.firstBaseline;
      }
      e.top = Math.max(0, top);
      e.anchorTop = e.top;
      const inset = e.metrics.lines?.[0]?.top || 0;
      e.occupied = screen(
        {
          ...e.frame,
          top: e.top + inset,
          height: Math.max(0.3, Math.min(e.metrics.inkHeight, bottom(e.frame) - e.top) - inset)
        },
        e.angle,
        page
      );
    }
    const placed = [];
    for (const e of styled.sort(
      (a, b) => a.angle - b.angle || a.top - b.top || a.frame.left - b.frame.left
    )) {
      const { frame, angle } = e;
      let metrics = e.metrics;
      const axisHeight = angle % 2 ? page.width : page.height;
      let preferred = e.top;
      const others = entries
        .filter((o) => o !== e)
        .map((o) => turn(o.occupied, angle, page.width, page.height));
      const across = (r) => Math.min(right(r), right(frame)) - Math.max(r.left, frame.left) > 0.3;
      let limit = Math.min(
        axisHeight,
        bottom(frame) + Math.max(4 * base, Math.min(axisHeight * 0.08, 6 * base))
      );
      for (const r of others) if (across(r) && r.top > preferred + 0.3) limit = Math.min(limit, r.top);
      for (const r of page.folios || []) {
        const f = turn(r, angle, page.width, page.height);
        if (f.top > preferred && f.top > axisHeight * 0.86) limit = Math.min(limit, f.top - base * 0.65);
      }
      const free = (r) => !others.some((o) => overlaps(o, r)) && !hasInk(screen(r, angle, page));
      function availableAt(top) {
        if (top < 0 || top >= limit) return 0;
        if (metrics.lines?.length) {
          let last = 0;
          for (const line of metrics.lines) {
            const rect = {
              left: frame.left + line.left,
              top: top + line.top,
              width: line.width,
              height: line.height
            };
            if (bottom(rect) > limit + 0.15 || !free(rect)) break;
            last = line.top + line.height;
          }
          return Math.min(metrics.inkHeight, last);
        }
        const height = Math.min(limit - top, metrics.inkHeight);
        const original = Math.max(0, bottom(frame) - top);
        return height <= original || free({ ...frame, top: top + original, height: height - original })
          ? height
          : original;
      }
      e.height = availableAt(preferred);
      // Tighten the gap between consecutive paragraphs in the same column
      // when shorter translations leave a hole in the printed text.
      if (["body", "reference"].includes(e.style.role) && e.unit.matched) {
        const previous = placed.findLast(other => {
          const gap = frame.top - bottom(other.frame);
          return other.style.role === e.style.role && other.unit.matched && !other.overflow && other.angle === angle &&
            gap >= -base * 0.2 && gap <= base * 0.9 &&
            Math.abs(frame.left - other.frame.left) < base * 1.65 &&
            Math.abs(right(frame) - right(other.frame)) < base;
        });
        if (previous) {
          const edge = turn(previous.occupied, angle, page.width, page.height);
          const minimum = e.style.role === "reference" ? base * 0.18 : base * 0.38;
          const gap = Math.max(minimum, Math.min(e.style.after, frame.top - bottom(previous.frame)));
          const inset = metrics.lines?.[0]?.top || 0;
          const top = Math.max(preferred - e.style.step * 1.4, bottom(edge) + gap - inset);
          const strip = { ...frame, top: top + inset, height: preferred - top };
          if (strip.height > 0.5 && free(strip)) {
            const height = availableAt(top);
            if (height >= e.height - 0.15) {
              e.top = preferred = top;
              e.height = height;
            }
          }
        }
      }
      // A nearby rule, tall formula or very long translation can need a
      // fraction of an em of clearance. Move only the affected frame, and
      // only if that recovers an entire line. Other anchors stay reserved.
      for (
        let shift = 0.25;
        metrics.inkHeight - e.height > 0.45 && shift <= e.style.size * 0.45;
        shift += 0.25
      ) {
        for (const top of [preferred - shift, preferred + shift]) {
          const height = availableAt(top);
          if (height > e.height + 0.45) {
            e.height = height;
            e.top = top;
          }
        }
      }
      // Relax leading toward the Chinese print rhythm when all rows still fit.
      if (e.style.role === "body" && metrics.rewrap && metrics.lines?.length > 1 &&
          !metrics.wide && e.height >= metrics.inkHeight - 0.45) {
        const step = Math.round(e.style.size * 1.28 * 4) / 4;
        const span = (metrics.lines.length - 1) * (step - e.style.step);
        if (span > 0 && e.top + metrics.inkHeight + span <= limit + 0.15) {
          const ordinary = metrics;
          metrics = ordinary.rewrap(frame.width, step);
          const height = availableAt(e.top);
          if (!metrics.wide && height >= metrics.inkHeight - 0.45) {
            e.metrics = metrics;
            e.height = height;
          } else metrics = e.metrics = ordinary.rewrap(frame.width);
        }
      }
      e.overflow = metrics.wide || metrics.inkHeight > e.height + 0.45;
      e.paintRect = screen({ ...frame, top: e.top, height: e.height }, angle, page);
      const inset = metrics.lines?.[0]?.top || 0;
      e.occupied = screen(
        { ...frame, top: e.top + inset, height: Math.max(0, e.height - inset) },
        angle,
        page
      );
      placed.push(e);
    }
    alignParagraphs(entries,page,hasInk);
    const crossing=alignedColumns(entries,page);
    if (crossing) {
      const saved=entries.filter(e=>e.metrics?.setLeading).map(e=>[e,{
        top:e.top,height:e.height,overflow:e.overflow,paintRect:e.paintRect,occupied:e.occupied,metrics:{...e.metrics}
      }]);
      alignParagraphs(entries,page,hasInk,crossing);
      if (!flowAcrossColumns(crossing,entries,page,hasInk))
        for (const [e,prior] of saved) {
          Object.assign(e,prior);
          e.metrics.setLeading(e.metrics.step);
        }
    }
  }

  function render(entries, page, canvas) {
    if (!entries.some((e) => e.style)) return;
    page.folios ??= folios(page);
    arrange(entries, page, backdrop(canvas, page));
    page.typeAnchors = [];
    for (const e of entries) {
      if (!e.style) continue;
      if (e.overflow && e.keepOriginal) {
        e.keepOriginal();
        continue;
      }
      const r = e.paintRect,
        block = e.block,
        angle = e.angle;
      block.style.left = r.left + (angle === 1 || angle === 2 ? r.width : 0) + "px";
      block.style.top = r.top + (angle === 2 || angle === 3 ? r.height : 0) + "px";
      block.style.height = e.height + "px";
      if (e.unit.contentsLeader && angle === 0 && !e.overflow && e.metrics.lines?.length === 1) {
        const {dot,pitch} = e.unit.contentsLeader;
        const rect = DeepRead.ParallelInk.project(dot,page.transform);
        const scale = Math.hypot(page.transform[0],page.transform[1]);
        const line = e.metrics.lines[0];
        const end = r.left + line.left + line.width + e.style.size * .25;
        const kx=canvas.width/page.width, ky=canvas.height/page.height;
        // Continue the paper's own dot pattern up to the translated name.
        // Copy from a printed dot wholly outside the source title's mask.
        const sx = Math.floor(rect.left*kx), sy=Math.floor(rect.top*ky);
        const w=Math.ceil((rect.left+rect.width)*kx)-sx, h=Math.ceil((rect.top+rect.height)*ky)-sy;
        const ctx=canvas.getContext("2d");
        for (let x = rect.left-pitch*scale; x >= end; x -= pitch*scale)
          ctx.drawImage(canvas,sx,sy,w,h,Math.round(x*kx),sy,w,h);
      }
      if (/heading|Title|Caption/iu.test(e.style.role)) {
        const source = DeepRead.ParallelInk.project(e.unit.rect, page.transform);
        page.typeAnchors.push({
          role: e.style.role,
          source,
          dx: r.left - source.left,
          dy: r.top - source.top
        });
      }
      if (e.overflow) {
        DeepRead.ParallelTypeset.markOverflow(block);
        page.supplements.push(e.unit);
      }
    }
  }
  function destination(anchors, name, x, y) {
    const label = typeof name === "string" ? name : "";
    if (/^(?:equation|equ|cite|footnote)\b/iu.test(label)) return { x, y };
    const heading = /^(?:chapter|section|subsection|subsubsection|appendix)\b/iu.test(label);
    const caption = /^(?:figure|table|algorithm)\b/iu.test(label);
    let best = null,
      distance = Infinity;
    for (const a of anchors || []) {
      if ((heading && !/heading|Title/iu.test(a.role)) || (caption && !a.role.endsWith("Caption"))) continue;
      const s = a.source,
        above = s.top - y;
      // Named section targets commonly sit a line above the printed heading.
      // An arbitrary destination must actually touch its source frame.
      if (x < s.left - 12 || x > right(s) + 2 || above > (heading || caption ? 24 : 1) || above < -s.height)
        continue;
      if (Math.abs(above) < distance) {
        best = a;
        distance = Math.abs(above);
      }
    }
    return best ? { x: x + best.dx, y: y + best.dy } : { x, y };
  }
  DeepRead.ParallelFlow = { render, arrange, destination };
})();
