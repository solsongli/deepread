/* Print the actual translated text and original artwork at the physical PDF size.
 * Gecko creates selectable text. pdf-lib preserves exact page boxes and collects pages.
 * License: AGPL-3.0-or-later */
(function () {
  let library;
  const element = (doc, tag) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag);

  async function create() {
    if (!library) {
      const scope = { setTimeout, clearTimeout, Uint8Array, ArrayBuffer };
      Services.scriptloader.loadSubScript(`${DeepRead.rootURI}content/lib/pdf-lib/pdf-lib.min.js`, scope);
      library = scope.PDFLib;
    }
    return library.PDFDocument.create();
  }

  async function readSource(reader, sourcePath) {
    // IOUtils returns bytes in the add-on compartment. Reading a content
    // window's typed-array elements through Xrays is forbidden by Gecko.
    const bytes = await IOUtils.read(sourcePath);
    const source = await library.PDFDocument.load(Uint8Array.from(bytes), { updateMetadata: false });
    if (source.getPageCount() !== reader.count) throw new Error("PDF page count changed");
    const ids = source.context.lookup(source.context.trailerInfo.ID);
    const id = ids?.get?.(0)?.asBytes?.();
    const opened = reader.session.overlay.app.pdfDocument.fingerprints?.[0];
    if (
      id?.length === 16 &&
      opened &&
      !id.every((b) => !b) &&
      Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("") !== opened
    )
      throw new Error("The displayed PDF differs from the file on disk");
    return source;
  }

  // Copy only page painting data for a parser. Annotations, outlines and page
  // destinations can otherwise pull unselected pages into PDFObjectCopier.
  async function sourceSlices(reader,path) {
    await create();
    const source = await readSource(reader,path);
    return async indices=>{
      const target=await create(), copier=library.PDFObjectCopier.for(source.context,target.context);
      for (const index of indices) {
        const from=source.getPage(index).node, to=target.addPage().node;
        for (const key of ["MediaBox","CropBox","Rotate","Resources","Contents","Group","UserUnit"]) {
          const name=library.PDFName.of(key), value=from.getInheritableAttribute(name);
          if(value) to.set(name,copier.copy(value));
        }
      }
      return Uint8Array.from(await target.save());
    };
  }

  function withCanvases(doc, original) {
    const copy = doc.importNode(original, true);
    const canvases = [...copy.querySelectorAll("canvas")];
    [...original.querySelectorAll("canvas")].forEach((src, i) =>
      canvases[i].getContext("2d").drawImage(src, 0, 0)
    );
    return copy;
  }

  function sheetStyles(doc, url) {
    return new Promise((resolve, reject) => {
      const link = element(doc, "link");
      link.rel = "stylesheet";
      link.href = url;
      link.onload = resolve;
      link.onerror = () => reject(new Error("Could not load " + url));
      doc.head.append(link);
    });
  }

  async function snapshot(reader, frame, signal) {
    const { page, target } = reader,
      doc = frame.contentDocument;
    doc.documentElement.lang = page.language === "zh" ? "zh-CN" : page.language;
    const csp = element(doc, "meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.content = "default-src 'none'; style-src 'unsafe-inline' chrome:; img-src data:; font-src chrome: data:";
    doc.head.append(csp);
    const sheets = [sheetStyles(doc, "chrome://deepread/content/styles/parallel.css"), DeepRead.PaperType.install(doc).sheet];
    if (target.stage.querySelector(".katex") || reader.extra.querySelector(".katex"))
      sheets.push(sheetStyles(doc, "chrome://deepread/content/lib/katex/katex.min.css"));
    const style = element(doc, "style");
    style.textContent = `@page {size:${page.width}pt ${page.height}pt;margin:0} html,body {margin:0;padding:0;color:#171717;background:white} * {print-color-adjust:exact}
      .sheet {position:relative;width:${page.width}pt;height:${page.height}pt;overflow:hidden;margin:0;break-inside:avoid}
      .dr-parallel-stage {transform:scale(1.3333333333)!important;transform-origin:0 0!important} .dr-native-paired {outline:none!important}
      .supplement {break-before:page;padding:24pt;font-size:11pt;line-height:1.55;overflow-wrap:anywhere} .supplement p {margin:.6em 0}
      .dr-parallel-text[data-type-role]:not([data-overflow]) {overflow:visible}
      .dr-parallel-line a {color:inherit;text-decoration:none} .dr-parallel-text[data-overflow] {overflow:hidden;scrollbar-width:none}`;
    doc.head.append(style);
    const sheet = element(doc, "div");
    sheet.className = "sheet";
    const stage = withCanvases(doc, target.stage);
    for (const link of stage.querySelectorAll("a")) {
      const annotation = page.links?.[Number(link.dataset.sourceLink)];
      if (/^(?:https?:\/\/|mailto:)/i.test(annotation?.url || "")) link.href = annotation.url;
      else link.removeAttribute("href");
    }
    sheet.append(stage);
    doc.body.append(sheet);
    const supplementStyles=[];
    if (page.supplements?.length) {
      const section = element(doc, "section");
      section.className = "supplement";
      DeepRead.PaperType.apply(section, page.language);
      const heading = element(doc, "h3");
      heading.textContent = DeepRead.bilingual(
        `第 ${page.index + 1} 页 · 补充译文`,
        `Page ${page.index + 1} · Full passages`
      );
      section.append(heading);
      const styles=page.styleProfile?.roles;
      doc.body.append(section);
      if (styles) DeepRead.PaperStyles.apply(heading,styles.heading,4/3);
      let previous=styles?.heading;
      const canvas = reader.source.canvas,
        pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      for (const unit of page.supplements) {
        const paragraph = element(doc, "p");
        const translated = doc.importNode(
          reader.session.overlay._translationContent(unit, unit.translation, page.language),
          true
        );
        const content=DeepRead.ParallelInk.materialize(doc, translated, unit, page, canvas, pixels);
        if(!unit.title && !unit.caption && /^zh(?:-|$)/i.test(page.language)) DeepRead.PaperType.separateLead(content,unit.modelText);
        const type=styles?.[unit.typeRole] || styles?.body;
        if (type) {
          DeepRead.PaperType.apply(paragraph,page.language);
          DeepRead.PaperStyles.apply(paragraph,type,4/3);
          supplementStyles.push({paragraph,type});
          if(type.role.endsWith("Caption")) DeepRead.PaperStyles.captionLabel(content);
          paragraph.style.margin=Math.max(type.before,previous?.after || 0)+"pt 0 0";
          previous=type;
        }
        paragraph.append(content);
        section.append(paragraph);
      }
    }
    await Promise.all(sheets);
    doc.documentElement.getBoundingClientRect();
    await doc.fonts.ready;
    for (const {paragraph,type} of supplementStyles) DeepRead.ParallelTypeset.fitMath(paragraph,paragraph,type,4/3);
    const equations=(page.equations || []).filter(r=>r.width>0 && r.height>0 &&
      !page.dirtyRects.some(b=>r.left < b.left+b.width && r.left+r.width > b.left &&
        r.top < b.top+b.height && r.top+r.height > b.top));
    if (equations.length || doc.querySelector("canvas[data-math-crop]")) {
      const detail=await DeepRead.ParallelDetail.raster(reader,page,4,signal);
      if (detail && !signal.aborted) {
        // Display equations remain in the original PDF in the native reader.
        // At print time give these untouched regions the same density as inline math.
        const sx=detail.width/page.width, sy=detail.height/page.height;
        for (const r of equations) {
          const x=Math.max(0,Math.floor(r.left*sx)), y=Math.max(0,Math.floor(r.top*sy));
          const w=Math.min(detail.width,Math.ceil((r.left+r.width)*sx))-x;
          const h=Math.min(detail.height,Math.ceil((r.top+r.height)*sy))-y;
          if(w<=0 || h<=0)continue;
          const crop=element(doc,"canvas");crop.width=w;crop.height=h;
          Object.assign(crop.style,{position:"absolute",left:x/sx+"px",top:y/sy+"px",width:w/sx+"px",height:h/sy+"px"});
          crop.getContext("2d").drawImage(detail,x,y,w,h,0,0,w,h);
          stage.firstElementChild.after(crop);
        }
        DeepRead.ParallelInk.sharpen(doc.body,detail,page);
      }
    }
  }

  function baselineGrid(reader) {
    const stage=reader.target.stage, lines=[];
    for (const box of stage.querySelectorAll(".dr-parallel-text[data-type-role]")) {
      const size=parseFloat(box.style.fontSize),step=parseFloat(box.style.lineHeight);
      const x=parseFloat(box.style.left),y=parseFloat(box.style.top),ascent=.84*size+.24*(step-size);
      const q=Number(/rotate\((\d+)/u.exec(box.style.transform)?.[1] || 0)/90;
      const ux=[1,0,-1,0][q],uy=[0,1,0,-1][q];
      let i=0;
      for (const row of box.querySelectorAll(".dr-parallel-grid-line")) {
        const quad=row.firstChild.getBoxQuads({relativeTo:stage})[0];
        if (quad) {
          const ends=[quad.p1,quad.p2,quad.p3,quad.p4].map(p=>p.x*ux+p.y*uy);
          lines.push({size,ux,uy,left:Math.min(...ends),right:Math.max(...ends),
            baseline:-uy*x+ux*y+ascent+i*step});
        }
        i++;
      }
    }
    return lines;
  }

  function alignText(pdf,lines) {
    if (!lines.length) return;
    const page=pdf.getPage(0),input=page.node.Contents();
    const streams=input instanceof library.PDFArray ? input.asArray().map(x=>pdf.context.lookup(x)) : [input];
    if (!streams.every(s=>s instanceof library.PDFRawStream)) return;
    const parts=[];
    for(const stream of streams) {
      const bytes=library.decodePDFRawStream(stream).decode();
      // Preserve all byte values, including literal text from a subset font.
      for(let i=0;i<bytes.length;i+=8192) parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
      parts.push("\n");
    }
    const fixed=DeepRead.PrintGrid.snap(parts.join(""),lines,page.getMediaBox());
    if (fixed) page.node.set(library.PDFName.of("Contents"),pdf.context.register(
      pdf.context.flateStream(Uint8Array.from(fixed,ch=>ch.charCodeAt(0)))));
  }

  function restoreTextMapping(pdf, sourceText) {
    // Cairo can map a shared glyph to the Kangxi radical ⾼ instead of 高,
    // or to a presentation ligature. Recover only characters actually present
    // in the printed text. The font program and its visible glyphs stay intact.
    const { PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = library;
    const seen = new Set();
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const ref = obj.get(PDFName.of("ToUnicode"));
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const cmap = new TextDecoder().decode(decodePDFRawStream(stream).decode());
      const fixed = cmap.replace(/\d+ beginbfchar[\s\S]*?endbfchar/g, (table) =>
        table.replace(/(<[0-9a-f]+>\s+)<(2f[0-9a-f]{2}|fb0[0-6])>/gi, (pair, key, hex) => {
          const raw = String.fromCharCode(parseInt(hex, 16)),
            normalized = raw.normalize("NFKC");
          if (raw === normalized || sourceText.includes(raw) || !sourceText.includes(normalized)) return pair;
          const code = Array.from(normalized, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
          return key + "<" + code + ">";
        })
      );
      if (fixed !== cmap) pdf.context.assign(ref, pdf.context.flateStream(fixed));
    }
  }

  // Share original fonts and images across the whole export. Copying just the
  // page Form also avoids dragging the original page tree in through annotations.
  async function facingDocument(output, reader, sourcePath, options = {}) {
    const pdfjs = reader.session.overlay.app.pdfDocument;
    let source, copier;
    try {
      source = await readSource(reader, sourcePath);
      copier = library.PDFObjectCopier.for(source.context, output.context);
    } catch (error) {
      DeepRead.log("Using the reader image for the original side", String(error));
    }
    const sheets = new Map(),
      pending = [],
      destinations = new Map();
    const name = library.PDFName.of;

    async function original(sheet, page, left, bottom) {
      if (copier && !page.hasAnnotationArtwork) {
        try {
          const leaf = source.getPage(page.index).node;
          if (!leaf.Contents()) return;
          const [x0, y0, x1, y1] = page.view;
          const form = await library.PDFPageEmbedder.for(
            leaf,
            { left: x0, bottom: y0, right: x1, top: y1 },
            [1, 0, 0, 1, 0, 0]
          );
          const ref = await form.embedIntoContext(source.context);
          const group = leaf.get(name("Group"));
          if (group) source.context.lookup(ref).dict.set(name("Group"), group);
          const resource = sheet.node.newXObject("Original", copier.copy(ref));
          const [a, b, c, d, e, f] = page.transform;
          sheet.pushOperators(
            library.pushGraphicsState(),
            library.concatTransformationMatrix(a, -b, c, -d, left + e, bottom + page.height - f),
            library.drawObject(resource),
            library.popGraphicsState()
          );
          return;
        } catch (error) {
          DeepRead.log("Using original raster on page " + (page.index + 1), String(error));
        }
      }
      const visible = page.detailCanvas || reader.source.canvas;
      const image = await output.embedPng(visible.toDataURL("image/png"));
      sheet.drawImage(image, { x: left, y: bottom, width: page.width, height: page.height });
    }

    function annotation(sheet, rect, action) {
      const dict = output.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: rect,
        Border: [0, 0, 0],
        ...action
      });
      sheet.node.addAnnot(output.context.register(dict));
    }

    function addLink(sheet, link, rect, originalSide) {
      if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
      if (/^(?:https?:\/\/|mailto:)/iu.test(link.url || "")) {
        const bytes = new TextEncoder().encode(link.url);
        const uri = library.PDFHexString.of(Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""));
        annotation(sheet, rect, { A: { S: "URI", URI: uri } });
      } else if (link.dest) pending.push({ sheet, rect, dest: link.dest, originalSide });
    }

    async function appendPair(pages, page) {
      const translated=pages[0], {width,height}=page, box=translated.getMediaBox();
      const x=box.x, top=box.y+height;
      let sourceSheet=translated, left, sourceTop;
      if (options.layout==="alternating") {
        if (options.translationFirst) for (const leaf of pages) output.addPage(leaf);
        sourceSheet=output.addPage([width,height]); left=0;sourceTop=height;
        await original(sourceSheet,page,left,0);
        if (!options.translationFirst) for (const leaf of pages) output.addPage(leaf);
      } else {
        left=options.translationFirst ? x+width : x-width;sourceTop=top;
        await original(translated,page,left,box.y);
        translated.setMediaBox(Math.min(left,x),box.y,width*2,height);
        translated.setCropBox(Math.min(left,x),box.y,width*2,height);
        for (const leaf of pages) output.addPage(leaf);
      }
      sheets.set(page.index,{sourceRef:sourceSheet.ref,targetRef:translated.ref,x,left,top,sourceTop,width,height,
        view:page.view,anchors:page.typeAnchors,transform:page.transform});
      for (const link of page.links || []) {
        const r=DeepRead.ParallelInk.project(link.rect,page.transform);
        addLink(sourceSheet,link,[left+Math.max(0,r.left),sourceTop-Math.min(height,r.top+r.height),
          left+Math.min(width,r.left+r.width),sourceTop-Math.max(0,r.top)],true);
      }
      // Gecko already prints external links in the translated text. Internal
      // links need the output page references, including any supplement pages.
      for (const el of reader.target.stage.querySelectorAll("a[data-source-link]")) {
        const link = page.links?.[Number(el.dataset.sourceLink)];
        if (!link?.dest || link.url) continue;
        for (const quad of el.getBoxQuads({ relativeTo: reader.target.stage })) {
          const r = quad.getBounds();
          addLink(
            translated,
            link,
            [
              x + Math.max(0, r.left),
              top - Math.min(height, r.bottom),
              x + Math.min(width, r.right),
              top - Math.max(0, r.top)
            ],
            false
          );
        }
      }
    }

    async function finish(signal) {
      for (const { sheet, rect, dest, originalSide } of pending) {
        if (signal.aborted) return;
        const key = JSON.stringify(dest);
        if (!destinations.has(key)) {
          let resolved;
          try {
            const value = typeof dest === "string" ? await pdfjs.getDestination(dest) : dest;
            const ref = value?.[0];
            const index = Number.isInteger(ref)
              ? ref
              : ref?.num != null
                ? await pdfjs.getPageIndex(
                    Components.utils.cloneInto({ num: ref.num, gen: ref.gen }, reader.session.overlay.pdfWin)
                  )
                : -1;
            if (sheets.has(index)) resolved = { page: sheets.get(index), value };
          } catch {
            /* A PDF can contain an unresolved named destination. */
          }
          destinations.set(key, resolved);
        }
        const target = destinations.get(key);
        if (!target) continue;
        const { page, value } = target,
          kind = value[1]?.name;
        const ref=originalSide?page.sourceRef:page.targetRef;
        const top=originalSide?page.sourceTop:page.top;
        let destination = [ref, name("Fit")];
        if (["XYZ", "FitH", "FitBH", "FitV", "FitBV"].includes(kind)) {
          const x = Number.isFinite(value[2]) && !["FitH", "FitBH"].includes(kind) ? value[2] : page.view[0];
          const height = ["FitH", "FitBH"].includes(kind) ? value[2] : kind === "XYZ" ? value[3] : null;
          const y = Number.isFinite(height) ? height : page.view[3];
          const [a, b, c, d, e, f] = page.transform;
          const left = originalSide ? page.left : page.x;
          const original={x:a*x+c*y+e,y:b*x+d*y+f};
          const point=originalSide?original:DeepRead.ParallelFlow.destination(page.anchors,dest,original.x,original.y);
          destination = [
            ref,
            name("XYZ"),
            left + Math.max(0, Math.min(page.width, point.x)),
            top - Math.max(0, Math.min(page.height, point.y)),
            kind === "XYZ" && value[4] > 0 ? value[4] : null
          ];
        } else if (
          kind === "FitR" &&
          Array.from(value).slice(2, 6).every(Number.isFinite) &&
          value.length >= 6
        ) {
          const r = DeepRead.ParallelInk.project(Array.from(value).slice(2, 6), page.transform);
          const left = originalSide ? page.left : page.x;
          destination = [
            ref,
            name("FitR"),
            left + r.left,
            top - r.top - r.height,
            left + r.left + r.width,
            top - r.top
          ];
        }
        annotation(sheet, rect, { Dest: destination });
      }
    }
    return { appendPair, finish };
  }

  async function append(output, reader, signal, facing = null) {
    const page = reader.page;
    const frame = element(reader.doc, "iframe");
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;left:-20000px;top:0;width:1000px;height:1200px;border:0;pointer-events:none";
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    frame.src = "about:blank";
    reader.doc.body.append(frame);
    const temp = PathUtils.join(PathUtils.tempDir, `deepread-page-${crypto.randomUUID()}.pdf`);
    try {
      await loaded;
      if (signal.aborted) return;
      await snapshot(reader, frame, signal);
      if (signal.aborted) return;
      const settings = Cc["@mozilla.org/gfx/printsettings-service;1"]
        .getService(Ci.nsIPrintSettingsService)
        .createNewPrintSettings();
      Object.assign(settings, {
        printerName: "Mozilla Save to PDF",
        paperSizeUnit: Ci.nsIPrintSettings.kPaperSizeInches,
        paperWidth: page.width / 72,
        paperHeight: page.height / 72,
        outputFormat: Ci.nsIPrintSettings.kOutputFormatPDF,
        outputDestination: Ci.nsIPrintSettings.kOutputDestinationFile,
        toFileName: temp,
        printSilent: true,
        printBGImages: true,
        printBGColors: true,
        marginTop: 0,
        marginLeft: 0,
        marginBottom: 0,
        marginRight: 0,
        headerStrLeft: "",
        headerStrCenter: "",
        headerStrRight: "",
        footerStrLeft: "",
        footerStrCenter: "",
        footerStrRight: "",
        shrinkToFit: false,
        scaling: 1
      });
      const context =
        frame.browsingContext ||
        frame.contentWindow.browsingContext ||
        frame.contentWindow.docShell?.browsingContext;
      await context.print(settings);
      if (signal.aborted) return;
      const printed = await library.PDFDocument.load(Uint8Array.from(await IOUtils.read(temp)));
      alignText(printed,baselineGrid(reader));
      restoreTextMapping(printed, reader.target.stage.textContent + reader.extra.textContent);
      const pages = await output.copyPages(printed, printed.getPageIndices());
      for (const result of pages) {
        // Cairo rounds the outer paper box to whole points. Keep the upper-left
        // anchor (including link coordinates) and trim only the outer rounding.
        const box = result.getMediaBox(),
          bottom = box.y + box.height - page.height;
        result.setMediaBox(box.x, bottom, page.width, page.height);
        result.setCropBox(box.x, bottom, page.width, page.height);
      }
      if (facing) await facing.appendPair(pages,page);
      else for (const result of pages) output.addPage(result);
    } finally {
      frame.remove();
      await IOUtils.remove(temp, { ignoreAbsent: true });
    }
  }
  DeepRead.ParallelPDF = { create, append, facingDocument, sourceSlices };
})();
