/* Native PDF.js rendering, source-based fit, on-demand translation and upgrade coverage.
 * Generate the PDF with test/build-parallel-fixture.py. No external services.
 * License: AGPL-3.0-or-later */
E2E.run = async function () {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, ok) => { E2E.result.steps.push({ name, ok: !!ok }); if (!ok) throw new Error(name); };
  async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(30); } throw new Error('Timed out waiting for the comparison view'); }
  await until(() => Zotero.DeepRead?.Panes?.paneIDs?.chat);
  const D = Zotero.DeepRead, win = Zotero.getMainWindow(); win.resizeTo(1450, 980);
  D.prefs.set('parser.provider', 'mineru'); D.prefs.set('cards.autoExplain', false);
  D.prefs.set('view.guided', true); // A saved preference from an older XPI must not resurrect the feature.
  const item = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(E2E.env('DEEPREAD_E2E_PDF')), libraryID: Zotero.Libraries.userLibraryID });
  const reader = await Zotero.Reader.open(item.id); await reader._initPromise;
  const s = D.Session.forReader(reader); await s.init(); const doc = s.overlay.readerDoc;
  const button = doc.querySelector('.dr-parallel-button');
  const bbox = ([x, y, X, Y], view = [0, 0, 612, 792]) => [(x-view[0])/(view[2]-view[0])*1000, (view[3]-Y)/(view[3]-view[1])*1000, (X-view[0])/(view[2]-view[0])*1000, (view[3]-y)/(view[3]-view[1])*1000];
  const first = '• Closed-loop actions. Keep local feedback. Measure how it changes predictions.';
  const second = '• Visual inputs. Encode each view. Keep the image in its original position.';
  const control = 'A separate control tests the assumptions. The experiment compares two settings.';
  const foot = 'The estimate also depends on the', continued = 'sampling interval used in the experiment.';
  const source = [
    { id: 1, page_idx: 0, type: 'text', text_level: 1, text: 'Layout comparison', bbox: bbox([40,735,260,758]) },
    { id: 2, page_idx: 0, type: 'list', sub_type: 'text', list_items: [first, second], bbox: bbox([40,632,310,710]) },
    { id: 3, page_idx: 0, type: 'text', text: control, bbox: bbox([315,673,586,710]) },
    { id: 4, page_idx: 0, type: 'image', image_caption: ['Figure 1: Comparison across two trials.'], bbox: bbox([44,359,262,540]) },
    { id: 5, page_idx: 0, type: 'equation', text: 'x = a + b', bbox: bbox([325,431,417,456]) },
    { id: 6, page_idx: 0, type: 'text', text: foot, bbox: bbox([42,78,240,98]) },
    { id: 7, page_idx: 1, type: 'text', text: continued, bbox: bbox([48,540,320,561],[20,30,532,590]) },
    { id: 8, page_idx: 1, type: 'text', text: 'Errors are reported independently.', bbox: bbox([48,452,320,467],[20,30,532,590]) },
    { id: 9, page_idx: 2, type: 'text', text: 'OCR on a scanned page.', bbox: bbox([39,600,270,624]) },
    { id: 10, page_idx: 2, type: 'image', image_caption: [], bbox: bbox([42,350,242,520]) },
    { id: 11, page_idx: 2, type: 'text', text: 'OCR region intersecting the figure.', bbox: bbox([39,485,300,540]) },
  ];
  const originalLLM = D.LLM.complete, originalParser = D.Parser.parsePDF;
  const translated = (text) => {
    if (text.includes('Layout comparison')) return '版式对照';
    if (text.includes('Closed-loop')) return '**闭环动作。** 保留*局部反馈*，核对DDPM预测。';
    if (text.includes('Visual inputs')) return '**视觉输入。** 编码不同视角，让图像留在原处。';
    if (text.includes('separate control')) return '两组实验在相同条件下比较。'.repeat(24) + 'Diffusion Policy 2020——完整的结尾。';
    if (text.includes('Figure')) return '图 ⟦D0⟧：两次试验的比较。';
    if (text.includes('depends')) return '估计还取决于';
    if (text.includes('sampling interval')) return '实验所用的采样间隔。';
    if (text.includes('Errors')) return '分别报告误差。';
    return text.includes('intersecting') ? '与图像重叠的译文。' : '扫描页正文。';
  };
  let calls = 0, parseCalls = 0, fail = false, stall = false;
  const replyModes = new Set();
  const pendingReplies = [];
  D.Parser.parsePDF = async ({ pdfApp, attachmentKey, filePath }) => {
    parseCalls++;
    const geom = await pdfApp.pdfDocument.getPage(1);
    const data = await pdfApp.pdfDocument.getPageData({pageIndex:0});
    const index = geom.rotate === 90 ? 1 : data.chars.length ? 0 : 2;
    check('parser receives one selected PDF page in an isolated file (page '+(index+1)+')',
      D.prefs.parserConfig().provider === 'mineru' && pdfApp.pdfDocument.numPages===1 &&
      attachmentKey.startsWith(s.key+'-range-') && filePath !== await item.getFilePathAsync());
    return {contentList:source.filter(it=>it.page_idx===index).map(it=>({...it,page_idx:0}))};
  };
  D.LLM.complete = async (args) => {
    const list = JSON.parse(args.messages[0].content.split('\n').slice(1).join('\n'));
    calls++;
    if (stall) await new Promise(resolve => pendingReplies.push(resolve));
    if (fail) return { content: JSON.stringify({ translations: [] }) };
    const output = JSON.stringify({ translations: list.map(u => ({ id: u.id, translation: translated(u.source_text) })) });
    const submit = args.toolChoice?.function?.name;
    if (calls % 2 && submit === "submit_pdf_translation") {
      replyModes.add("tool");
      return { raw: { choices: [{ message: { tool_calls: [
        { type: "function", function: { name: submit, arguments: output } }
      ] } }] } };
    }
    replyModes.add("json");
    return { content: output };
  };
  const transparent=(canvas,x,y,w,h)=>{
    const pixels=canvas.getContext("2d").getImageData(x,y,w,h).data;
    return pixels.every((v,i)=>i%4!==3 || v===0);
  };
  const shot = async (name) => {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, 'white');
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml','canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap,0,0);
    await IOUtils.write(PathUtils.join(E2E.env('DEEPREAD_E2E_SHOTS'), name), Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (c) => c.charCodeAt(0)));
  };
  let c;
  try {
    check('guide module, button and agent runner are removed on upgrade', !D.GuidePanel && !D.AgentRunner && !s.runGuide && !D.Modules.get('guided') && !doc.querySelector('.dr-guide-button'));
    check('normal toolbar entry is available before deep reading', !!button && !s.hasResults && !button.disabled);
    button.click(); await until(() => s.comparison?.page?.units); c = s.comparison;
    check('opening a paper does not start paid work', calls === 0 && parseCalls === 0 && !c.translateButton.hidden);
    c.translateButton.click(); await until(() => c.page?.units?.every((u) => u.translation)); await until(() => !c.page.busy);
    check('normal page action translates without summaries or paragraph cards', parseCalls === 1 && calls > 0 && !s.hasResults && !s.explaining.size);
    const actions = [...c.target.stage.querySelectorAll('.dr-parallel-text')];
    const list = actions.filter((box) => box.textContent.startsWith('•'));
    check('two list items occupy distinct original frames', list.length === 2 && parseFloat(list[1].style.top) > parseFloat(list[0].style.top) + 25);
    check('renderer preserves strong and italic runs in engine lines', !!list[0].querySelector('.dr-parallel-line strong') && !!list[0].querySelector('.dr-parallel-line em'));
    check('translation uses the local Chinese and Western print faces', list[0].lang==='zh-CN' &&
      c.surface.doc.fonts.check('400 12px "DeepRead Song"', '闭环') && c.surface.doc.fonts.check('italic 12px "DeepRead Roman"', 'DDPM'));
    const lead = c.page.units.find(u => u.source.includes('Closed-loop actions'));
    const mixed = s.overlay._translationContent(lead,lead.translation,'zh').textContent;
    check('mixed prose has compact Chinese punctuation and thin script boundaries before wrapping',
      list[0].textContent.includes('动作。保留') && mixed.includes('核对\u2009DDPM\u2009预测'));
    c.surface.more.click();
    check('a long passage has a keyboard-accessible complete translation outside the page scrolling area',
      c.passageDialog.open && c.passageDialog.textContent.includes('完整的结尾') && c.surface.doc.defaultView.getComputedStyle(actions.find(b=>b.dataset.overflow)).overflowY==="hidden");
    c.passageDialog.close();
    const long=actions.find(box=>box.textContent.includes('完整的结尾'));
    const baselines=[...long.querySelectorAll('.dr-parallel-baseline')].map(probe=>probe.getBoundingClientRect().top);
    const steps=baselines.slice(1).map((y,i)=>y-baselines[i]);
    check('baselines remain evenly spaced throughout a long paragraph',steps.length>2 && Math.max(...steps)-Math.min(...steps)<.15);
    const native=c.native, left=native.left.pdfViewer, right=native.right.pdfViewer;
    check("normal comparison uses Zotero’s native split with two continuous PDF viewers",
      doc.body.classList.contains("enable-vertical-split-view") && left.scrollMode===0 && right.scrollMode===0 &&
      !doc.querySelector(".dr-parallel-next,dialog.deepread-parallel") && !doc.querySelector("dialog[open]"));
    const pair=actions[0];pair.dispatchEvent(new c.surface.doc.defaultView.PointerEvent("pointermove",{bubbles:true}));
    const relative=(o,div=o.parentNode)=>{
      const b=o.getBoundingClientRect(),p=div.getBoundingClientRect();
      return [(b.left-p.left-div.clientLeft)/div.clientWidth*c.page.width,(b.top-p.top-div.clientTop)/div.clientHeight*c.page.height,
        b.width/div.clientWidth*c.page.width,b.height/div.clientHeight*c.page.height];
    };
    const sourceRect=pair.dataset.sourceRect.split(" ").map(Number);
    const rightPage=right.getPageView(0).div;
    const paintRect=relative(pair,rightPage);
    check("hover outlines use the physical source and rendered translation positions without blocking selection",
      native.marked===pair && native.outlines?.length===2 && native.outlines.every(o=>o.isConnected &&
        o.style.pointerEvents==="none") && native.outlines.every((o,j)=>
          relative(o).every((v,i)=>Math.abs(v-[sourceRect,paintRect][j][i])<.1)));
    const part=pair.cloneNode(false);
    Object.assign(part.style,{left:"12px",top:"31px",width:"36px",height:"10px"});
    part.dataset.paintRects="[[12,31,36,10]]";
    pair.parentNode.append(part);
    const rr=rightPage.getBoundingClientRect();
    part.dispatchEvent(new c.surface.doc.defaultView.MouseEvent("click",{bubbles:true,
      clientX:rr.left+rightPage.clientLeft+26/c.page.width*rightPage.clientWidth,
      clientY:rr.top+rightPage.clientTop+35/c.page.height*rightPage.clientHeight}));
    check("clicking a continuation outlines its source once and both translated fragments",
      native.marked===part && native.outlines?.length===3 &&
      relative(native.outlines[0]).every((v,i)=>Math.abs(v-sourceRect[i])<.1) &&
      relative(native.outlines[2]).every((v,i)=>Math.abs(v-[12,31,36,10][i])<.1));
    part.remove();
    native.clearHighlight();
    const dims=()=>[left.getPageView(0).div,right.getPageView(0).div].map(el=>el.getBoundingClientRect());
    const [original,target]=dims();
    check("native split pages have equal width and aligned vertical positions",
      Math.abs(original.width-target.width)<1.1 && Math.abs(original.height-target.height)<1.1 && Math.abs(original.top-target.top)<2);
    const paperStyle=c.page.styleProfile.roles;
    const body=actions.find(el=>el.dataset.typeRole==="body");
    const originalBodySize=body.style.fontSize, originalBodyStep=body.style.lineHeight;
    const cap=actions.find(el=>el.dataset.typeRole==="figureCaption");
    check("body and caption use their document sizes even with different source frames",
      !!body && !!cap && parseFloat(body.style.fontSize)===paperStyle.body.size &&
      parseFloat(cap.style.fontSize)===paperStyle.figureCaption.size && parseFloat(body.style.lineHeight)===paperStyle.body.step);
    const baseProbes=list.map(el=>[...el.querySelectorAll(".dr-parallel-baseline")].map(p=>p.getBoxQuads({relativeTo:c.target.stage})[0].p1.y));
    const listUnits=c.page.units.filter(u=>u.marker==="•");
    check("the first baseline of each translated list item stays on its own original line", listUnits.length===2 &&
      listUnits.every((u,i)=>Math.abs(baseProbes[i][0]-(c.page.transform[3]*u.sourceBaseline+c.page.transform[5]))<.1));
    const origin=c.target.stage.getBoundingClientRect(), scale=origin.width/c.page.width;
    check('left-column text begins at the matching PDF coordinate', Math.abs((list[0].getBoundingClientRect().x-origin.x)/scale - 44)<1);
    check('right column stays in the right column', actions.some((box) => box.textContent.includes('两组实验') && parseFloat(box.style.left) > 310));
    const typesetDoc=c.surface.doc,stage=c.target.stage;
    {
      const rect = [0, 0, 4, 2], samples = [rect];
      const pixels = {width: 4, height: 2, data: Uint8ClampedArray.from(Array(8).fill([191, 0, 64, 255]).flat())};
      const page = {width: 4, height: 2, transform: [1, 0, 0, 1, 0, 0], links: [{rect}], language: "zh"};
      const entry = typesetDoc.createDocumentFragment();
      entry.append("世界重建 WorldMirror ⟦D0⟧");
      const unit = {linkSamples: samples, typeRole: "contents", tokens: [{id: "⟦D0⟧", kind: "number", display: "2.0", samples}]};
      D.ParallelInk.materialize(typesetDoc, entry, unit, page, null, pixels);
      const link = entry.firstChild;
      check("contents words and their embedded version number share the source link and ink",
        entry.childNodes.length === 1 && link.localName === "a" && link.dataset.sourceLink === "0" &&
        !link.querySelector("a") && link.textContent.includes("世界重建") && link.textContent.endsWith("2.0") &&
        link.style.color === "rgb(191, 0, 64)");
    }
    {
      const brand = "https://example.org/device", vendor = "https://example.org/vendor";
      const chars = ["Haption","Virtuose","Haption","OXO","Unsafe"].map((u,i) => ({
        u, rect:[0,i*3,8,i*3+2], lineBreakAfter:true
      }));
      const page = {width:8,height:15,transform:[1,0,0,1,0,0],chars,language:"zh",
        links:[{rect:chars[0].rect,url:brand},{rect:chars[1].rect,url:brand},
          {rect:chars[3].rect,url:vendor},{rect:chars[4].rect,url:"javascript:void(0)"}]};
      const pixels = {width:8,height:15,data:Uint8ClampedArray.from(Array(8*15).fill([255,0,0,255]).flat())};
      const unit = {source:"Haption Virtuose. Haption, OXO and Unsafe.",rect:[0,0,8,15],rects:chars.map(c=>c.rect)};
      const entry = typesetDoc.createDocumentFragment();
      entry.append("Haption Virtuose；随后 Haption，使用 OXO 和 Unsafe。");
      D.ParallelInk.materialize(typesetDoc,entry,unit,page,null,pixels);
      const anchors = [...entry.querySelectorAll("a[data-source-link]")];
      check("only unambiguous retained words inside external PDF link rectangles are clickable",
        anchors.length===2 && anchors[0].textContent==="Haption Virtuose" && anchors[1].textContent==="OXO" &&
        anchors.every(a=>a.style.color==="rgb(255, 0, 0)") &&
        page.links[Number(anchors[0].dataset.sourceLink)].url===brand &&
        page.links[Number(anchors[1].dataset.sourceLink)].url===vendor &&
        entry.textContent==="Haption Virtuose；随后 Haption，使用 OXO 和 Unsafe。");
      const unresolved = typesetDoc.createDocumentFragment();
      unresolved.append("Haption 和 Haption");
      D.ParallelInk.materialize(typesetDoc,unresolved,unit,page,null,pixels);
      check("ambiguous repeated names are left alone", !unresolved.querySelector("a"));
    }
    {
      const rects = [[0,0,8,2],[0,9,8,11],[12,0,18,2],[12,9,20,11]];
      const chars = ["Wang et al.","Wang et al.","(2023)","Wang et al."].map((u,i)=>({u,rect:rects[i],lineBreakAfter:true}));
      const page = {width:20,height:12,transform:[1,0,0,1,0,0],chars,links:[
        {rect:rects[0],dest:"cite.wang2022"},{rect:rects[1],dest:"cite.wang2023"},{rect:rects[2],dest:"cite.wang2023"}
      ]};
      const pixels = {width:20,height:12,data:Uint8ClampedArray.from(Array(240).fill([255,0,0,255]).flat())};
      for (const [i,expected] of [[0,"0"],[1,"1"],[3,null]]) {
        const frag=typesetDoc.createDocumentFragment();frag.append("参见 Wang et al.");
        D.ParallelInk.materialize(typesetDoc,frag,{source:"See Wang et al.",rect:rects[i]},page,null,pixels);
        const a=frag.querySelector("a");
        check("a retained author uses its own physical reference at row "+i,
          (a?.dataset.sourceLink ?? null)===expected && (!a || a.textContent==="Wang et al."));
      }
    }
    function sampleMargins(justified){
      const box=typesetDoc.createElementNS("http://www.w3.org/1999/xhtml","div");
      box.className="dr-parallel-text";box.style.cssText="left:0;top:0;width:149px;height:240px;visibility:hidden";
      D.PaperType.apply(box,"zh");stage.append(box);
      try{
        const sample=typesetDoc.createDocumentFragment();
        sample.append("中文段落对齐时保留");
        const link=typesetDoc.createElementNS("http://www.w3.org/1999/xhtml","a");link.dataset.sourceLink="0";link.textContent="GridNet";sample.append(link);
        sample.append("的引用和原文字重。可见的行尾使用同一栏宽，各个段落依然从自己的位置起排。最后一行自然收尾。");
        const unit={source:"A printed passage.",matched:true,justified,columnRight:149,
          direction:[1,0],rect:[0,0,149,90],rects:[[0,80,149,90],[0,68,149,78],[0,56,78,66]],size:10,typeRole:"body"};
        D.ParallelTypeset.draw(box,unit,sample,10,paperStyle.body);
        const base=box.getBoundingClientRect(), scale=base.width/149;
        const edges=Array.from(box.querySelectorAll(".dr-parallel-grid-line"),row=>{
          const walker=typesetDoc.createTreeWalker(row,4), leaves=[],range=typesetDoc.createRange();
          while(walker.nextNode()){if(!walker.currentNode.data.trim())continue;range.selectNodeContents(walker.currentNode);leaves.push(range.getBoundingClientRect());}
          return [(Math.min(...leaves.map(r=>r.left))-base.left)/scale,(base.right-Math.max(...leaves.map(r=>r.right)))/scale];
        });
        return {edges,link:box.querySelector("a")?.textContent};
      }finally{box.remove();}
    }
    for (const [source,translation,width,height,em] of [
      ["base","基础版",22.4,10.8,10], ["Succ%","成功率%",26,9.75,9],
      ["Our Pcd. (~1.7min)","我们的点云（约 1.7 分钟）",59.4,7.1,6.46]
    ]) {
      const box=typesetDoc.createElementNS("http://www.w3.org/1999/xhtml","div");
      box.className="dr-parallel-text";
      box.style.cssText="left:0;top:0;visibility:hidden;width:"+width+"px;height:"+height+"px";
      D.PaperType.apply(box,"zh");stage.append(box);
      const frag=typesetDoc.createDocumentFragment();frag.append(translation);
      D.ParallelTypeset.draw(box,{source,translation,size:em,verifiedLabel:true,direction:[1,0],
        rects:[[0,0,width,height]]},frag,em);
      check("short scientific label stays inside its cell: "+source,
        !box.dataset.overflow && box.querySelectorAll(".dr-parallel-line").length===1 &&
        (source.includes("min") ? /1\.7\s*min/u.test(box.textContent) : box.textContent===translation));
      box.remove();
    }
    const flush=sampleMargins(true),ragged=sampleMargins(false);
    check("real Chinese glyph runs reach both margins of source-justified lines, with a natural final line",
      flush.edges.length>=3 && flush.edges.slice(0,-1).every(([l,r])=>Math.abs(l)<.15 && Math.abs(r)<.15) &&
      flush.edges.at(-1)[1]>1 && flush.link==="GridNet");
    check("a ragged source keeps natural line endings",ragged.edges.slice(0,-1).some(([,end])=>end>1));
    const shortText="考虑预测的不确定性，我们先验证模型的假设，再分析实验产生的误差。";
    for(const typeRole of ["body","figureCaption","heading"]){
      const box=typesetDoc.createElementNS("http://www.w3.org/1999/xhtml","div");
      box.className="dr-parallel-text";box.style.cssText="left:0;top:0;width:480px;height:70px;visibility:hidden";
      D.PaperType.apply(box,"zh");stage.append(box);
      const sample=typesetDoc.createDocumentFragment();sample.append(shortText);
      const type=paperStyle[typeRole], step=type.step;
      const unit={source:"Source on three lines",matched:true,size:type.size,typeRole,direction:[1,0],
        rect:[0,0,480,2*step+type.size],rects:[[0,2*step,480,2*step+type.size],[0,step,480,step+type.size],[0,0,340,type.size]]};
      D.ParallelTypeset.draw(box,unit,sample,type.size,type);
      const rows=Array.from(box.querySelectorAll(".dr-parallel-grid-line"));
      check(typeRole+" keeps a short translation on one natural line at the document font size",
        rows.length===1 && rows[0].textContent===shortText && parseFloat(box.style.fontSize)===type.size);
      box.remove();
    }
    {
      const caption = "图二展示了输入表示以及词元嵌入、片段嵌入和位置嵌入的对应关系。";
      const style = paperStyle.figureCaption;
      const width = caption.length * style.size * 1.1;
      const box = typesetDoc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      box.className = "dr-parallel-text";
      box.style.cssText = `left:0;top:0;width:${width}px;height:70px;visibility:hidden`;
      D.PaperType.apply(box, "zh");
      stage.append(box);
      const fragment = typesetDoc.createDocumentFragment();
      fragment.append(caption);
      D.ParallelTypeset.draw(box, { size: style.size, caption: true, direction: [1, 0],
        rect: [0, 0, width, 2 * style.step], rects: [[0, style.step, width, 2 * style.step], [0, 0, width, style.step]]
      }, fragment, style.size, style);
      check("a caption filling the source width stays on one natural line",
        box.querySelectorAll(".dr-parallel-grid-line").length === 1 && box.textContent === caption);
      box.remove();
    }
    {
      const box = typesetDoc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      box.className = "dr-parallel-text";
      box.style.cssText = "left:0;top:0;width:300px;height:80px;visibility:hidden";
      D.PaperType.apply(box, "zh");
      stage.append(box);
      const fragment = typesetDoc.createDocumentFragment();
      const number = typesetDoc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      number.dataset.referenceStart = "true";
      number.textContent = "[2]";
      fragment.append("[1] 第一篇参考文献。 ", number, " 第二篇参考文献。");
      const ref = paperStyle.reference;
      D.ParallelTypeset.draw(box, { source: "References", size: ref.size, direction: [1, 0], rects: [[0, 0, 300, 35]] },
        fragment, ref.size, ref);
      const rows = Array.from(box.querySelectorAll(".dr-parallel-grid-line"), r => r.textContent);
      check("numbered references keep their own line even in a merged parser block",
        rows.length === 2 && rows[0].startsWith("[1]") && rows[1].startsWith("[2]"));
      box.remove();
    }
    {
      const complete = D.LLM.complete, stream = D.LLM.stream, paint = c.paint;
      const exchange = [];
      let repainted = 0;
      try {
        c.paint = function () { repainted++; return paint.call(this); };
        D.LLM.complete = async (opts) => {
          exchange.push(opts);
          return { raw: { choices: [{ message: { content: null, tool_calls: [
            { id: "font", type: "function", function: { name: "pdf_fonts", arguments: '{"role":"body"}' } },
            { id: "layout", type: "function", function: { name: "pdf_layout", arguments: '{"mode":"apply"}' } }
          ] } }] } };
        };
        D.LLM.stream = async (opts) => {
          exchange.push(opts);
          opts.onDelta("已重排。", "已重排。");
        };
        await D.ChatPane.send(s, "对照译文用了什么字体？请重排当前译页。");
        const results = (exchange[1]?.messages || []).filter(m => m.role === "tool");
        const fonts = JSON.parse(results[0]?.content || "{}");
        const layout = JSON.parse(results[1]?.content || "{}");
        if (s.chat.error) throw new Error(s.chat.error);
        check("paper chat sends the question and two local tools without full paper text",
          exchange.length === 2 && exchange[0].tools?.length === 2 && exchange[0].messages.length === 1 &&
          !exchange[0].system.includes("# Paper full text"));
        check("font tool returns the font currently used for body text", fonts.styles?.body?.pt === paperStyle.body.size);
        check("layout tool repaints only the active translated page and the answer is shown",
          layout.page === 1 && layout.applied && repainted > 0 && s.chat.messages.at(-1).content === "已重排。");
      } finally {
        D.LLM.complete = complete;
        D.LLM.stream = stream;
        c.paint = paint;
      }
      check("a paper question about a layout model keeps normal reading context",
        !D.PaperTools.select("论文如何训练 layout 模型？", true).length);
    }
    {
      const complete = D.LLM.complete, stream = D.LLM.stream;
      const flagged = c.page.units.find(u => u.tokens?.length);
      const missing = c.page.units.find(u => u !== flagged);
      const old = [flagged.translation, missing.translation];
      let audit;
      try {
        flagged.translation = "译文中的公式已丢失。";
        missing.translation = "";
        D.LLM.complete = async opts => {
          check("translation check is discoverable as a read-only tool in the chat",
            opts.tools.length === 1 && opts.tools[0].function.name === "pdf_check_translation");
          return { raw: { choices: [{ message: { tool_calls: [
            { id: "check", type: "function", function: { name: "pdf_check_translation", arguments: "{}" } }
          ] } }] } };
        };
        D.LLM.stream = async opts => {
          audit = JSON.parse(opts.messages.at(-1).content);
          opts.onDelta("检查完成。", "检查完成。");
        };
        await D.ChatPane.send(s, "检查当前页译文有没有漏译。");
        check("translation audit uses the local pending and placeholder checks",
          audit?.page === 1 && audit.pending === 1 && audit.flagged === 1 &&
          audit.issues.some(row => row.code === "placeholders") &&
          audit.issues.some(row => row.code === "missing") &&
          flagged.translation === "译文中的公式已丢失。" && missing.translation === "");
      } finally {
        [flagged.translation, missing.translation] = old;
        D.LLM.complete = complete;
        D.LLM.stream = stream;
      }
    }
    check("bundled serif and sans-serif typefaces are loaded for translation and export",
      typesetDoc.fonts.check('400 12px "DeepRead Song"',"论文") &&
      typesetDoc.fonts.check('700 12px "DeepRead Hei"',"论文"));
    const k = c.source.canvas.width / 612;
    check('original graph rectangle and its interior labels are pixel-identical on the translated sheet', transparent(c.target.canvas,Math.round(44*k),Math.round((792-540)*k),Math.round(216*k),Math.round(158*k)));
    check('display equation is preserved pixel-for-pixel', transparent(c.target.canvas,Math.round(326*k),Math.round((792-456)*k),Math.round(92*k),Math.round(27*k)));
    check('only the caption is translated under the figure', actions.some((box) => box.textContent.includes('两次试验') && parseFloat(box.style.height)<20));
    const targetFile=PathUtils.join(E2E.env('DEEPREAD_E2E_SHOTS'),'translated-book.pdf');
    const beforeExport=calls;
    await IOUtils.writeUTF8(targetFile,'previous export');
    let incomplete=false;
    try { await c.savePDF('all',targetFile); } catch { incomplete=true; }
    check('untranslated pages leave the previous export and reading position intact',incomplete && (await IOUtils.readUTF8(targetFile))==='previous export' && c.pageIndex===0 && calls===beforeExport);
    const initialScale=left.currentScale;
    left.currentScale=initialScale+.25;
    await until(()=>Math.abs(left.currentScale-right.currentScale)<.001);
    check('zoom changes both sheets together', dims()[0].width > original.width && Math.abs(dims()[0].width-dims()[1].width)<0.1);
    left.currentScale=3;
    const nativeCanvas=v=>v.getPageView(0).div.querySelector(".canvasWrapper canvas");
    const detailTile=v=>v.getPageView(0).div.querySelector(".canvasWrapper canvas:nth-of-type(2)");
    await until(()=>detailTile(left)?.width>0 && detailTile(right)?.width>0);
    const originalHi=nativeCanvas(left), translatedHi=nativeCanvas(right);
    check('native zoom redraws original artwork in both PDF views without another translation',
      calls===beforeExport && Math.abs(left.currentScale-3)<.001 && Math.abs(right.currentScale-3)<.001 && originalHi.width===translatedHi.width && detailTile(left).width>originalHi.width);
    const equation=canvas=>{
      const crop=c.doc.createElementNS("http://www.w3.org/1999/xhtml","canvas");
      crop.width=92;crop.height=27;
      const scale=canvas.width/612, ctx=crop.getContext("2d");
      ctx.drawImage(canvas,325*scale,335*scale,92*scale,27*scale,0,0,92,27);
      return ctx.getImageData(0,0,92,27).data;
    };
    const firstEq=equation(originalHi),secondEq=equation(translatedHi);
    let ink=0,error=0;
    for(let i=0;i<firstEq.length;i+=4){ink+=255-Math.min(firstEq[i],secondEq[i]);error+=Math.abs(firstEq[i]-secondEq[i]);}
    check('both native PDF documents render the same mathematical glyphs at high zoom',ink>0 && error/ink<.03);
    left.currentScaleValue="page-width";await until(()=>Math.abs(left.currentScale-right.currentScale)<.001);
    await shot('parallel-layout.png');
    const initialCalls = calls;
    c.close(false); button.click(); await until(() => s.comparison.root && s.comparison.page?.units);
    check('finished page reloads completely from SQLite', calls === initialCalls && c.translateButton.hidden && c.page.units.every((u) => u.translation));
    await c.showPage(1);
    check('rotation and crop box come from the original PDF', c.page.width === 560 && c.page.height === 512 && c.page.view[0]===20);
    fail = true; await c.translatePage(); fail = false;
    check('a reply with no valid IDs leaves the page retryable and uncached', !c.translateButton.hidden && !(await D.Store.comparisonData(s.key,c.page.fingerprint,'page:1:zh')));
    stall = true; const canceled = c.translateBook(); await until(() => pendingReplies.length); c.bookButton.click(); pendingReplies.splice(0).forEach(resolve => resolve()); await canceled; stall = false;
    check('stopping a book run discards a late reply', !c.book && !(await D.Store.comparisonData(s.key,c.page.fingerprint,'page:1:zh')));
    const before = calls; await c.translateBook();
    check('whole document resumes from the first missing page and reuses parsed geometry', calls===before+2 && parseCalls===3 && !c.book);
    check("the same PDF translation path accepts a terminal tool reply and compatible JSON",
      replyModes.has("tool") && replyModes.has("json"));
    const rotated=c.target.stage.querySelector('[data-type-role="body"]');
    check("navigating to a rotated page keeps the same physical body size and line spacing",
      rotated && rotated.style.fontSize===originalBodySize && rotated.style.lineHeight===originalBodyStep);
    check('translated text rotates with its source', [...c.target.stage.querySelectorAll('.dr-parallel-text')].some((b) => b.style.transform === 'rotate(90deg)'));
    await c.showPage(2);
    check('OCR-only text keeps its known physical rectangle', c.target.stage.textContent.includes('扫描页正文'));
    check('uncertain mixed figure/text is preserved and translation is provided below', c.extra.textContent.includes('与图像重叠') && !c.target.stage.textContent.includes('与图像重叠'));
    check('scan graphic keeps its original colour', transparent(c.target.canvas,220,660,1,1));
    const inline=c.doc.createDocumentFragment();
    const math=()=>{const el=c.doc.createElementNS("http://www.w3.org/1999/xhtml","span");el.setAttribute("role","math");el.textContent="x";return el;};
    inline.append("比较",math()," 时，",math(),"。使用  MPC 方法。");
    D.PaperType.spaceChinese(inline);D.PaperType.spaceChinese(inline);
    check('Chinese, Latin and inline math keep one thin space while punctuation stays attached',
      inline.textContent==="比较\u2009x\u2009时，x。使用\u2009MPC\u2009方法。");
    const beforeBookSave=calls;
    check('both page and full bilingual exports are available in the reader', [...c.exportControl.options].some(o=>o.value==='dual-page') && [...c.exportControl.options].some(o=>o.value==='dual-all'));
    const bilingualFile=PathUtils.join(E2E.env('DEEPREAD_E2E_SHOTS'),'bilingual-book.pdf');
    check('bilingual export restores the page and uses only the existing translations',
      await c.savePDF('dual-all',bilingualFile) && c.pageIndex===2 && calls===beforeBookSave);
    const copy=await Zotero.Attachments.importFromFile({file:Zotero.File.pathToFile(bilingualFile),libraryID:Zotero.Libraries.userLibraryID});
    const bilingualText=(await Zotero.PDFWorker.getFullText(copy.id)).text.replace(/\s+/g,'');
    check('both sides of the bilingual PDF have selectable text',bilingualText.includes('Layoutcomparison') && bilingualText.includes('版式对照') && bilingualText.includes('samplinginterval'));
    const pdfScope={setTimeout,clearTimeout,Uint8Array,ArrayBuffer};
    Services.scriptloader.loadSubScript("chrome://deepread/content/lib/pdf-lib/pdf-lib.min.js",pdfScope);
    const {PDFDocument,PDFName,PDFArray}=pdfScope.PDFLib;
    const dual=await PDFDocument.load(Uint8Array.from(await IOUtils.read(bilingualFile)));
    const sheets=dual.getPages(), spreads=sheets.filter(p=>p.getWidth()>1000);
    check('both columns use the visible crop and rotation; supplements follow their source spread',
      spreads.length===3 && spreads[0]===sheets[0] && sheets[1].getWidth()===612 &&
      spreads[1]===sheets[2] && spreads[1].getWidth()===1120 && spreads[1].getHeight()===512);
    const links=spreads[0].node.Annots().asArray().map(ref=>dual.context.lookup(ref));
    const dest=links.map(link=>link.lookup(PDFName.of('Dest'))).find(d=>d instanceof PDFArray &&
      d.get(0).toString()===spreads[1].ref.toString() && d.get(2).asNumber()<0);
    check('source links jump to the original section in the rotated left column, past the supplement',
      dest && Math.abs(dest.get(2).asNumber()+41)<.01 && Math.abs(dest.get(3).asNumber()-482)<.01);
    for (const layout of ["parallel","alternating"]) {
      const path=PathUtils.join(E2E.env("DEEPREAD_E2E_SHOTS"),layout+"-translation-first.pdf");
      await c.savePDF("selection",path,{indices:[0,1],layout,translationFirst:true});
      const output=await PDFDocument.load(Uint8Array.from(await IOUtils.read(path))), pages=output.getPages();
      const sourceSheet=layout==="alternating"?pages[2]:pages[0], destination=layout==="alternating"?pages[4]:pages[2];
      const annots=sourceSheet.node.Annots().asArray().map(ref=>output.context.lookup(ref));
      const link=annots.find(a=>{
        const d=a.lookup(PDFName.of("Dest"));
        return d instanceof PDFArray && d.get(0).toString()===destination.ref.toString() &&
          Math.abs(d.get(2).asNumber()-(layout==="alternating"?519:1079))<.01;
      });
      check("translation-first "+layout+" preserves a rotated XYZ link past supplements",
        !!link && Math.abs(link.lookup(PDFName.of("Dest")).get(3).asNumber()-482)<.01);
      check("translation-first "+layout+" puts the complete overflow passage after the translation",
        pages.length===(layout==="alternating"?5:3) && pages[1].getWidth()===612 &&
        destination.getWidth()===(layout==="alternating"?560:1120));
    }
    const written=await c.savePDF('all',targetFile);
    const bytes=await IOUtils.read(targetFile);
    check('whole-document export writes a PDF, reuses translations and restores the current page',written && bytes[0]===37 && bytes[1]===80 && bytes.length>5000 && c.pageIndex===2 && calls===beforeBookSave);
    const exportedItem=await Zotero.Attachments.importFromFile({file:Zotero.File.pathToFile(targetFile), libraryID:Zotero.Libraries.userLibraryID});
    const printed=(await Zotero.PDFWorker.getFullText(exportedItem.id)).text.replace(/\s+/gu,'');
    check('export retains searchable Latin letters, digits, Chinese and paired em dashes',
      printed.includes('DDPM') && printed.includes('DiffusionPolicy2020——完整的结尾'));
    c.close(false);
    s.data = { language:'zh', contentList:source, hierarchicalData:[{ pageIndex:0, paragraphs:[{ paragraphIndex:1, minerUid:2, paragraphType:'list', paragraphText:first+' '+second, bbox:source[1].bbox,
      translationLayout:{ units:[{id:'u0',kind:'list-item',marker:'•',sourceText:first,translation:'**缓存的闭环动作。** 保留*局部反馈*。'},{id:'u1',kind:'list-item',marker:'•',sourceText:second,translation:'**缓存的视觉条件。** 单独编码观测。'}] }, points:[] }] }] };
    c.parsed = null; await c.open(button); await c.showPage(0);
    check('older MinerU deep-read units with no unit coordinates are placed using PDF glyphs', c.target.stage.textContent.includes('缓存的闭环动作') && c.target.stage.textContent.includes('缓存的视觉条件'));
    const doc2=c.native.right.pdfViewer;
    check("the original and translated panes remain real PDF pages after reopening",c.target.stage.closest(".page")===Components.utils.unwaiveXrays(doc2.getPageView(0).div));
    const key=s.key, fingerprint=c.page.fingerprint;
    await s.clearResults(); check('clearing the paper closes the comparison and removes its page cache', !c.root && !(await D.Store.comparisonData(key,fingerprint,'page:0:zh')));
  }
  finally { if (c?.root) c.close(false); D.LLM.complete=originalLLM; D.Parser.parsePDF=originalParser; }
  await sleep(700);
  return { checks:E2E.result.steps.length, modelCalls:calls, parserCalls:parseCalls };
};
