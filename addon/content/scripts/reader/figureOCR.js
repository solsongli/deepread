/* Locate printed English plot labels without changing the original chart data.
 * The OCR worker loads only packaged code and English language data. */
(function () {
  const raw = (o) => o?.wrappedJSObject || o;
  const keyFor = (index) => "figure-labels:v7:" + index;
  const identity = [1, 0, 0, 1, 0, 0];
  function compose([a, b, c, d, e, f], [g, h, i, j, k, l]) {
    return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
  }

  async function embeddedImages(reader, index) {
    const { app, pdfWin } = reader.session.overlay;
    const pdf = raw(await app.pdfDocument.getPage(index + 1)),
      lib = raw(pdfWin).pdfjsLib;
    if (!lib?.OPS || !pdf.getOperatorList) return [];
    const ops = lib.OPS,
      list = raw(await pdf.getOperatorList()),
      stack = [],
      boxes = [];
    const [a, b, c, d] = pdf.view,
      area = (c - a) * (d - b);
    let matrix = identity;
    for (let i = 0; i < list.fnArray.length; i++) {
      const op = list.fnArray[i],
        args = list.argsArray[i];
      if (op === ops.save || op === ops.paintFormXObjectBegin) {
        stack.push(matrix);
        if (op === ops.paintFormXObjectBegin && args?.[0]) matrix = compose(matrix, args[0]);
      } else if (op === ops.restore || op === ops.paintFormXObjectEnd) matrix = stack.pop() || identity;
      else if (op === ops.transform) matrix = compose(matrix, args);
      else if (op === ops.paintImageXObject || op === ops.paintInlineImageXObject) {
        const [w, skewY, skewX, h, x, y] = matrix;
        if (Math.abs(skewX) > 0.05 || Math.abs(skewY) > 0.05 || w < 48 || h < 28 || area <= 0) continue;
        const fraction = (w * h) / area;
        if (fraction < 0.004 || fraction > 0.8) continue;
        if (x < a - 1 || y < b - 1 || x + w > c + 1 || y + h > d + 1) continue;
        const rect = [x, y, x + w, y + h];
        if (!boxes.some((other) => rect.every((v, j) => Math.abs(v - other[j]) < 1))) boxes.push(rect);
      }
    }
    return boxes;
  }

  function captionStrips(images, view) {
    const [left, bottom, right, top] = view;
    const width = right - left, height = top - bottom;
    const panels = images.filter(r => r[2] - r[0] < width * .29 && r[3] - r[1] < height * .16);
    const strips = [];
    for (const panel of panels.sort((a,b) => a[0] - b[0])) {
      const strip = strips.findLast(row => {
        const previous = row.at(-1);
        const gap = panel[0] - previous[2], size = previous[2] - previous[0];
        return Math.abs(row[0][1] - panel[1]) <= 3 && gap >= -size * .18 && gap <= size * .40 &&
          panel[0] - previous[0] > size * .55;
      });
      if (strip) strip.push(panel);
      else strips.push([panel]);
    }
    return strips.filter(row => row.length >= 3).map(panels => {
      const y = Math.min(...panels.map(r => r[1]));
      return {
        rect: [panels[0][0], Math.max(bottom, y - 17), panels.at(-1)[2], Math.min(top, y)],
        panels
      };
    });
  }

  function captionsBelowImages(tsv, image, candidate, scale, chars) {
    const labels = labelBoxes(tsv, image, candidate.rect, scale, chars);
    const selected = [];
    for (const [left, bottom, right] of candidate.panels) {
      const matches = labels.filter(({mask, text}) => {
        const middle = (mask[0] + mask[2]) / 2;
        const center = (left + right) / 2;
        const gap = bottom - mask[3];
        return gap >= -.5 && gap <= 9 && Math.abs(middle - center) <= (right - left) * .22 &&
          mask[0] >= left && mask[2] <= right && text.length <= 32 &&
          /^[\p{L}\d][\p{L}\d &()'’-]*$/u.test(text);
      });
      if (matches.length === 1) {
        const label = matches[0];
        const [x0,y0,x1,y1] = label.mask;
        const center = (x0+x1)/2;
        const [cropLeft,,,cropTop] = candidate.rect;
        const rasterTop = Math.max(0,Math.floor((cropTop-y1)*scale));
        const rasterBottom = Math.min(image.height,Math.ceil((cropTop-y0)*scale));
        let pad = 0;
        for (let room = 1; room <= Math.ceil(label.size*scale*1.5); room++) {
          const a = Math.floor((x0-cropLeft)*scale)-room, b = Math.ceil((x1-cropLeft)*scale)+room;
          if (a<0 || b>=image.width || cropLeft+a/scale<left || cropLeft+b/scale>right) break;
          let white = true;
          for (let y=rasterTop; y<rasterBottom && white; y++)
            white = whiteBackground(image,a,y) && whiteBackground(image,b,y);
          if (!white) break;
          pad = room/scale;
        }
        const half = (x1-x0)/2+pad;
        const rect = [center-half,label.rect[1],center+half,label.rect[3]];
        selected.push({...label,rect,centered:true,panelCaption:true,
          hint:"Short task or panel name printed underneath one of the adjacent figure panels."});
      }
    }
    // A detached note must not be mistaken for a row of panel labels.
    const required = Math.max(3, Math.ceil(candidate.panels.length * .65));
    if (selected.length < required) return [];
    const edges = selected.map(label => label.mask[3]).sort((a,b) => a-b);
    const baseline = edges[Math.floor(edges.length / 2)];
    const aligned = selected.filter(label => Math.abs(label.mask[3] - baseline) <= 2);
    return aligned.length >= required ? aligned : [];
  }

  function tsvWords(tsv) {
    const words = [];
    for (const line of tsv.split(/\r?\n/)) {
      const values = line.split("\t");
      if (values[0] !== "5" || !values[11]?.trim()) continue;
      const [x, y, w, h, confidence] = values.slice(6, 11).map(Number);
      if (!(w > 0 && h > 0 && Number.isFinite(confidence))) continue;
      words.push({ x, y, w, h, confidence, text: values.slice(11).join(" ").trim(), line:values.slice(1, 5).join("/") });
    }
    return words;
  }

  function tsvLines(tsv) {
    const byLine = new Map();
    for (const word of tsvWords(tsv)) {
      if (!byLine.has(word.line)) byLine.set(word.line, []);
      byLine.get(word.line).push(word);
    }
    const groups = [];
    for (const words of byLine.values()) {
      let group = [];
      for (const word of words) {
        const prev = group.at(-1);
        if (prev && word.x - prev.x - prev.w > 2.5 * Math.max(word.h, prev.h)) {
          groups.push(group);
          group = [];
        }
        group.push(word);
      }
      if (group.length) groups.push(group);
    }
    const output = [];
    for (const words of groups) {
      const text = words.map((w) => w.text).join(" ");
      const supportedPhrase = words.filter((w) => w.confidence >= 90).length >= 3;
      if (
        !/[a-z]{2}/.test(text) ||
        text.length < 3 ||
        text.length > 140 ||
        words.some((w) => w.confidence < (supportedPhrase ? 78 : 84)) ||
        words.reduce((s, w) => s + w.confidence, 0) / words.length < 89
      )
        continue;
      const x = Math.min(...words.map((w) => w.x)),
        y = Math.min(...words.map((w) => w.y));
      const X = Math.max(...words.map((w) => w.x + w.w)),
        Y = Math.max(...words.map((w) => w.y + w.h));
      if (
        X - x < (Y - y) * 0.75 ||
        words.some((w, i) => i && w.x - words[i - 1].x - words[i - 1].w > 2.5 * (Y - y))
      )
        continue;
      output.push({ x, y, X, Y, text, firstWord:words[0], secondWord:words[1],
        confidence:words.reduce((s,w)=>s+w.confidence,0)/words.length });
    }
    return output;
  }

  function whiteBackground(data, x, y) {
    const j = (y * data.width + x) * 4,
      p = data.data;
    return (
      Math.min(p[j], p[j + 1], p[j + 2]) >= 229 &&
      Math.max(p[j], p[j + 1], p[j + 2]) - Math.min(p[j], p[j + 1], p[j + 2]) < 13
    );
  }

  // Work on saturated, flat diagram nodes with a dark outline on all four
  // sides. Sampling at four source pixels keeps the search independent of
  // PDF scale and avoids tracing every edge in a plot or photograph.
  function diagramNodes(image) {
    const {width,height,data}=image, step=4, w=Math.ceil(width/step), h=Math.ceil(height/step);
    const palette=new Int16Array(w*h), queue=new Int32Array(w*h), nodes=[];
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      const i=4*(y*step*width+x*step), r=data[i], g=data[i+1], b=data[i+2];
      if (Math.min(r,g,b)>=140 && Math.max(r,g,b)-Math.min(r,g,b)>=14)
        palette[y*w+x]=1+(r>>4)*256+(g>>4)*16+(b>>4);
    }
    const dark=(x,y)=>{
      const at=4*(y*width+x);
      return x>=0 && y>=0 && x<width && y<height && Math.max(data[at],data[at+1],data[at+2])<135;
    };
    for (let p=0; p<palette.length; p++) {
      const color=palette[p];
      if (!color) continue;
      let count=1,l=w,t=h,r=0,b=0;
      queue[0]=p; palette[p]=0;
      for (let pos=0; pos<count; pos++) {
        const k=queue[pos], x=k%w, y=Math.floor(k/w);
        l=Math.min(l,x); r=Math.max(r,x); t=Math.min(t,y); b=Math.max(b,y);
        for (const j of [x>0?k-1:-1,x+1<w?k+1:-1,k-w,k+w]) if (palette[j]===color) {
          palette[j]=0;queue[count++]=j;
        }
      }
      const W=(r-l+1)*step,H=(b-t+1)*step;
      if (W<28 || H<14 || W/H<1.1 || W/H>14 || count*step*step<W*H*.52 || W*H>width*height*.22) continue;
      const x=l*step,y=t*step;
      const sides=[[-1,0],[1,0],[0,-1],[0,1]];
      if (!sides.every(([dx,dy])=>{
        let hits=0;
        for (let i=1;i<=7;i++) {
          const ax=Math.round(x+(dx===0 ? W*i/8 : dx<0 ? 0 : W-1));
          const ay=Math.round(y+(dy===0 ? H*i/8 : dy<0 ? 0 : H-1));
          for (let k=-step;k<=2*step;k++) if (dark(ax+dx*k,ay+dy*k)) { hits++;break; }
        }
        return hits>=5;
      })) continue;
      nodes.push({x:x+2,y:y+2,w:Math.min(W-4,width-x-2),h:Math.min(H-4,height-y-2)});
    }
    return nodes;
  }

  // Extract the node interiors into a single OCR image. Strokes touching the
  // outside are outlines or connectors and never get blanked in the source.
  async function readDiagramNodes(image, source, scale, chars, doc, ocr) {
    const nodes=diagramNodes(image);
    if (nodes.length<2) return [];
    const result=[];
    let batch=[], height=0, width=0;
    for (const node of nodes) {
      const h=node.h+28, w=node.w+28;
      if (batch.length && (height+h>4096 || Math.max(width,w)*(height+h)>3000000)) {
        result.push(...await readNodeBatch(batch,image,source,scale,chars,doc,ocr));
        batch=[]; height=0; width=0;
      }
      batch.push(node); height+=h; width=Math.max(width,w);
    }
    return result.concat(await readNodeBatch(batch,image,source,scale,chars,doc,ocr));
  }

  async function readNodeBatch(nodes, image, source, scale, chars, doc, ocr) {
    const canvas=doc.createElementNS("http://www.w3.org/1999/xhtml","canvas");
    const pad=14;
    canvas.width=Math.max(...nodes.map(n=>n.w))+2*pad;
    canvas.height=nodes.reduce((s,n)=>s+n.h+2*pad,0);
    const ctx=canvas.getContext("2d"), sheet=ctx.createImageData(canvas.width,canvas.height);
    sheet.data.fill(255);
    let offset=0;
    for (const n of nodes) {
      n.top=offset+pad;offset+=n.h+2*pad;
      n.ink=new Uint8Array(n.w*n.h);
      const stack=[];
      for (let y=0;y<n.h;y++) for (let x=0;x<n.w;x++) {
        const i=4*((n.y+y)*image.width+n.x+x), k=y*n.w+x, p=image.data;
        if (Math.max(p[i],p[i+1],p[i+2])<140) {
          n.ink[k]=1;
          if (!x || !y || x===n.w-1 || y===n.h-1) stack.push(k);
        }
      }
      while (stack.length) {
        const k=stack.pop();
        if (n.ink[k]!==1) continue;
        n.ink[k]=2;
        for (let y=Math.max(0,Math.floor(k/n.w)-1);y<=Math.min(n.h-1,Math.floor(k/n.w)+1);y++)
          for(let x=Math.max(0,k%n.w-1);x<=Math.min(n.w-1,k%n.w+1);x++)
            if (n.ink[y*n.w+x]===1) stack.push(y*n.w+x);
      }
      for(let y=0;y<n.h;y++)for(let x=0;x<n.w;x++)if(n.ink[y*n.w+x]===1) {
        const i=4*((n.top+y)*canvas.width+pad+x);
        sheet.data[i]=sheet.data[i+1]=sheet.data[i+2]=0;
      }
    }
    ctx.putImageData(sheet,0,0);
    let tsv;
    try { tsv=await ocr(canvas,"block"); } finally {canvas.width=canvas.height=0;}
    const words=tsvWords(tsv).map(w=>({...w,x:w.x-pad}));
    const toPDF=(x,y,X,Y)=>[source[0]+x/scale,source[3]-Y/scale,source[0]+X/scale,source[3]-y/scale];
    const result=[];
    for(const n of nodes) {
      const local=words.filter(w=>w.y>=n.top && w.y+w.h<=n.top+n.h).map(w=>({...w,y:w.y-n.top}));
      const text=local.map(w=>w.text).join(" ");
      if (!/[a-z]{2}/iu.test(text) || text.length>85 || local.some(w=>w.confidence<78) ||
          local.reduce((sum,w)=>sum+w.confidence,0)/local.length<88 ||
          local.some((w,i)=>i && w.line===local[i-1].line && w.x-local[i-1].x-local[i-1].w>1.25*w.h)) continue;
      const left=Math.max(0,Math.min(...local.map(w=>w.x))-2), right=Math.min(n.w,Math.max(...local.map(w=>w.x+w.w))+2);
      const top=Math.max(0,Math.min(...local.map(w=>w.y))-2), bottom=Math.min(n.h,Math.max(...local.map(w=>w.y+w.h))+2);
      let ink=0,missed=0,outline=false;
      for(let y=0;y<n.h;y++)for(let x=0;x<n.w;x++) {
        const v=n.ink[y*n.w+x];
        if (v===2 && x>=left && x<right && y>=top && y<bottom) outline=true;
        if (v!==1) continue;
        ink++;
        if (!local.some(w=>x>=w.x-2 && x<w.x+w.w+2 && y>=w.y-2 && y<w.y+w.h+2)) missed++;
      }
      if (outline || ink<6 || missed>Math.max(3,ink*.025)) continue;
      const rect=toPDF(n.x,n.y,n.x+n.w,n.y+n.h);
      if (chars.some(c=>c.rect && c.rect[0]<rect[2] && c.rect[2]>rect[0] && c.rect[1]<rect[3] && c.rect[3]>rect[1])) continue;
      const mask=toPDF(n.x+left,n.y+top,n.x+right,n.y+bottom);
      const size=Math.min((rect[3]-rect[1])*.91,Math.max(...local.map(w=>w.h))/scale*1.16);
      result.push({text,mask,rect,size,centered:true});
    }
    return result;
  }

  function labelBoxes(tsv, image, source, scale, chars, panelHeadingsOnly = false) {
    const labels = [];
    const lines = tsvLines(tsv);
    for (const line of lines) {
      let { x, y, X, Y, text } = line;
      const panel = panelHeadingsOnly ? panelHeading.exec(text) : null;
      if (panelHeadingsOnly) {
        if (!panel || !line.secondWord || line.secondWord.x-line.firstWord.x-line.firstWord.w<2) continue;
        // The original (a), (b), etc. is a graphic in its own right.
        // Replace the adjacent words while keeping those pixels intact.
        x = line.secondWord.x;
        text = text.slice(line.firstWord.text.length).trimStart();
      }
      if (x < 3 || y < 3 || X > image.width - 3 || Y > image.height - 3) continue;
      // A diagram node may be printed on a uniform pastel fill. Learn the
      // local background and verify it along the entire perimeter before
      // replacing any ink or allowing the translated label to expand.
      const corners = [[x-2,y-2],[X+1,y-2],[x-2,Y+1],[X+1,Y+1]];
      const bg = [0,1,2].map(channel => corners.map(([px,py]) =>
        image.data[(py * image.width + px) * 4 + channel]).sort((a,b) => a - b)[1]);
      const darkestChannel = Math.min(...bg);
      if (darkestChannel < 140) continue;
      const blank = (px,py) => {
        const at = (py * image.width + px) * 4;
        return bg.every((v,i) => Math.abs(v - image.data[at+i]) <= 18);
      };
      let ring = 0,
        clear = 0,
        colored = 0,
        ink = 0;
      for (let row = y - 2; row <= Y + 1; row++)
        for (let col = x - 2; col <= X + 1; col++) {
          const j = (row * image.width + col) * 4,
            p = image.data;
          if (row < y || row >= Y || col < x || col >= X) {
            ring++;
            if (blank(col, row)) clear++;
            continue;
          }
          if (!blank(col, row) && Math.min(p[j], p[j + 1], p[j + 2]) < darkestChannel - 40) {
            ink++;
            if (Math.max(p[j], p[j + 1], p[j + 2]) - Math.min(p[j], p[j + 1], p[j + 2]) > 45) colored++;
          }
        }
      if (ink < 5 || colored > ink * 0.15) continue;
      let pad=2;
      if (clear < ring * 0.93) {
        // A one-pixel OCR underestimate can put the last stroke in the
        // background sample. Require a second independent read of the same
        // word and two completely empty outer perimeters before widening it.
        const confirmed=line.confidence>=94 && lines.some(l => l!==line && l.text===text &&
          l.confidence>=94 && Math.abs(l.X-l.x-X+x)<=3 && Math.abs(l.Y-l.y-Y+y)<=2);
        if (!confirmed || clear < ring*.80 || x<3 || y<3 || X+2>=image.width || Y+2>=image.height) continue;
        let free=true;
        for (const d of [2,3]) {
          for (let px=x-d;px<X+d;px++) if (!blank(px,y-d) || !blank(px,Y+d-1)) free=false;
          for (let py=y-d;py<Y+d;py++) if (!blank(x-d,py) || !blank(X+d-1,py)) free=false;
        }
        if (!free) continue;
        pad=3;
      }
      const mask = [
        source[0] + (x - pad) / scale,
        source[3] - (Y + pad) / scale,
        source[0] + (X + pad) / scale,
        source[3] - (y - pad) / scale
      ];
      if (
        chars.some(
          (c) =>
            c.rect &&
            (c.rect[0] + c.rect[2]) / 2 >= mask[0] &&
            (c.rect[0] + c.rect[2]) / 2 <= mask[2] &&
            (c.rect[1] + c.rect[3]) / 2 >= mask[1] &&
            (c.rect[1] + c.rect[3]) / 2 <= mask[3]
        )
      )
        continue;
      const inkHeight = (Y-y)/scale;
      const size = inkHeight / (panel ? 1 : /[gjpqy]/.test(text) ? .9 : .75);
      if (size < 3 || size > 30) continue;
      // Allow a short translation to use blank paper next to the label. Stop
      // as soon as any neighbouring mark, grid or colour key is encountered.
      let edge = X + 2;
      for (; edge < Math.min(image.width - 1, X + size * scale * 2.8); edge++) {
        let white = true;
        for (let py = y - 2; py <= Y + 1; py++)
          if (!blank(edge, py)) {
            white = false;
            break;
          }
        if (!white) break;
      }
      const centered = !panel &&
        y / image.height < 0.22 && text.includes(" ") && x > image.width * 0.12 && X < image.width * 0.87;
      const freeRows = (start, step) => {
        let n = 0;
        for (; n < size * scale * 0.7; n++) {
          const py = start + step * n;
          if (py < 0 || py >= image.height) break;
          let clear = true;
          for (let px = x - 1; px <= X + 1; px++)
            if (!blank(px, py)) {
              clear = false;
              break;
            }
          if (!clear) break;
        }
        return Math.max(0, n - 1) / scale;
      };
      const rect = [mask[0], mask[1], centered ? mask[2] : source[0] + edge / scale, mask[3]];
      labels.push({ text, rect, mask, size, centered, ...(panel ? {panelIndex:panel[1].toLowerCase(),flushLeft:true} : {}),
        above: freeRows(y - 3, -1), below: freeRows(Y + 2, 1) });
    }
    const sizes = labels.map((l) => l.size);
    for (const [i, label] of labels.entries()) {
      const peers = labels
        .flatMap((other, j) =>
          !label.centered &&
          !other.centered &&
          Math.abs(other.rect[0] - label.rect[0]) < label.size &&
          Math.abs(sizes[j] - sizes[i]) < sizes[i] * 0.25
            ? [sizes[j]]
            : []
        )
        .sort((a, b) => a - b);
      const nominal = peers.length >= 3 ? peers[Math.floor(peers.length / 2)] : sizes[i];
      const top = label.mask[3] + label.above,
        bottom = label.mask[1] - label.below;
      const centre = (label.mask[1] + label.mask[3]) / 2;
      const spacing = Math.min(
        Infinity,
        ...labels
          .filter((other) => other !== label && Math.abs(other.mask[0] - label.mask[0]) < nominal)
          .map((other) => Math.abs((other.mask[1] + other.mask[3]) / 2 - centre))
      );
      label.size = Math.min(nominal * (peers.length >= 3 ? 1.25 : 1.16), (top - bottom) / 1.09, spacing * 0.72);
      const height = label.size * 1.09,
        mid = (label.mask[3] + label.mask[1]) / 2;
      label.rect[1] = Math.max(bottom, Math.min(top - height, mid - height / 2));
      label.rect[3] = label.rect[1] + height;
      delete label.above;
      delete label.below;
    }
    const title = labels.find((label) => label.centered)?.text;
    if (title) for (const label of labels) label.hint = title;
    return labels;
  }

  const panelHeading = /^\(([a-z])\)\s+(?:[\p{L}][\p{L}\d/-]*\s+){2,}[\p{L}\d][\p{L}\d/ -]*:?$/iu;

  function outlinedPanelHeadings(tsv, image, region, scale, chars) {
    const labels = labelBoxes(tsv, image, region, scale, chars,true)
      .map(label => ({...label, order:label.panelIndex.charCodeAt(0)-97}));
    if (labels.length < 2 || !labels.some(label => label.order === 0)) return [];
    labels.sort((a,b)=>a.order-b.order);
    // Confirm these are a series of panel names, not an OCR hit on a
    // single isolated footnote. Match the series in physical reading order.
    for (const [i,label] of labels.entries()) {
      if (label.order !== i) return [];
      if (!i) continue;
      const previous=labels[i-1];
      const delta=previous.mask[3]-label.mask[3];
      if (delta < -1.5 || (delta <= 1.5 && label.mask[0] <= previous.mask[2])) return [];
    }
    return labels.map(({order,...label})=>({...label,
      hint:"Heading printed after the letter ("+label.panelIndex+") in a figure."}));
  }

  function vectorCandidates(page) {
    if (page.figureLabelsCached) return [];
    const [l,b,r,t]=page.view, width=r-l, height=t-b;
    return (page.vectorPanelRegions || []).flatMap(item => {
      const box=DeepRead.ParallelPage.fromPermille(item.bbox,page.view);
      if (!box || box[2]-box[0]<width*.42 || box[3]-box[1]<height*.17) return [];
      const labels=page.units.filter(u=>u.role==="figure_label" && u.matched && u.visualOwner===item.id && u.rect);
      if (labels.length<4) return [];
      const left=Math.min(...labels.map(u=>u.rect[0])), right=Math.max(...labels.map(u=>u.rect[2]));
      if (right-left < width*.28) return [];
      return [{outlined:true,rect:[Math.max(l,box[0]-16),box[1],Math.min(r,box[2]+16),box[3]]}];
    }).slice(0,1);
  }

  // Subset display fonts sometimes map letters to printable punctuation. The
  // glyph geometry is still usable for reading the corresponding image label.
  function encodedFigureLines(chars, images, view) {
    const candidates = [];
    let run = [];
    function finish() {
      if (!run.length) return;
      const row = run;
      run = [];
      const text = row.map(c => c.u || c.c || "").join("");
      const punct = text.match(/[!"#$%&'()*+,/:;<=>?@^_`{|}~]/g) || [];
      if (text.length < 4 || punct.length < text.length * (text.length < 7 ? .75 : .28) || /[a-zA-Z]{4}/.test(text) ||
          /math|symbol|cmmi|cmsy|cmex/i.test(row[0].fontName || "")) return;
      const box = DeepRead.Overlay.unionRect(row.map(c => c.rect));
      const em = row[0].fontSize;
      if (!(em >= 3 && em <= 30 && box[2] - box[0] > em * 2)) return;
      if (!images.some(r => r[0] < box[2] && r[2] > box[0] &&
        r[1] < box[3] + em * 2 && r[3] > box[1] - em * 2)) return;
      const rect = [Math.max(view[0], box[0] - em * .5), Math.max(view[1], box[1] - em * .45),
        Math.min(view[2], box[2] + em * .5), Math.min(view[3], box[3] + em * .45)];
      candidates.push({ rect, box, em, bold: DeepRead.Typography.bold(row[0]) });
    }
    for (const c of chars) {
      if (!c.rect || c.rotation || c.diagonal) { finish(); continue; }
      const prev = run.at(-1);
      if (prev && (prev.fontName !== c.fontName || Math.abs(prev.baseline - c.baseline) > c.fontSize * .2 ||
          c.rect[0] - prev.rect[2] > c.fontSize || c.rect[0] < prev.rect[0] - 1)) finish();
      run.push(c);
      if (c.lineBreakAfter || c.paragraphBreakAfter) finish();
    }
    finish();
    return candidates;
  }

  async function discover(reader, page) {
    if (page.imageCandidates !== undefined) return;
    const cache = await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint, keyFor(page.index));
    page.rasterLabels = Array.isArray(cache) ? cache : [];
    page.figureLabelsCached=Array.isArray(cache);
    if (Array.isArray(cache)) {
      page.imageCandidates = [];
      return;
    }
    try {
      const stripCache = await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint,
        "figure-labels:v6:" + page.index);
      const current = stripCache || await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint,
        "figure-labels:v5:" + page.index);
      const recent = await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint,
        "figure-labels:v4:" + page.index) || await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint,
        "figure-labels:v3:" + page.index);
      const previous = recent || await DeepRead.Store.comparisonData(reader.session.key, page.fingerprint,
        "figure-labels:v2:" + page.index);
      const images = await embeddedImages(reader, page.index);
      const area = (page.view[2] - page.view[0]) * (page.view[3] - page.view[1]);
      const [a,b,c,d] = page.view;
      const artwork = images.filter(r => {
        const w=r[2]-r[0], h=r[3]-r[1];
        return !(r[3] > b+(d-b)*.9 && w<(c-a)*.4 && h<(d-b)*.1);
      });
      const diagrams = artwork.filter(r => (r[2]-r[0])*(r[3]-r[1]) >= area*.012);
      const strips = captionStrips(images, page.view);
      const encoded = encodedFigureLines(page.chars, artwork, page.view);
      if (Array.isArray(current)) page.rasterLabels=current;
      else if (Array.isArray(recent)) page.rasterLabels=recent;
      else if (Array.isArray(previous)) {
        // Version 2 assumed an inverted label was always white-on-dark.
        // Measure it again even if OCR recognized the words successfully.
        page.rasterLabels = previous.filter(label => !encoded.some(candidate =>
          label.mask.every((v,i) => Math.abs(v-candidate.box[i]) < 1)));
      }
      const existing = Array.isArray(current) ? [] : Array.isArray(recent) ? diagrams : [...diagrams, ...encoded];
      page.imageCandidates = Array.isArray(stripCache) ? existing : [...existing, ...strips];
    } catch (error) {
      page.imageCandidates = [];
      page.figureError = true;
      DeepRead.log("Could not inspect embedded images", String(error));
    }
  }

  async function recognize(reader, page, signal) {
    await discover(reader, page);
    if (page.figureLabelsCached || signal.aborted) return;
    const candidates=[...page.imageCandidates,...vectorCandidates(page)];
    if (!candidates.length) {
      await DeepRead.Store.saveComparisonData(reader.session.key,page.fingerprint,keyFor(page.index),page.rasterLabels);
      page.figureLabelsCached=true;
      return;
    }
    const overlay = reader.session.overlay,
      win = overlay.pdfWin,
      pdf = raw(await overlay.app.pdfDocument.getPage(page.index + 1));
    let worker, task, rejectPending;
    const abort = () => {
      task?.cancel();
      worker?.terminate();
      rejectPending?.(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    async function ocr(canvas,mode) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const bytes = await blob.arrayBuffer();
      if (signal.aborted) throw Object.assign(new Error("Aborted"),{name:"AbortError"});
      worker ||= new (Zotero.getMainWindow().ChromeWorker)(
        "chrome://deepread/content/scripts/reader/figureOCRWorker.js"
      );
      const tsv = await new Promise((resolve, reject) => {
        rejectPending = reject;
        worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.tsv));
        worker.onerror = (e) => reject(new Error(e.message || "OCR worker failed"));
        worker.postMessage({bytes, mode}, [bytes]);
      });
      rejectPending = null;
      return tsv;
    }
    const labels = [...page.rasterLabels];
    try {
      for (const candidate of candidates) {
        const encoded = !!candidate.box;
        const rect = candidate.rect || candidate;
        if (signal.aborted) break;
        const scale = Math.min(4.8, 1800 / (rect[2] - rect[0]), 1500 / (rect[3] - rect[1]));
        const viewport = raw(pdf.getViewport(Components.utils.cloneInto({ scale, rotation: 0 }, win)));
        const bounds = DeepRead.ParallelInk.project(rect, viewport.transform);
        const canvas = overlay.pdfDoc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        canvas.width = Math.max(1, Math.ceil(bounds.width));
        canvas.height = Math.max(1, Math.ceil(bounds.height));
        try {
          const ctx = canvas.getContext("2d");
          const args = raw(Components.utils.createObjectIn(win));
          args.canvasContext = raw(ctx);
          args.viewport = viewport;
          args.transform = Components.utils.cloneInto([1, 0, 0, 1, -bounds.left, -bounds.top], win);
          task = raw(pdf.render(args));
          await task.promise;
          task = null;
          if (signal.aborted) break;
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let white = 0,
            total = 0;
          for (let y = 4; y < image.height; y += 12)
            for (let x = 4; x < image.width; x += 12) {
              total++;
              if (whiteBackground(image, x, y)) white++;
            }
          if (!total || (!encoded && white / total < 0.5)) continue;
          // A colour swatch can be read as an extra letter of its legend
          // entry. Remove chromatic ink only from the worker's scratch input.
          // The original pixels still decide which label areas may be erased.
          const lightInk = encoded && white / total < .5;
          const neutral = ctx.createImageData(image.width, image.height);
          neutral.data.set(image.data);
          for (let i = 0; i < neutral.data.length; i += 4) {
            const p = neutral.data;
            if (encoded) {
              const minimum = Math.min(p[i], p[i + 1], p[i + 2]);
              const isInk = lightInk ? minimum >= 220 : Math.max(p[i], p[i + 1], p[i + 2]) < 170;
              const level = isInk ? 0 : 255;
              p[i] = p[i + 1] = p[i + 2] = level;
            } else if (Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]) > 38)
              p[i] = p[i + 1] = p[i + 2] = 255;
          }
          ctx.putImageData(neutral, 0, 0);
          const tsv = await ocr(canvas, encoded ? "line" : "sparse");
          if (candidate.outlined) {
            labels.push(...outlinedPanelHeadings(tsv,image,rect,scale,page.chars).filter(label=>
              !labels.some(other=>other.mask.every((v,i)=>Math.abs(v-label.mask[i])<1))));
          } else if (candidate.panels) {
            for (const label of captionsBelowImages(tsv,image,candidate,scale,page.chars)) {
              if (!labels.some(other => other.mask.every((v,i) => Math.abs(v-label.mask[i]) < 1))) labels.push(label);
            }
          } else if (encoded) {
            const lines = tsvLines(tsv);
            if (lines.length !== 1) continue;
            const [line] = lines;
            const {box, em, bold} = candidate;
            // A partial OCR hit would erase the remaining words.
            if (Math.abs(rect[0] + line.x / scale - box[0]) > em * .6 ||
                Math.abs(rect[0] + line.X / scale - box[2]) > em * .6 ||
                !/[a-z]{2}/i.test(line.text)) continue;
            labels.push({text: line.text, rect: box, mask: box, size: em, centered: true,
              nativeOCR: true, lightInk, bold});
          } else {
            const nodes = await readDiagramNodes(image,rect,scale,page.chars,overlay.pdfDoc,ocr);
            const contains = (node,label) => label.mask[0]>=node.rect[0]-1 && label.mask[2]<=node.rect[2]+1 &&
              label.mask[1]>=node.rect[1]-1 && label.mask[3]<=node.rect[3]+1;
            const isolated=labelBoxes(tsv,image,rect,scale,page.chars).filter(label=>!nodes.some(n=>contains(n,label)));
            for (let i=labels.length-1;i>=0;i--)
              if (nodes.some(n=>contains(n,labels[i]))) labels.splice(i,1);
            for (const label of [...isolated,...nodes]) {
              const duplicate = labels.some(old => old.text === label.text &&
                old.mask.every((v,i) => Math.abs(v - label.mask[i]) < 1));
              if (!duplicate) labels.push(label);
            }
          }
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
      if (signal.aborted) return;
      await DeepRead.Store.saveComparisonData(reader.session.key, page.fingerprint, keyFor(page.index), labels);
      page.rasterLabels = labels;
      page.imageCandidates = [];
      page.figureLabelsCached = true;
    } finally {
      signal.removeEventListener("abort", abort);
      worker?.terminate();
    }
  }

  DeepRead.FigureOCR = { discover, recognize };
})();
