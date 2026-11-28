/* Project PDF coordinates and reinsert inline glyphs from the original PDF.js raster.
 * Only mathematical ink is copied. Surrounding translated prose remains selectable text.
 * License: AGPL-3.0-or-later */
(function () {
  const node = (doc, tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  function project(rect, t) {
    const [a, b, c, d, e, f] = t;
    const x1 = a * rect[0] + c * rect[1] + e,
      x2 = a * rect[2] + c * rect[3] + e;
    const y1 = b * rect[0] + d * rect[1] + f,
      y2 = b * rect[2] + d * rect[3] + f;
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }
  function orientation(unit, page) {
    const [a, b, c, d] = page.transform,
      [dx, dy] = unit.direction || [1, 0];
    return (Math.round((Math.atan2(b * dx + d * dy, a * dx + c * dy) * 2) / Math.PI) + 4) % 4;
  }
  function sampleBounds(rect, page, pixels) {
    const r = project(rect, page.transform),
      kx = pixels.width / page.width,
      ky = pixels.height / page.height;
    return {
      x0: Math.max(0, Math.floor(r.left * kx)),
      y0: Math.max(0, Math.floor(r.top * ky)),
      x1: Math.min(pixels.width, Math.ceil((r.left + r.width) * kx)),
      y1: Math.min(pixels.height, Math.ceil((r.top + r.height) * ky)),
      kx,
      ky
    };
  }
  // TeX can draw a code underscore as a short rule; the text layer reports
  // an ordinary space. Restore it only with a short isolated stroke in the
  // physical gap, leaving real spaces and full-width rules intact.
  function codeText(token,page,pixels) {
    if (!pixels || !token.codeSpaces?.length) return token.display;
    const [a,b,c,d,e,f]=page.transform;
    const kx=pixels.width/page.width, ky=pixels.height/page.height;
    const light=(x,y)=>{
      const px=Math.max(0,Math.min(pixels.width-1,Math.floor((a*x+c*y+e)*kx)));
      const py=Math.max(0,Math.min(pixels.height-1,Math.floor((b*x+d*y+f)*ky)));
      const i=4*(py*pixels.width+px);
      return (pixels.data[i]+pixels.data[i+1]+pixels.data[i+2])/3;
    };
    const characters=token.display.split("");
    for (const {at,left,right,baseline,em} of token.codeSpaces) {
      if ((right-left)*Math.hypot(a*kx,b*ky)<3) continue;
      const middle=(left+right)/2;
      const top=light(middle,baseline+.32*em),bottom=light(middle,baseline-.32*em);
      if (Math.abs(top-bottom)>24) continue;
      const paper=(top+bottom)/2,ink=(x,y)=>Math.abs(light(x,y)-paper)>40;
      for (let n=-6;n<=4;n++) {
        const y=baseline+n*em/28;
        if (ink(left-.13*em,y) || ink(right+.13*em,y) ||
            ink(middle,y+.14*em) || ink(middle,y-.14*em)) continue;
        let covered=0;
        for (let j=1;j<=9;j++) if (ink(left+(right-left)*j/10,y)) covered++;
        if (covered>=7) {characters[at]="_";break;}
      }
    }
    return characters.join("");
  }
  // PDF extraction can report words clipped out of a diagram. A flat source
  // rectangle has no visible glyph to replace, even if the text layer has a
  // font, a baseline and a perfectly valid bounding box.
  function flatSource(rect, page, pixels) {
    const {x0,y0,x1,y1} = sampleBounds(rect,page,pixels);
    if (x1-x0 < 2 || y1-y0 < 2) return false;
    const data = pixels.data, origin = 4*(y0*pixels.width+x0);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = 4*(y*pixels.width+x);
        if (Math.abs(data[p]-data[origin]) > 4 || Math.abs(data[p+1]-data[origin+1]) > 4 ||
            Math.abs(data[p+2]-data[origin+2]) > 4) return false;
      }
    }
    return true;
  }

  // PDF diagrams can contain text clipped out of a form. For a label that
  // collided with another frame, replay its isolated text draw without that
  // operation. Identical pixels prove it contributed no visible glyphs here.
  async function clippedLabels(page, source, list, ops, render, signal) {
    const conflicts = page.units.filter(u => u.matched && u.verifiedLabel && !u.placed && u.rect);
    if (!conflicts.length || !ops || !list?.lastChunk) return null;
    const normalize = s => s.replace(/\s+/gu,"");
    const names = new Set(conflicts.map(u => normalize(u.source)));
    const occurrences = new Map();
    for (const u of page.units) {
      const text = normalize(u.source);
      if (u.matched && names.has(text)) occurrences.set(text,(occurrences.get(text) || 0)+1);
    }
    if (signal.aborted) return null;
    const draws = new Map();
    for (let i=0; i<list.fnArray.length; i++) {
      // The next endText discards the text cursor, so filtering this draw
      // cannot displace any following glyph on the comparison canvas.
      if (list.fnArray[i] !== ops.showText || list.fnArray[i+1] !== ops.endText) continue;
      const glyphs = list.argsArray[i]?.[0];
      if (!Array.isArray(glyphs)) continue;
      const text = normalize(glyphs.map(g => g?.unicode || "").join(""));
      if (names.has(text)) {
        if (!draws.has(text)) draws.set(text,[]);
        draws.get(text).push(i);
      }
    }
    // A similarly worded visible label can be split across several PDF
    // operations. Only verify complete one-to-one sets of label draws.
    const groups = [];
    const overlaps = (a,b) => Math.min(a[2],b[2]) > Math.max(a[0],b[0]) &&
      Math.min(a[3],b[3]) > Math.max(a[1],b[1]);
    for (const [name, indices] of draws) {
      if (indices.length !== occurrences.get(name)) continue;
      const units=page.units.filter(u => u.matched && u.verifiedLabel && u.rect && normalize(u.source) === name);
      // A clipped panel title can sit over several genuine axis labels. Keep
      // intersecting names in separate renders so only their own ink changes.
      let group=groups.find(g=>units.every(u=>g.units.every(v=>!overlaps(u.rect,v.rect))));
      if (!group) groups.push(group={indices:new Set(),units:[]});
      for (const index of indices) group.indices.add(index);
      group.units.push(...units);
    }
    const hidden=new Set();
    for (const group of groups) {
      if (signal.aborted) return null;
      const copy=node(source.ownerDocument,"canvas");
      copy.width=source.width; copy.height=source.height;
      let filtered=false;
      const task=render(copy,index=>{
        if (!group.indices.has(index)) return true;
        filtered=true; return false;
      });
      const abort=()=>task.cancel();
      signal.addEventListener("abort",abort,{once:true});
      try {
        await task.promise;
        if (signal.aborted || !filtered) return null;
        for (const u of group.units) {
          const {x0,y0,x1,y1}=sampleBounds(u.rect,page,source);
          if (x1<=x0 || y1<=y0) continue;
          const patch=canvas=>canvas.getContext("2d").getImageData(x0,y0,x1-x0,y1-y0).data;
          const a=patch(source),b=patch(copy);
          if (!a.some((v,i)=>Math.abs(v-b[i])>4)) hidden.add(u.owner);
        }
      } finally {
        signal.removeEventListener("abort",abort);
        copy.width=copy.height=0;
      }
    }
    return hidden.size ? hidden : null;
  }
  // Table rules often touch the top/bottom of a text box. Estimate the flat
  // cell colour inside the box and leave straight rules crossing it intact.
  function labelPatch(pixels, box, page, em) {
    const restored = page.nativeLabelPatches?.get(box.join(","));
    if (restored) return restored;
    const { x0, y0, x1, y1, kx, ky } = sampleBounds(box, page, pixels);
    const w = x1 - x0,
      h = y1 - y0;
    if (w < 2 || h < 2) return null;
    const bins = new Map(),
      p = pixels.data;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const k = 4 * (y * pixels.width + x),
          r = p[k],
          g = p[k + 1],
          b = p[k + 2],
          bin = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        const cell = bins.get(bin);
        if (cell) cell.n++;
        else bins.set(bin, { n: 1, r, g, b });
      }
    const bg = [...bins.values()].sort((a, b) => b.n - a.n)[0];
    if (bg.n < w * h * 0.43) return null;
    function ink(x, y) {
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return false;
      const k = 4 * (y * pixels.width + x);
      return Math.max(Math.abs(p[k] - bg.r), Math.abs(p[k + 1] - bg.g), Math.abs(p[k + 2] - bg.b)) > 30;
    }
    const horizontal = new Set(),
      vertical = new Set();
    for (let y = y0; y < y1; y++) {
      if (!ink(x0 - 2, y) || !ink(x1 + 1, y)) continue;
      let count = 0;
      for (let x = x0; x < x1; x++) if (ink(x, y)) count++;
      if (count > w * 0.84) horizontal.add(y);
    }
    for (let x = x0; x < x1; x++) {
      if (!ink(x, y0 - 2) || !ink(x, y1 + 1)) continue;
      let count = 0;
      for (let y = y0; y < y1; y++) if (ink(x, y)) count++;
      if (count > h * 0.84) vertical.add(x);
    }
    const free = (start, sign, alongY = false) => {
      const scale = alongY ? ky : kx, edge = alongY ? pixels.height : pixels.width;
      const from = alongY ? x0 : y0, to = alongY ? x1 : y1;
      const rules = alongY ? vertical : horizontal;
      let n = 0;
      while (n < 2 * em * scale) {
        const pos = start + sign * n;
        if (pos < 0 || pos >= edge) break;
        let occupied = false;
        for (let cross = from; cross < to; cross++)
          if (!rules.has(cross) && (alongY ? ink(cross,pos) : ink(pos,cross))) {
            occupied = true;
            break;
          }
        if (occupied) break;
        n++;
      }
      return Math.max(0, (n - 1) / scale);
    };
    return {
      color: [bg.r, bg.g, bg.b],
      left: free(x0 - 1, -1),
      right: free(x1, 1),
      above: free(y0 - 1, -1, true),
      below: free(y1, 1, true),
      erase(ctx) {
        const patch = ctx.getImageData(x0, y0, w, h);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            if (horizontal.has(y) || vertical.has(x)) continue;
            const k = 4 * ((y - y0) * w + x - x0);
            patch.data[k] = bg.r;
            patch.data[k + 1] = bg.g;
            patch.data[k + 2] = bg.b;
          }
        ctx.putImageData(patch, x0, y0);
      }
    };
  }

  // Photographs and gradients have no single cell colour. When the label is
  // selectable PDF text, render the underlying artwork without text operators
  // and retain just the small patches that actually lost glyphs.
  async function restoreNativeLabels(page, source, list, ops, render, signal) {
    const labels = page.units.filter(u => u.verifiedLabel && u.placed && u.matched);
    if (!labels.length || !ops || !list?.lastChunk) return;
    const original = source.getContext("2d").getImageData(0, 0, source.width, source.height);
    const masks = labels.flatMap(u => u.masks.filter(r => u.nativeOCR ? !page.nativeLabelPatches?.has(r.join(",")) : !labelPatch(original, r, page, u.size)));
    if (!masks.length) return;
    if (signal.aborted) return;
    // PDF.js can replay glyphs when only a showText operator is filtered
    // out of a text object. Omit the complete BT … ET range, including its
    // positioning operations, so the background contains no residual letters.
    let inText = false;
    const text = list.fnArray.map(op => {
      if (op === ops.beginText) inText = true;
      const omit = inText;
      if (op === ops.endText) inText = false;
      return omit;
    });
    const background = node(source.ownerDocument, "canvas");
    background.width = source.width;
    background.height = source.height;
    let skipped = false;
    const task = render(background, index => {
      if (!text[index]) return true;
      skipped = true;
      return false;
    });
    const abort = () => task.cancel();
    signal.addEventListener("abort", abort, {once:true});
    try {
      await task.promise;
      if (!skipped || signal.aborted) return;
      const ctx = background.getContext("2d", {willReadFrequently:true});
      page.nativeLabelPatches ??= new Map();
      for (const mask of masks) {
        const {x0, y0, x1, y1} = sampleBounds(mask, page, original);
        const width = x1-x0, height = y1-y0;
        if (width <= 0 || height <= 0) continue;
        const image = ctx.getImageData(x0,y0,width,height), rgb = [0,0,0];
        let changed = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const a = 4 * (y * width + x), b = 4 * ((y0+y) * source.width + x0+x);
            if ([0,1,2].some(c => Math.abs(original.data[b+c]-image.data[a+c]) > 18)) changed++;
            for (let c = 0; c < 3; c++) rgb[c] += image.data[a+c];
          }
        }
        if (changed < 3 || changed > width * height * .75) continue;
        page.nativeLabelPatches.set(mask.join(","), {
          color:rgb.map(v => Math.round(v/(width*height))), left:0, right:0,
          erase:dest => dest.putImageData(image,x0,y0)
        });
      }
    } finally {
      signal.removeEventListener("abort", abort);
      background.width = background.height = 0;
    }
  }

  // Small descriptions below a grid of bold stage labels can be deliberately
  // gray. Use the fill of a complete PDF text object only when every drawn
  // letter and every matching occurrence agrees on an opaque neutral ink.
  function stageNoteInks(units, list, ops) {
    const notes = units.filter(u => u.stageNote);
    if (!notes.length || !list?.lastChunk || !ops) return;
    const key = DeepRead.ParallelInline.geometryText;
    const wanted = new Set(notes.map(u => key(u.source))), found = new Map();
    const stack = [];
    let state = {fill:"", alpha:1, mode:0, blend:"Normal", mask:false}, text = "", ink, active = false;
    for (let i = 0; i < list.fnArray.length; i++) {
      const op = list.fnArray[i], args = list.argsArray[i];
      if (op === ops.save || op === ops.paintFormXObjectBegin || op === ops.beginGroup) {
        stack.push({...state});
      } else if (op === ops.restore || op === ops.paintFormXObjectEnd || op === ops.endGroup) {
        state = stack.pop() || state;
      } else if (op === ops.setFillRGBColor) {
        const color = args[0];
        const gray = typeof color === "string" && /^#([a-f\d]{2})\1\1$/iu.exec(color);
        const level = gray && parseInt(gray[1],16);
        state.fill = level >= 48 && level <= 190 ? color : "";
      } else if (op === ops.setFillColorN || op === ops.setFillGray || op === ops.setFillCMYKColor ||
                 op === ops.setFillColor || op === ops.setFillTransparent) {
        state.fill = "";
      } else if (op === ops.setGState) {
        for (const [name,value] of args[0]) {
          if (name === "ca") state.alpha = value;
          if (name === "BM") state.blend = value;
          if (name === "SMask") state.mask = !!value;
        }
      } else if (op === ops.setTextRenderingMode) {
        state.mode = args[0];
      } else if (op === ops.beginText) {
        active = true; text = ""; ink = undefined;
      } else if (active && (op === ops.showText || op === ops.showSpacedText)) {
        const letters = key(args[0].map(g => g?.unicode || "").join(""));
        if (!letters) continue;
        text += letters;
        const fill = state.alpha === 1 && state.mode === 0 && state.blend === "Normal" && !state.mask ? state.fill : "";
        ink = ink === undefined || ink === fill ? fill : "";
      } else if (op === ops.endText) {
        if (active && wanted.has(text))
          found.set(text,!found.has(text) || found.get(text) === ink ? ink : "");
        active = false;
      }
    }
    return new Map(notes.map(u => [u.owner,found.get(key(u.source))]).filter(([,color]) => color));
  }

  function inkColor(token, page, pixels) {
    let dark = 0, colored = 0;
    let neutralLevel = 256, neutralRGB, neutralCount = 0, neutralGlyphs = 0, lastGlyph = -1;
    const coverage = [], contrast = [];
    let colouredPaper = 0, contrastingInk = 0, boxes = 0;
    const record = (bins, level, r, g, b) => {
      const bin = bins[level] ||= [0, 0, 0, 0];
      bin[0]++; bin[1] += r; bin[2] += g; bin[3] += b;
    };
    for (const rect of token.samples || []) {
      const { x0, y0, x1, y1 } = sampleBounds(rect, page, pixels);
      if (x1 <= x0 || y1 <= y0) continue;
      boxes++;
      // The backing colour of a figure label can itself be saturated. Sample
      // the two edges before counting ink, including white ink on dark fills.
      const edge = new Map();
      let bg;
      for (const y of [Math.max(0,y0-1),y0,y1-1,Math.min(pixels.height-1,y1)]) for (let i=0; i<5; i++) {
        const x=x0+Math.floor((x1-x0-1)*i/4), p=4*(y*pixels.width+x);
        const [r,g,b] = pixels.data.subarray(p,p+3);
        const key=(r>>4)*256+(g>>4)*16+(b>>4);
        const bin=edge.get(key) || {r,g,b,n:0};
        bin.n++; edge.set(key,bin);
        if (!bg || bin.n>bg.n) bg=bin;
      }
      const tinted = bg.n>=10 && (Math.max(bg.r,bg.g,bg.b)-Math.min(bg.r,bg.g,bg.b)>28 || Math.max(bg.r,bg.g,bg.b)<125);
      if (tinted) colouredPaper++;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const at = (y * pixels.width + x) * 4,
            r = pixels.data[at],
            g = pixels.data[at + 1],
            b = pixels.data[at + 2];
          const low = Math.min(r, g, b), chroma = Math.max(r, g, b) - low;
          if (token.mutedCredit && chroma <= 12 && y1-y0 >= 7 && !tinted) {
            const level = Math.max(r,g,b);
            if (level < neutralLevel) {
              neutralLevel = level; neutralRGB = [r,g,b]; neutralCount = 0; neutralGlyphs = 0; lastGlyph = -1;
            }
            if (level === neutralLevel && r===neutralRGB[0] && g===neutralRGB[1] && b===neutralRGB[2]) {
              neutralCount++;
              if (lastGlyph !== boxes) { neutralGlyphs++; lastGlyph = boxes; }
            }
          }
          if (tinted) {
            const delta = Math.max(Math.abs(r-bg.r),Math.abs(g-bg.g),Math.abs(b-bg.b));
            if (delta > 40) { record(contrast,delta,r,g,b); contrastingInk++; }
          }
          if (low > 190) continue;
          dark++;
          if (chroma < 32) continue;
          record(coverage,chroma,r,g,b);
          colored++;
        }
    }
    const onColour = colouredPaper > boxes*.5 && contrastingInk >= 3;
    if (!onColour && (colored < 3 || colored <= dark * .6)) {
      // Only take a gray credit face when several glyphs have the same solid
      // core. Thin anti-aliased black strokes must not lighten ordinary text.
      return neutralLevel >= 48 && neutralLevel <= 190 && neutralCount >= 5 && neutralGlyphs >= 3
        ? "rgb("+neutralRGB.join(",")+")" : "";
    }
    // On neutral paper antialiasing dilutes chroma toward zero. Use the cores
    // of the strokes, including on tiny glyphs with only a few opaque pixels.
    const rgb = [0, 0, 0];
    let count = 0;
    const bins = onColour ? contrast : coverage, wanted = onColour ? contrastingInk : colored;
    for (let j = bins.length - 1; j >= 0 && count < wanted * .1; j--) {
      const bin = bins[j];
      if (!bin) continue;
      count += bin[0];
      for (let k = 0; k < 3; k++) rgb[k] += bin[k + 1];
    }
    return "rgb(" + rgb.map(v => Math.round(v / count)).join(",") + ")";
  }
  function sourceLink(token, page) {
    const links = page.links || [];
    for (const box of token.samples || []) {
      const x = (box[0] + box[2]) / 2,
        y = (box[1] + box[3]) / 2;
      const found = links.findIndex(
        (l) =>
          l.rect && x >= l.rect[0] - 0.5 && x <= l.rect[2] + 0.5 && y >= l.rect[1] - 0.5 && y <= l.rect[3] + 0.5
      );
      if (found >= 0) return found;
    }
    return -1;
  }

  function paintEmphasis(fragment, unit, page, pixels) {
    if (!unit.emphasis?.length || !pixels) return;
    const selector = "strong,b,em,i";
    const marks = [...fragment.querySelectorAll(selector)].filter(n => !n.parentElement?.closest(selector));
    const face = node => (node.matches("strong,b") || node.querySelector("strong,b") ? "**" : "") +
      (node.matches("em,i") || node.querySelector("em,i") ? "*" : "");
    const compact = text => text.replace(/\s+/gu, "").toLowerCase();
    for (const style of new Set(unit.emphasis.map(e => e.face))) {
      const source = unit.emphasis.filter(e => e.face === style);
      const targets = marks.filter(n => face(n) === style);
      const unmatched = [];
      const paint = (span, node) => {
        const color = inkColor(span, page, pixels);
        if (color) node.style.color = color;
      };
      // Product names and protected numbers survive reordering. Match them
      // first, then transfer the remaining matching runs in reading order.
      for (const span of source) {
        const ids = span.text.match(/⟦D+\d+⟧/gu) || [];
        const exact = targets.filter(n => compact(n.textContent) === compact(span.text));
        const matches = exact.length ? exact : targets.filter(n => ids.length && ids.every(id => n.textContent.includes(id)));
        if (matches.length !== 1) { unmatched.push(span); continue; }
        paint(span, matches[0]);
        targets.splice(targets.indexOf(matches[0]), 1);
      }
      if (unmatched.length === targets.length) unmatched.forEach((span, i) => paint(span, targets[i]));
    }
  }

  function paintHoverColors(box, face, page, pixels) {
    const groups = [];
    const stride = Math.max(1,Math.ceil(face.samples.length/3));
    for (let i=0; i<face.samples.length; i+=stride) {
      const color = inkColor({samples:face.samples.slice(i,i+stride)},page,pixels);
      groups.push(color && color.match(/\d+/gu).map(Number));
    }
    // Apply a block colour only when the beginning, middle and end agree.
    const first = groups[0];
    if (first && groups.every(rgb=>rgb && rgb.every((v,i)=>Math.abs(v-first[i])<20)))
      box.style.color = inkColor(face,page,pixels);
    paintEmphasis(box,face,page,pixels);
    if (!face.citations.size) return;
    const doc=box.ownerDocument, walker=doc.createTreeWalker(box,4), nodes=[];
    while(walker.nextNode()) if (!walker.currentNode.parentElement?.closest("math,.katex,pre,code"))
      nodes.push(walker.currentNode);
    for (const text of nodes) {
      const value=text.nodeValue, filled=doc.createDocumentFragment();
      let from=0;
      for (const match of value.matchAll(/[\[［]\s*\d+(?:\s*[,，、–—-]\s*\d+)*\s*[\]］]/gu)) {
        const key=match[0].normalize("NFKC").replace(/\s/gu,"").replace(/、/gu,",");
        const samples=face.citations.get(key);
        const color=samples && inkColor({samples},page,pixels);
        if (!color) continue;
        const span=node(doc,"span"); span.style.color=color; span.textContent=match[0];
        filled.append(value.slice(from,match.index),span);
        from=match.index+match[0].length;
      }
      if (from) { filled.append(value.slice(from)); text.replaceWith(filled); }
    }
  }

  async function panelColors(reader, page, signal) {
    const headings = page.units.filter(u => u.panelHeading && u.rect);
    if (!headings.length) return;
    const {app,pdfWin,pdfDoc} = reader.session.overlay;
    const raw = o => o?.wrappedJSObject || o;
    const pdf = raw(await app.pdfDocument.getPage(page.index+1));
    if (signal.aborted) return;
    const viewport = raw(pdf.getViewport(Components.utils.cloneInto({scale:2},pdfWin)));
    const transform = Array.from(viewport.transform);
    const bounds = project(DeepRead.Overlay.unionRect(headings.map(u=>u.rect)),transform);
    const x = Math.floor(bounds.left)-2, y = Math.floor(bounds.top)-2;
    const canvas = node(pdfDoc,"canvas");
    canvas.width = Math.ceil(bounds.width)+5;
    canvas.height = Math.ceil(bounds.height)+5;
    const ctx = canvas.getContext("2d");
    const args = raw(Components.utils.createObjectIn(pdfWin));
    args.canvasContext = raw(ctx); args.viewport = viewport;
    args.transform = Components.utils.cloneInto([1,0,0,1,-x,-y],pdfWin);
    const task = raw(pdf.render(args)), cancel = () => task.cancel();
    signal.addEventListener("abort",cancel,{once:true});
    try {
      await task.promise;
      if (signal.aborted) return;
      transform[4] -= x; transform[5] -= y;
      const surface = {width:canvas.width,height:canvas.height,transform};
      const pixels = ctx.getImageData(0,0,canvas.width,canvas.height);
      const result = new Map();
      for (const heading of headings) {
        const [l,b,r,t] = heading.rect;
        const chars = page.chars.filter(c => c.rect && (c.rect[0]+c.rect[2])/2 >= l &&
          (c.rect[0]+c.rect[2])/2 <= r && (c.rect[1]+c.rect[3])/2 >= b && (c.rect[1]+c.rect[3])/2 <= t);
        const ranges = [];
        let word = [], lastColor = "", hasPlain = false;
        const flush = () => {
          if (!word.length) return;
          const samples = word.map(c => c.rect);
          const rgb = inkColor({samples},surface,pixels);
          const channels = rgb && rgb.match(/\d+/gu).map(Number);
          const color = channels && Math.max(...channels)-Math.min(...channels)>28
            ? channels.map(v => Math.round(v/20)).join(",") : "";
          if (!color) hasPlain = true;
          else {
            const text = word.map(c => c.u ?? c.c).join("");
            if (lastColor === color) {
              ranges.at(-1).text += " "+text;
              ranges.at(-1).samples.push(...samples);
            } else ranges.push({text,samples});
          }
          lastColor = color; word = [];
        };
        for (const c of chars) {
          if ((c.u ?? c.c ?? "").trim()) word.push(c);
          else flush();
          if (c.spaceAfter || c.lineBreakAfter || c.paragraphBreakAfter) flush();
        }
        flush();
        if (ranges.length && (hasPlain || ranges.length > 1)) result.set(String(heading.rect),ranges);
      }
      return result;
    } finally {
      signal.removeEventListener("abort",cancel);
      canvas.width = canvas.height = 1;
    }
  }

  // Physical PDF links may cover words in ordinary prose that the model
  // legitimately retains, such as instrument names. Recover only the matching
  // occurrence inside this unit; another mention can have a different target.
  function retainedLinks(doc, fragment, unit, page, pixels) {
    if (!pixels || !unit.rect || !page.chars?.length) return fragment;
    const frames = unit.rects?.length ? unit.rects : [unit.rect];
    const links = (page.links || []).map((link,id)=>({...link,id})).filter(link =>
      (/^(?:https?:\/\/|mailto:)/iu.test(link.url || "") ||
        (typeof link.dest === "string" && /^(?:cite|bib)[.:-]/iu.test(link.dest))) && link.rect && frames.some(r =>
        r[0] < link.rect[2] && r[2] > link.rect[0] && r[1] < link.rect[3] && r[3] > link.rect[1]));
    if (!links.length) return fragment;
    const inside = (x,y,r) => x>=r[0]-.2 && x<=r[2]+.2 && y>=r[1]-.2 && y<=r[3]+.2;
    const words = text => [...text.matchAll(/[\p{Script=Latin}\d]+(?:[-’'][\p{Script=Latin}\d]+)*/gu)];
    const runs = [];
    let run;
    for (const c of page.chars) {
      if (!c.rect) continue;
      const x=(c.rect[0]+c.rect[2])/2, y=(c.rect[1]+c.rect[3])/2;
      const link=links.find(l=>inside(x,y,l.rect));
      if (!link || !frames.some(r=>inside(x,y,r))) { run=null; continue; }
      // The author can end one column while the linked year starts another
      // physical unit. Its own annotation still identifies the reference.
      const dest = link.url || link.dest;
      if (run?.dest !== dest) {
        run = {dest,id:link.id,citation:!link.url,text:"",boxes:[]}; runs.push(run);
      }
      const s=c.u ?? c.c ?? "";
      run.text+=s;
      for (let j=0;j<s.length;j++) run.boxes.push(c.rect);
      if (c.spaceAfter || c.lineBreakAfter || c.paragraphBreakAfter) { run.text+=" "; run.boxes.push(null); }
    }
    const starts = new Map();
    for (const r of runs) {
      r.words = words(r.text);
      r.words.forEach((word,j) => {
        if (!starts.has(word[0])) starts.set(word[0],[]);
        starts.get(word[0]).push({r,j});
      });
    }
    const sourceWords=words(unit.source || ""), allTarget=words(fragment.textContent);
    const unique = (list, phrase) => list.filter((_,i)=>phrase.every((w,j)=>list[i+j]?.[0]===w[0])).length===1;
    const walker=doc.createTreeWalker(fragment,4), nodes=[];
    while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest("a,math,.katex,code,pre,[role=math]")) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const value=n.nodeValue, target=words(value), output=doc.createDocumentFragment();
      let from=0;
      for (let i=0;i<target.length;i++) {
        let best;
        for (const {r,j} of starts.get(target[i][0]) || []) {
          let length=0;
          while (i+length<target.length && target[i+length][0]===r.words[j+length]?.[0]) {
            const prior=target[i+length-1], next=target[i+length];
            if (length && !/^\s*$/u.test(value.slice(prior.index+prior[0].length,next.index))) break;
            length++;
          }
          if (length && (!best || length>best.length)) best={r,j,length};
          else if (best && length===best.length && r.dest!==best.r.dest) best.ambiguous=true;
        }
        if (!best || best.ambiguous) continue;
        const {r,j,length}=best, phrase=target.slice(i,i+length);
        if (!phrase.some(w=>/\p{Script=Latin}/u.test(w[0])) ||
            (length===1 && r.words.length>1 && !/^\p{Lu}/u.test(phrase[0][0])) ||
            !unique(sourceWords,phrase) || !unique(allTarget,phrase)) continue;
        const first=r.words[j], last=r.words[j+length-1], samples=r.boxes.slice(first.index,last.index+last[0].length).filter(Boolean);
        let end=phrase.at(-1).index+phrase.at(-1)[0].length;
        if (r.citation && value[end]==="." && r.text[last.index+last[0].length]===".") end++;
        const a=node(doc,"a"); a.href="#"; a.dataset.sourceLink=String(r.id);
        a.style.color=inkColor({samples},page,pixels); a.textContent=value.slice(phrase[0].index,end);
        output.append(value.slice(from,phrase[0].index),a);
        from=end; i+=length-1;
      }
      if (from) { output.append(value.slice(from)); n.replaceWith(output); }
    }
    return fragment;
  }

  function linkPassage(doc, fragment, unit, page, pixels) {
    const samples = unit.linkSamples;
    if (!samples?.length || !pixels) return retainedLinks(doc,fragment,unit,page,pixels);
    const ids = samples.map(rect => sourceLink({samples: [rect]}, page));
    const id = ids.find(i => i >= 0);
    const uri = page.links?.[id]?.url;
    const linked = id != null && (uri
      ? ids.every(i => page.links[i]?.url === uri)
      : ids.filter(i => i === id).length >= samples.length * .9);
    if (!linked && unit.typeRole !== "contents") return retainedLinks(doc,fragment,unit,page,pixels);
    const nested = [...fragment.querySelectorAll("a")];
    const sameLink = linked && nested.every(a => a.dataset.sourceLink === String(id) ||
      (uri && page.links[Number(a.dataset.sourceLink)]?.url === uri));
    const wrapper = node(doc, sameLink ? "a" : "span");
    if (sameLink) {
      // A version number can itself carry the same PDF link as its entire
      // contents entry. One anchor should own both the prose and its number.
      for (const a of nested) a.replaceWith(...a.childNodes);
      wrapper.href = "#";
      wrapper.dataset.sourceLink = String(id);
    }
    wrapper.style.color = inkColor({samples}, page, pixels);
    wrapper.append(fragment);
    fragment.append(wrapper);
    return fragment;
  }

  function labelBeforeURL(doc, text, token, page, pixels) {
    if (!token?.fieldLabel) return;
    const prefix = /(?:^|(?<=[。！？.!?；;]))\s*([^。！？.!?；;:：\n]{1,40}[:：]\s*)$/u.exec(text);
    if (!prefix) return;
    const {samples,startsLine} = token.fieldLabel;
    const ids = samples.map(rect=>sourceLink({samples:[rect]},page));
    const id = ids[0], linked = id >= 0 && ids.every(other=>other===id);
    const label = node(doc,linked ? "a" : "span");
    if (linked) { label.href="#"; label.dataset.sourceLink=String(id); }
    label.style.color=inkColor({samples},page,pixels);
    if (startsLine) label.dataset.sourceLineStart="true";
    label.textContent=prefix[1];
    return {label,at:prefix.index};
  }

  function authorBeforeYear(text, token, page) {
    if (token?.kind !== "number" || !/^(?:19|20)\d\d$/u.test(token.display)) return null;
    const id = sourceLink(token, page);
    const destination = page.links?.[id]?.dest;
    if (typeof destination !== "string" || !/^(?:cite|bib)[.:-]/iu.test(destination)) return null;
    // Author and year can be separate link rectangles to the same reference,
    // with the surname hyphenated across two lines. Cache per page/rectangle.
    page.citationNames ??= new Map();
    if (!page.citationNames.has(id)) {
      let first = id;
      while (first && page.links[first - 1].dest === destination) first--;
      const printed = page.links.slice(first, id + 1).map(link => {
        const [l,b,r,t] = link.rect;
        return page.chars.filter(c => c.rect && (c.rect[0]+c.rect[2])/2 >= l-.25 &&
          (c.rect[0]+c.rect[2])/2 <= r+.25 && (c.rect[1]+c.rect[3])/2 >= b-.25 &&
          (c.rect[1]+c.rect[3])/2 <= t+.25).map(c => (c.u || "") + (c.spaceAfter ? " " : "")).join("");
      }).join(" ").replace(/[-\u00ad]\s+(?=\p{Ll})/gu, "");
      const name = printed.split(/(?:19|20)\d\d/u)[0].trim().replace(/^[\s(,;]+|[\s(,;]+$/gu, "");
      let pattern;
      if (/^\p{Lu}[\p{L}\p{M}.’'& -]{1,100}$/u.test(name)) {
        const words = name.match(/\bet\s+al\.?|\band\b|&|[\p{L}\p{M}.'’-]+/giu) || [];
        const parts = words.map(word => /^et\s+al/iu.test(word) ? "(?:et\\s+al\\.?|等(?:人)?)" :
          /^(?:and|&)$/iu.test(word) ? "(?:and|&|和|与|與|及|、)" : word.replace(/\./g, "\\."));
        if (parts.length) pattern = new RegExp("(?<![\\p{Script=Latin}\\d])(" + parts.join("\\s*") + ")([\\s,，(（]*)$", "iu");
      }
      page.citationNames.set(id, pattern);
    }
    const match = page.citationNames.get(id)?.exec(text);
    return match && {id, match};
  }
  // Gecko lays out native MathML at the surrounding text size. OCR expressions
  // have no source pixels; use the bundled TeX parser for these only.
  function typesetFormula(doc, display) {
    const tex = display
      .trim()
      .replace(/^\$+|\$+$/gu, "")
      .replace(/^\\\(|\\\)$/gu, "");
    try {
      const markup = DeepRead.Markdown.libs().katex.renderToString(tex, {
        output: "mathml",
        displayMode: false,
        throwOnError: true,
        trust: false
      });
      const tree = new DOMParser().parseFromString(markup, "application/xml");
      const math = tree.getElementsByTagNameNS("http://www.w3.org/1998/Math/MathML", "math")[0];
      if (math) {
        const node = doc.importNode(math, true);
        for (const source of node.querySelectorAll("annotation, annotation-xml")) source.remove();
        node.setAttribute("aria-label", tex);
        return node;
      }
    } catch {
      /* Unrecognised notation retains its printed characters. */
    }
    const span = node(doc, "span"),
      script = /([_^])(?:\{([^{}]*)\}|([\p{L}\d]))/gu;
    let from = 0;
    for (const part of tex.matchAll(script)) {
      span.append(tex.slice(from, part.index));
      const mark = node(doc, part[1] === "_" ? "sub" : "sup");
      mark.textContent = part[2] ?? part[3];
      span.append(mark);
      from = part.index + part[0].length;
    }
    span.append(tex.slice(from));
    return span;
  }
  function formula(doc, token, unit, page, source, pixels) {
    const { x0, y0, x1, y1, kx, ky } = sampleBounds(token.clip, page, pixels);
    const tight = sampleBounds(token.rect, page, pixels);
    if (x1 <= x0 || y1 <= y0) return typesetFormula(doc,token.display);
    // Trim only paper-coloured margins. Missing Unicode parentheses and radical
    // strokes inside this bounded region must remain part of the original symbol.
    const at = (y0 * pixels.width + x0) * 4,
      bg = pixels.data.subarray(at, at + 3);
    let left = x1,
      top = y1,
      right = x0,
      bottom = y0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const j = (y * pixels.width + x) * 4;
        if (
          Math.max(
            Math.abs(pixels.data[j] - bg[0]),
            Math.abs(pixels.data[j + 1] - bg[1]),
            Math.abs(pixels.data[j + 2] - bg[2])
          ) < 45
        )
          continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    // For dark boxes or scans, keep the original measured glyph extent as well.
    left = Math.max(x0, Math.min(left - 1, tight.x0));
    top = Math.max(y0, Math.min(top - 1, tight.y0));
    right = Math.min(x1, Math.max(right + 1, tight.x1));
    bottom = Math.min(y1, Math.max(bottom + 1, tight.y1));
    const w = Math.max(1, right - left),
      ht = Math.max(1, bottom - top),
      angle = orientation(unit, page);
    const bitmap = node(doc, "canvas");
    bitmap.dataset.mathCrop=[left/kx,top/ky,w/kx,ht/ky,angle].join(" ");
    drawCrop(bitmap,source,left,top,w,ht,angle);
    const [a, b, c, d, e, f] = page.transform,
      em = unit.size * Math.hypot(a, b);
    const baseX = a * token.rect[0] + c * token.baseline + e,
      baseY = b * token.rect[0] + d * token.baseline + f;
    const widthEm = (angle % 2 ? ht / ky : w / kx) / em,
      heightEm = (angle % 2 ? w / kx : ht / ky) / em;
    const delta = [bottom / ky - baseY, baseX - left / kx, baseY - top / ky, right / kx - baseX][angle];
    const depthEm = Math.max(0, Math.min(heightEm, delta / em));
    const span = node(doc, "span");
    span.className = "dr-parallel-atom";
    span.setAttribute("role", "math");
    span.setAttribute("aria-label", token.display);
    Object.assign(span.dataset, { widthEm, heightEm, depthEm });
    // Backing pixels change with zoom / device density. The inline box always
    // occupies the same physical space, including in an unstyled print frame.
    Object.assign(span.style, { display:"inline-block", position:"relative", lineHeight:"0",
      width:widthEm+"em", height:heightEm+"em", verticalAlign:-depthEm+"em" });
    Object.assign(bitmap.style, {display:"block",position:"absolute",inset:"0",width:"100%",height:"100%"});
    bitmap.setAttribute("aria-hidden", "true");
    span.append(bitmap);
    return span;
  }
  function drawCrop(bitmap, source, left, top, w, h, angle) {
    const width = Math.max(1, Math.round(w)),
      height = Math.max(1, Math.round(h));
    bitmap.width = angle % 2 ? height : width;
    bitmap.height = angle % 2 ? width : height;
    const ctx = bitmap.getContext("2d");
    if (angle === 1) ctx.setTransform(0, -1, 1, 0, 0, width);
    else if (angle === 2) ctx.setTransform(-1, 0, 0, -1, width, height);
    else if (angle === 3) ctx.setTransform(0, 1, -1, 0, height, 0);
    ctx.drawImage(source, left, top, w, h, 0, 0, width, height);
  }

  function sharpen(root, source, page) {
    const sx = source.width / page.width,
      sy = source.height / page.height;
    for (const bitmap of root.querySelectorAll("canvas[data-math-crop]")) {
      const [x, y, w, h, angle] = bitmap.dataset.mathCrop.split(" ").map(Number);
      if (bitmap.width >= Math.round(angle % 2 ? h * sy : w * sx)) continue;
      drawCrop(bitmap, source, x * sx, y * sy, w * sx, h * sy, angle);
    }
  }

  function materialize(doc, frag, unit, page, source, pixels) {
    paintEmphasis(frag, unit, page, pixels);
    if (unit.panelBold) {
      const strong = node(doc,"strong");
      strong.append(...frag.childNodes);
      frag.append(strong);
    }
    const byID = new Map((unit.tokens || []).map((t) => [t.id, t]));
    if (!byID.size) return linkPassage(doc, frag, unit, page, pixels);
    const walker = doc.createTreeWalker(frag, 4),
      nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const text of nodes) {
      const parts = text.nodeValue.split(/(⟦D+\d+⟧)/u);
      if (parts.length === 1) continue;
      const filled = doc.createDocumentFragment();
      for (const [i, part] of parts.entries()) {
        const token = byID.get(part);
        if (!token) {
          const next = byID.get(parts[i+1]);
          const field = pixels && labelBeforeURL(doc,part,next,page,pixels);
          if (field) {
            filled.append(part.slice(0,field.at),field.label);
            continue;
          }
          const cite = pixels && authorBeforeYear(part, next, page);
          if (cite) {
            const author = node(doc, "a");
            author.href = "#"; author.dataset.sourceLink = String(cite.id);
            author.style.color = inkColor(byID.get(parts[i+1]), page, pixels);
            author.textContent = cite.match[1];
            filled.append(part.slice(0, cite.match.index), author, cite.match[2]);
          } else filled.append(part);
          continue;
        }
        if (token.kind === "math" && pixels && token.clip) {
          filled.append(formula(doc, token, unit, page, source, pixels));
          continue;
        }
        if (token.kind==="tex" || token.kind==="math" || (token.kind==="literal" && /[_^]/u.test(token.display))) {
          filled.append(typesetFormula(doc,token.display));continue;
        }
        const link = sourceLink(token, page),
          el = node(doc, link >= 0 ? "a" : "span");
        if (link >= 0) {
          el.href = "#";
          el.dataset.sourceLink = link;
        }
        if (unit.headingNumber?.id === token.id) {
          el.className = "dr-parallel-heading-number";
          el.style.width = unit.headingNumber.width + "px";
        }
        if (unit.typeRole === "reference" && token.kind === "citation" && token.start > 0 &&
            /^\[\d+\]$/u.test(token.source) && token.rect &&
            unit.rects.some(r => Math.abs(r[0] - token.rect[0]) < 0.5 &&
              token.rect[1] >= r[1] - 0.5 && token.rect[3] <= r[3] + 0.5))
          el.dataset.referenceStart = "true";
        if (token.mono || token.kind==="code") el.classList.add("dr-paper-code");
        if (pixels) el.style.color = inkColor(token, page, pixels);
        let value = doc.createTextNode(codeText(token,page,pixels));
        if (token.bold) {
          const strong = node(doc, "strong");
          strong.append(value);
          value = strong;
        }
        if (token.italic) {
          const em = node(doc, "em");
          em.append(value);
          value = em;
        }
        el.append(value);
        filled.append(el);
      }
      text.replaceWith(filled);
    }
    if (/^zh(?:-|$)/i.test(page.language)) DeepRead.PaperType.spaceChinese(frag);
    return linkPassage(doc, frag, unit, page, pixels);
  }
  DeepRead.ParallelInk = { project, orientation, materialize, sharpen, inkColor, stageNoteInks, sourceLink, labelPatch, restoreNativeLabels, flatSource, clippedLabels, panelColors, codeText, paintHoverColors };
})();
