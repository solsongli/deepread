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
  const pendingReplies = [];
  D.Parser.parsePDF = async ({ pdfApp, attachmentKey }) => {
    parseCalls++; check('comparison uses selected parser with an isolated working key', D.prefs.parserConfig().provider === 'mineru' && pdfApp && attachmentKey.startsWith(s.key + '-comparison-'));
    return { contentList: source };
  };
  D.LLM.complete = async (args) => {
    const list = JSON.parse(args.messages[0].content.split('\n').slice(1).join('\n'));
    calls++;
    if (stall) await new Promise(resolve => pendingReplies.push(resolve));
    if (fail) return { content: JSON.stringify({ translations: [] }) };
    return { content: JSON.stringify({ translations: list.map((u) => ({ id: u.id, translation: translated(u.source_text) })) }) };
  };
  const rgb = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data].join(',');
  const sameRegion = (a,b,x,y,w,h) => {
    const A = a.getContext('2d').getImageData(x,y,w,h).data, B = b.getContext('2d').getImageData(x,y,w,h).data;
    return A.every((v,i) => v===B[i]);
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
      doc.fonts.check('400 12px "DeepRead Song"', '闭环') && doc.fonts.check('italic 12px "DeepRead Roman"', 'DDPM'));
    const lead = c.page.units.find(u => u.source.includes('Closed-loop actions'));
    const mixed = s.overlay._translationContent(lead,lead.translation,'zh').textContent;
    check('mixed prose has compact Chinese punctuation and thin script boundaries before wrapping',
      list[0].textContent.includes('动作。保留') && mixed.includes('核对\u2009DDPM\u2009预测'));
    check('long translation is complete and keyboard-scrollable', actions.some((box) => box.textContent.includes('完整的结尾') && box.scrollHeight > box.clientHeight && box.tabIndex === 0));
    const long=actions.find(box=>box.textContent.includes('完整的结尾'));
    const baselines=[...long.querySelectorAll('.dr-parallel-baseline')].map(probe=>probe.getBoundingClientRect().top);
    const steps=baselines.slice(1).map((y,i)=>y-baselines[i]);
    check('baselines remain evenly spaced throughout a long paragraph',steps.length>2 && Math.max(...steps)-Math.min(...steps)<.15);
    const hit=c.source.stage.querySelector('.dr-parallel-hit');
    hit.focus();
    check('focusing the original highlights its corresponding translation',hit.classList.contains('dr-paired') && actions[0].classList.contains('dr-paired'));
    const dims = () => [c.source.element.getBoundingClientRect(), c.target.element.getBoundingClientRect()];
    const [original, target] = dims();
    check('paired pages have equal dimensions at the same Y', Math.abs(original.width-target.width)<0.1 && Math.abs(original.height-target.height)<0.1 && Math.abs(original.y-target.y)<0.1);
    const scale = target.width / c.page.width;
    check('left-column text begins at the matching PDF coordinate', Math.abs((list[0].getBoundingClientRect().x-target.x)/scale - 44)<1);
    check('right column stays in the right column', actions.some((box) => box.textContent.includes('两组实验') && parseFloat(box.style.left) > 310));
    const k = c.source.canvas.width / 612;
    check('original graph rectangle and its interior labels are pixel-identical on the translated sheet', sameRegion(c.source.canvas,c.target.canvas,Math.round(44*k),Math.round((792-540)*k),Math.round(216*k),Math.round(158*k)));
    check('display equation is preserved pixel-for-pixel', sameRegion(c.source.canvas,c.target.canvas,Math.round(326*k),Math.round((792-456)*k),Math.round(92*k),Math.round(27*k)));
    check('only the caption is translated under the figure', actions.some((box) => box.textContent.includes('两次试验') && parseFloat(box.style.height)<20));
    const targetFile=PathUtils.join(E2E.env('DEEPREAD_E2E_SHOTS'),'translated-book.pdf');
    const beforeExport=calls;
    await IOUtils.writeUTF8(targetFile,'previous export');
    let incomplete=false;
    try { await c.savePDF('all',targetFile); } catch { incomplete=true; }
    check('untranslated pages leave the previous export and reading position intact',incomplete && (await IOUtils.readUTF8(targetFile))==='previous export' && c.pageIndex===0 && calls===beforeExport);
    c.changeZoom(0.25);
    check('zoom changes both sheets together', dims()[0].width > original.width && Math.abs(dims()[0].width-dims()[1].width)<0.1);
    const renderInto=c.page.renderInto;
    let correctFontDocument=false;
    c.page.renderInto=(canvas,density)=>{
      correctFontDocument=canvas.ownerDocument===s.overlay.pdfDoc;
      return renderInto(canvas,density);
    };
    c.changeZoom(2);
    await until(()=>c.page.targetDetail?.isConnected);
    const high=c.page.detailCanvas;
    check('zoom renders new PDF pixels on both sides without paying for another translation',
      high.width>c.source.canvas.width && high.width===c.page.targetDetail.width && calls===beforeExport);
    const sampleEquation=canvas=>{
      const crop=c.doc.createElementNS("http://www.w3.org/1999/xhtml","canvas");
      crop.width=92;crop.height=27;
      const scale=canvas.width/612, ctx=crop.getContext("2d");
      ctx.drawImage(canvas,325*scale,335*scale,92*scale,27*scale,0,0,92,27);
      return ctx.getImageData(0,0,92,27).data;
    };
    const lo=sampleEquation(c.source.canvas), hi=sampleEquation(high);
    let ink=0, error=0;
    for(let i=0;i<lo.length;i+=4){ink+=255-Math.min(hi[i],lo[i]);error+=Math.abs(hi[i]-lo[i]);}
    check('high-resolution mathematical ink uses the original embedded font document and preserves the glyph shapes',
      correctFontDocument && ink>0 && error/ink<.35);
    c.fit.click(); await sleep(80); await shot('parallel-layout.png');
    check('fit-to-width restores the original display layer',!high.isConnected);
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
    check('whole document resumes from the first missing page and reuses parsed geometry', calls===before+2 && parseCalls===1 && !c.book);
    check('translated text rotates with its source', [...c.target.stage.querySelectorAll('.dr-parallel-text')].some((b) => b.style.transform === 'rotate(90deg)'));
    await c.showPage(2);
    check('OCR-only text keeps its known physical rectangle', c.target.stage.textContent.includes('扫描页正文'));
    check('uncertain mixed figure/text is preserved and translation is provided below', c.extra.textContent.includes('与图像重叠') && !c.target.stage.textContent.includes('与图像重叠'));
    check('scan graphic keeps its original colour', rgb(c.source.canvas,220,660) === rgb(c.target.canvas,220,660));
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
    const narrow = c.scroll.parentNode; narrow.style.maxWidth='500px'; await until(()=>c.root.classList.contains('dr-single'));
    c.swap.click(); check('narrow display can switch back to the same original at the same scale', c.root.classList.contains('dr-show-source') && Math.abs(dims()[0].width-dims()[1].width)<0.1);
    const key=s.key, fingerprint=c.page.fingerprint;
    await s.clearResults(); check('clearing the paper closes the comparison and removes its page cache', !c.root && !(await D.Store.comparisonData(key,fingerprint,'page:0:zh')));
  }
  finally { if (c?.root) c.close(false); D.LLM.complete=originalLLM; D.Parser.parsePDF=originalParser; }
  await sleep(700);
  return { checks:E2E.result.steps.length, modelCalls:calls, parserCalls:parseCalls };
};
