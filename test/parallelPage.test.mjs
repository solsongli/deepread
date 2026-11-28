// Source frame ownership, protected graphics and reuse of physical translations.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const scope = vm.createContext({ DeepRead: { bilingual: (zh) => zh } });
const load = (file) => vm.runInContext(readFileSync(new URL('../addon/content/' + file, import.meta.url), 'utf8'), scope);
load('lib/retainpdf/rendering/rects.js');
for (const name of ['services/typography','services/translationLayout','services/continuations','reader/overlay','services/parallelInline','services/parallelVisual','services/parallelFrames','services/parallelPage']) load('scripts/' + name + '.js');
const D = scope.DeepRead;
D.ParallelTypeset = { engine: () => scope.RetainPdfRendering };
const view = [20, 30, 220, 230];
const frame = { id: 4, type:'text', page_idx:0, text:'Measured on a small sample.', bbox:[100,100,900,150] };
const opts = { view, items:[frame], chars:[] };
const scan = D.ParallelPage.plan(opts);
assert.deepEqual(Array.from(scan[0].rect), [40,200,200,210]);
assert.equal(scan[0].placed,true,'OCR geometry accounts for a non-zero crop origin');
{
  const caption = {id:7,type:"text",page_idx:0,bbox:[100,600,900,660],
    text:'Figure 20: Comparison of reconstructed scenes. “Pcd.” denotes point cloud.'};
  const label = {text:"Our Ped.",rect:[60,160,104,165],mask:[60,160,104,165],size:5};
  const corrected = D.ParallelPage.plan({...opts,items:[caption],rasterLabels:[label]})
    .find(u => u.role === "figure_label");
  assert.equal(corrected.source,"Our Pcd.");
  assert.match(corrected.hint,/denotes point cloud/);
  const unrelated = D.ParallelPage.plan({...opts,rasterLabels:[label]}).find(u => u.role === "figure_label");
  assert.equal(unrelated.source,"Our Ped.");
}
const conflict = D.ParallelPage.plan({...opts,items:[frame,{id:5,type:'equation',bbox:[120,110,160,145]}]});
{
  const labels=[
    {text:"Output",rect:[50,90,89,102],mask:[53,94,80,100],size:7},
    {text:"Probabilities",rect:[50,82,98,93],mask:[51,83,93,90],size:7}
  ];
  const units=D.ParallelPage.plan({...opts,items:[],rasterLabels:labels});
  assert.equal(units.length,2);
  assert.ok(units.every(u=>u.placed));
  assert.equal(units[0].rect[1],92);
  assert.equal(units[1].rect[3],92);
  units[0].translation="输出"; units[1].translation="概率";
  const rec=D.ParallelPage.records(units);
  assert.deepEqual(JSON.parse(rec[0].identity)[2],labels[0].rect,"visual clearance does not invalidate the translation");
}
assert.equal(conflict[0].placed,false,'text cannot obscure a formula');
const mismatch = D.ParallelPage.plan({...opts,chars:[{u:'Z',rect:[50,199,57,210],fontSize:10}]});
assert.equal(mismatch[0].placed,false,'an OCR box covering different PDF text stays unpainted');
const fig={id:7,page_idx:0,type:'image',image_caption:['Fig. 1. Example.'],bbox:[80,120,400,750]};
assert.equal(D.ParallelPage.plan({...opts,items:[fig]})[0].placed,false,'never erase a whole image to replace an unlocatable caption');
const old={pageIndex:0,paragraphIndex:5,paragraphText:frame.text,paragraphType:'text',bbox:frame.bbox,points:[{translation:'物理段译文。'}]};
const combined={keys:['p_0_5','p_1_0'],translation:'首段接下页。',fragments:[{key:'p_0_5',text:'首段'},{key:'p_1_0',text:'接下页。'}]};
const plan=(extra={})=>D.ParallelPage.plan({view,paragraphs:[old],chars:[],...extra});
assert.equal(plan({continuationFor:()=>combined})[0].translation,'首段');
assert.equal(plan({continuationFor:()=>({...combined,fragments:undefined})})[0].translation,'物理段译文。','legacy joined text is not duplicated into both columns/pages');
assert.equal(plan({reuse:false,continuationFor:()=>combined})[0].translation,'','do not reuse a different target language');
const context = D.ParallelPage.interruptedContext([{...frame,text:'The measurement depends on the',bbox:[100,790,480,880]},
  {...frame,page_idx:1,text:'sampling interval of the instrument.',bbox:[100,100,480,210]}],0);
assert.equal(context.get('themeasurementdependsonthe')[1], 'sampling interval of the instrument.', 'supply context across an interrupted sentence');
scan[0].translation='测量小样本。';
const saved=D.ParallelPage.records(scan);const updated=D.ParallelPage.plan({...opts,items:[{...frame,text:'A different source.'}]});
D.ParallelPage.hydrate(updated,saved);assert.equal(updated[0].translation,'','numeric IDs alone cannot recover a translation');
const units=D.ParallelPage.plan(opts);D.ParallelPage.hydrate(units,saved);assert.equal(units[0].translation,'测量小样本。');
const pending = Array.from({length:8},(_,i)=>({source:`Paragraph ${i}`,styled:`Paragraph ${i}`,translation:''}));
let calls=0;
await assert.rejects(D.ParallelPage.translate(pending,{language:'zh',signal:new AbortController().signal,request:async (args)=>{
  const list=JSON.parse(args.messages[0].content.split('\n').slice(1).join('\n'));calls++;
  return {content:JSON.stringify({translations:calls>=2?[]:list.map(row=>({id:row.id,translation:'译文'}))})};
}}));
assert.equal(calls,3);assert.ok(pending.every(u=>u.translation===''),'a failed page cannot claim completion after a successful first batch');
console.log('parallelPage: crop, graphic protection, physical continuation mapping, cache and atomic retries passed');

const describe = (source, lang = 'zh', runs = []) => D.ParallelInline.describe(runs,source,source,10,lang);
{
  const counts = (text, language="zh")=>Array.from(describe(text,language).tokens)
    .filter(t=>t.kind==="scaled_count").map(t=>t.display);
  for (const [s,value] of [
    ["3.3 billion words","33亿"],["3.30 billion words","33.0亿"],
    ["800 million samples","8亿"],["2.125 million records","212.5万"],
    ["0.00031 million labels","310"],["1,005.75 million people","10.0575亿"],
    ["0.00 billion","0.0亿"],["0 billion","0"],
    ["1.25 trillion tokens","1.25万亿"],["-2.4 million","-240万"],
    ["9,007,199,254,740,993 billion","9007199254740.993万亿"]
  ]) assert.deepEqual(counts(s),[value]);
  assert.deepEqual(counts("3.3 billion words","zh-TW"),["33億"]);
  assert.deepEqual(counts("3.3 billion words","en"),[]);
  assert.deepEqual(counts("the Billion Word Benchmark, a 3B model, and 35B-A3B"),[]);
  assert.deepEqual(counts("4.5 million sentence pairs and 36M sentences"),["450万","3600万"]);
  assert.deepEqual(counts("800M words, with 2.5M tokens"),["8亿","250万"]);
  assert.deepEqual(counts("Model-36M tokens; 36m words; 36 M tokens; 36M Hz; 2K words; 3B tokens"),[]);
  assert.deepEqual(counts("1–3 billion and between 2 and 5 million"),[]);
  assert.deepEqual(counts("1e-3 billion and 2e+7 million"),[]);
  const unit=describe("A corpus of 3.3 billion words.");
  assert.equal(D.ParallelInline.issue(unit,"含 ⟦D0⟧ 个词的语料库。"),"");
  assert.equal(D.ParallelInline.issue(unit,"含 ⟦D0⟧ 亿个词的语料库。"),"protected_value");
  assert.equal(D.ParallelInline.issue(unit,"含 ⟦D0⟧ 十亿词的语料库。"),"protected_value");
  assert.equal(D.ParallelInline.issue(describe("2 million kilobytes."),"⟦D0⟧ 千字节。"),"");
}
const style = (fontName) => D.Typography.italic({fontName});
assert.ok(style('ABCDEF+NimbusRomNo9L-ReguItal') && style('Helvetica-BoldItalMT'));
assert.equal(style('Digital-Roman'),false);
const locks = describe('With negative sampling, α is slightly less than 1 at 46.9% and 5e-3 m/s.');
assert.deepEqual(Array.from(locks.tokens,t=>t.display),['负采样','α 略小于 1','46.9%','5e-3 m/s']);
const tw = describe('With negative sampling, $\\alpha$ is no less than 2.','zh-TW');
assert.deepEqual(Array.from(tw.tokens,t=>t.display),['負採樣','α 不低於 2']);
assert.equal(describe('negative sampling','en').tokens.length,0);
const correct = '采用⟦D0⟧，⟦D1⟧，所占比例为⟦D2⟧，速度为⟦D3⟧。';
assert.ok(D.ParallelInline.valid(locks,correct));
for (const wrong of [correct.replace('⟦D0⟧','负对数'), correct+'⟦D4⟧', correct+'⟦D0⟧', correct+'K 大于 1',
  correct+'50%',correct.replace('⟦D1⟧', '`⟦D1⟧`')]) assert.equal(D.ParallelInline.valid(locks,wrong),false);
assert.equal(D.ParallelInline.fromLegacy(locks,'负对数，K 大于 1，46.9%，5e-3 m/s。'),'');
assert.equal(D.ParallelInline.fromLegacy(describe('Score 3.'),'第13名中的3。'),'第13名中的⟦D0⟧。');
const emph = describe('**Result.** We use *rolling control*.');
const range = describe("The success rate rises from 0.8% to 21.2%.");
const trainability = describe("The policies remain stable and easy to train.");
assert.equal(D.ParallelInline.issue(describe("Moreover, similarly to the"),"而且，与……类似，"),"missing_comparison");
assert.equal(D.ParallelInline.issue(describe("The printed phrase is similar to …"),"原文写作“与……类似”。"),"");
{
  const texts=["We recommend this metric because, similarly to the","morpheme-based score, it accounts for morphology."];
  const items=texts.map((text,i)=>({type:"text",id:i,page_idx:0,text,bbox:i?[516,246,883,340]:[120,815,488,910]}));
  const context=D.ParallelPage.interruptedContext(items,0);
  const make=()=>texts.map((source,i)=>({...describe(source),source,role:"text",rect:[10+i*20,15,29+i*20,29],translation:""}));
  const old=make();old[0].translation="而且，与……类似，";old[1].translation="基于语素的分数考虑了词法。";
  const cached=D.ParallelPage.records(old),fresh=make();
  D.ParallelPage.setContext(fresh,context);D.ParallelPage.hydrate(fresh,cached);
  assert.ok(fresh[0].after.includes("morpheme-based score") && fresh[1].before.includes("similarly to the"));
  assert.ok(fresh.every(u=>!u.translation),"a corrected left half must not reuse the old isolated right half");
}
assert.equal(D.ParallelInline.issue(trainability,"这些策略训练稳定且易于实施。"),"training_scope");
assert.equal(D.ParallelInline.issue(trainability,"这些策略稳定且容易训练。"),"");
assert.equal(D.ParallelInline.issue(describe("The system is easy to train and deploy."),"该系统易于训练和部署。"),"");
assert.deepEqual(Array.from(describe("Under-sampling and oversampling.").tokens,t=>t.display),["欠采样","过采样"]);
assert.ok(describe("GAM: Grounded Action Model").tokens.some(t=>t.display==="空间定位动作模型"));
assert.equal(D.ParallelInline.issue(range,"成功率从 ⟦D1⟧ 提升至 ⟦D0⟧。"),"reversed_range");
assert.equal(D.ParallelInline.issue(range,"成功率由 ⟦D0⟧ 提升至 ⟦D1⟧。"),"");
assert.equal(D.ParallelInline.issue(range,"成功率提升至 ⟦D1⟧，原先仅为 ⟦D0⟧。"),"");
assert.ok(D.ParallelInline.valid(emph,'**结果。** 我们采用*滚动控制*。'));
assert.ok(!D.ParallelInline.valid(emph,'**结果。我们采用滚动控制。**'));
const glyphs = (str) => Array.from(str,(u,i)=>({u,rect:[i*5,20,i*5+5,30],fontSize:10,baseline:22,fontName:'Times-Roman'}));
{
  for (const text of ["Move to the sink (76 rounds)","The classification cost (He and Garcia, 2009)."]) {
    const plain=glyphs(text);
    const heading=plain.map(c=>({...c,fontName:"NimbusSans-Bold"}));
    for (const printed of [plain,heading]) {
      const unit=D.ParallelInline.describe(printed,text,text,10,"zh");
      assert.ok(!unit.tokens.some(t=>t.kind==="math" && /sin|cos/u.test(t.source)));
    }
  }
  const source="O(logk(n))", formula=glyphs(source);
  const k=source.indexOf("k");Object.assign(formula[k],{fontName:"CMMI7",fontSize:7,baseline:20});
  const result=D.ParallelInline.describe(formula,source,source,10,"zh");
  assert.ok(result.tokens.some(t=>t.kind==="math" && t.display.includes("log_{k}")));
  for(const text of ["sin(x)", "cos (x)", "sinh(x)"])
    assert.ok(D.ParallelInline.describe(glyphs(text),text,text,10,"zh").tokens.some(t=>t.kind==="math"));
}
{
  const s="Starting from AtK we obtain At0. b) In the next panel.";
  const cs=glyphs(s).map(c=>({...c,fontSize:8.52,baseline:22}));
  for (const m of s.matchAll(/At[K0]/gu)) {
    const i=m.index;
    Object.assign(cs[i],{fontName:"Times-Bold",fontSize:8.97});
    Object.assign(cs[i+1],{fontName:"Times-Italic",fontSize:6.97,baseline:19.79});
    Object.assign(cs[i+2],{fontName:"Times-Italic",fontSize:6.97,baseline:25.26,rect:cs[i+1].rect.slice()});
  }
  const unit=D.ParallelInline.describe(cs,s,s,8.5,"zh");
  assert.deepEqual(Array.from(unit.tokens,t=>[t.source,t.display]),[["AtK","A_{t}^{K}"],["At0","A_{t}^{0}"]]);
  assert.ok(unit.modelText.includes(". b) In"));
}
{
  const source = "Complex structures (e.g., stairs), i.e. obstacles near x.";
  const printed = glyphs(source);
  for (const match of source.matchAll(/e\.g\.|i\.e\.|x(?=\.)/gu)) {
    for (const c of printed.slice(match.index, match.index + match[0].length)) c.fontName = "Times-Italic";
  }
  const unit = D.ParallelInline.describe(printed, source, source, 10, "zh");
  assert.deepEqual(Array.from(unit.tokens, t => t.source), ["x"]);
  assert.ok(unit.modelText.includes("*e.g.*"));
  assert.ok(unit.modelText.includes("*i.e.*"));
}
{
  const name = "RoboUniverse-10K", source = name + ", 10,807 interactive environments.";
  const printed = glyphs(source);
  for (const c of printed.slice(0, name.length)) c.fontName = "Times-Bold";
  const unit = D.ParallelInline.describe(printed, source, source, 10, "zh");
  assert.deepEqual(Array.from(unit.tokens, t => [t.kind, t.source]), [["identifier", name], ["number", "10,807"]]);
  assert.equal(unit.tokens[0].bold, true);
  assert.ok(unit.modelText.startsWith("⟦D0⟧, ⟦D1⟧"));
}
{
  const text = "We use a shared model (vs. π) and a Molmo2 planner for a bimanual arm.";
  const printed = glyphs(text).map(c => ({...c, fontName: "Times-Bold"}));
  const unit = D.ParallelInline.describe(printed, text, text, 10, "zh");
  assert.deepEqual(Array.from(unit.tokens, t => t.source), ["π"]);
  assert.ok(unit.modelText.includes("a shared model"));
  assert.ok(unit.modelText.includes("a bimanual arm"));
  const fragment = "distance, creating a";
  const italic = glyphs(fragment).map(c=>({...c,fontName:"Times-Italic"}));
  assert.deepEqual(Array.from(D.ParallelInline.describe(italic,fragment,fragment,10,"zh").tokens),[]);
}
const ocr = String.raw`Estimate $x^k$ after filtering.`;
const gs = glyphs('Estimate xk after filtering.');
const power=gs.findIndex(c=>c.u==='k');Object.assign(gs[power-1],{fontName:'Times-Bold'});Object.assign(gs[power],{fontSize:7,baseline:26,rect:[power*5,25,power*5+3,32]});
const aligned=D.ParallelInline.alignOCR(gs,ocr);
assert.ok(aligned && aligned.get(gs[power])===aligned.get(gs[power-1]));
assert.equal(D.ParallelInline.alignOCR(glyphs('Estimate unrelated label after filtering.'),ocr),null);
const originalInk=D.ParallelInline.describe(gs,ocr,ocr,10,'zh',aligned);
assert.deepEqual(Array.from(originalInk.tokens,t=>[t.kind,t.display]),[['math','$x^k$']]);
assert.equal(describe(ocr).tokens[0].kind,'tex','OCR-only inline TeX remains a formula');
const numbered=D.ParallelPage.plan({...opts,items:[{...frame,type:'list',list_items:['1. Measure 2 runs.']}]})[0];
assert.equal(numbered.marker,'1.');assert.deepEqual(Array.from(numbered.tokens,s=>s.display),['2']);
const onlyEquation=D.ParallelPage.plan({...opts,items:[{...frame,text:'$x^2$'}]});assert.equal(onlyEquation.length,0);
const revival = D.ParallelPage.plan({...opts,items:[{...frame,text:'The score was 46.9%.'}]});
const u = revival[0], oldRect=u.rect.slice(); oldRect[2]-=3;
const preContract={identity:JSON.stringify([u.source,'old style',oldRect,'']),text:'得分为46.9%。'};
D.ParallelPage.hydrate(revival,[preContract]);assert.equal(u.translation,'得分为⟦D0⟧。');
u.translation='';D.ParallelPage.hydrate(revival,[preContract,{...preContract,identity:JSON.stringify([u.source,'other',u.rect,''])}]);assert.equal(u.translation,'');
D.ParallelPage.hydrate(revival,[{...preContract,text:'得分为49%。'}]);assert.equal(u.translation,'');
const repairGroup=()=>[describe('negative sampling'),describe('The gain was 46.9%.')].map(u=>({...u,source:u.styled,translation:''}));
async function repairTest(alwaysFail) {
  const rows=repairGroup(), sizes=[];
  const promise=D.ParallelPage.translate(rows,{language:'zh',signal:new AbortController().signal,request:async args=>{
    const batch=JSON.parse(args.messages[0].content.split('\n').slice(1).join('\n'));sizes.push(batch.length);
    return {content:JSON.stringify({translations:batch.map((r,i)=>({id:r.id,
      translation:(sizes.length===1&&i===1)||(alwaysFail&&sizes.length>1)?'错为49%。':'结果为⟦D0⟧。'}))})};
  }});
  if (alwaysFail) {await assert.rejects(promise);assert.ok(rows.every(u=>!u.translation));}
  else {await promise;assert.ok(rows.every(u=>u.translation));}
  assert.deepEqual(sizes,alwaysFail ? [2,1,1] : [2,1]);
}
await repairTest(false);await repairTest(true);
console.log('parallelPage: inline PDF and OCR formulas, protected semantics, numbering, cache migration and selective repair passed');
// The parser can omit a numbered line between two body blocks. Preserve its
// separate source position even when small capitals have two different sizes.
const hv=[0,0,200,200];
const at=(str,x,y)=>glyphs(str).map((c,i)=>({...c,rect:[x+i*5,y,x+i*5+5,y+10],baseline:y+2}));
{
  const view = [0,0,320,240];
  const make = (text,x,y,end = false) => at(text,x,y).map((c,i) => ({...c,lineBreakAfter:end && i===text.length-1}));
  function recover(nextY) {
    const following=make(".The solver keeps the source expression.",45,nextY,true);
    following[0].spaceAfter=true;
    const physical = [
      make("The procedure uses the coefficients",20,180,true),
      make("{α,β}",20,166),
      following
    ];
    const items = physical.map((chars,i) => {
      const [l,b,r,t]=D.Overlay.unionRect(chars.map(c=>c.rect));
      return {id:i,type:i===1?"equation":"text",page_idx:0,text:chars.map(c=>c.u).join(""),
        bbox:[l/320*1000,(240-t)/240*1000,r/320*1000,(240-b)/240*1000]};
    });
    return D.ParallelFrames.recover(items,physical.flat(),view).items;
  }
  const inline=recover(166);
  assert.equal(inline.length,1);
  assert.match(inline[0].text,/coefficients \{α,β\}\. The solver/u);
  assert.ok(recover(148).some(item=>item.type==="equation"),"an isolated formula stays outside the text flow");
}
{
  const title = "A Toolbox for Learning";
  const page = {index:2,view:hv,chars:at(title,36,186)};
  const firstPage = [{page_idx:0,text_level:1,text:"Project: A Toolbox for"},{page_idx:0,text:"Learning"}];
  const [header] = D.ParallelPage.restoreRunningTitle(page,[],firstPage);
  assert.equal(header.text,title);
  assert.equal(header.type,"header");
  const tagged = [header];
  assert.equal(D.ParallelPage.restoreRunningTitle(page,tagged,firstPage),tagged);
  const [existing] = D.ParallelPage.restoreRunningTitle(page,[{...header,type:"text",layoutPart:null}],firstPage);
  assert.equal(existing.layoutPart,"runningTitle");
  assert.equal(D.ParallelPage.restoreRunningTitle({...page,chars:at("Alice, Bob and Chen",36,186)},[],firstPage).length,0);
}
{
  const cap="Figure 1 Overview of the environment.";
  const row=(text,x,y)=>at(text,x,y).map((c,i)=>({...c,lineBreakAfter:i===text.length-1}));
  const chars=[...row("REAL VIDEOS",24,175),...row("(c) Performance",112,140),...row(cap,16,95)];
  const figure={id:93,page_idx:1,type:"text",text:cap,bbox:[20,470,990,530]};
  const result=D.ParallelFrames.recover([figure],chars,hv).items.filter(i=>i.type==="figure_label");
  assert.ok(result.some(item=>item.text==="REAL VIDEOS"));
  assert.ok(result.some(item=>item.text.includes("Performance")));
}
const shallowText='Capitals and descenders.';
const shallowChars=at(shallowText,30,100).map(c=>({...c,rect:[c.rect[0],100,c.rect[2],104.5],baseline:100}));
const shallowBlock={type:'text',page_idx:1,text:shallowText,bbox:[140,470,790,505]};
const shallowPlan=items=>D.ParallelPage.plan({view:hv,items,chars:shallowChars})[0];
const shallow=shallowPlan([shallowBlock]);
assert.ok(shallow.placed && shallow.matched && shallow.masks[0][1]<98 && shallow.masks[0][3]>108);
assert.deepEqual(Array.from(shallow.rects[0]),[30,100,150,104.5],'expanded erase mask keeps the source line anchor');
const closeEquation={type:'equation',page_idx:1,bbox:[150,448,410,465]};
const protectedLine=shallowPlan([shallowBlock,closeEquation]);
assert.ok(protectedLine.placed && protectedLine.masks[0][3]<107,'an expanded erase mask does not touch the equation');
const ht=at('II. METHODS',50,100);
for (let i=5;i<ht.length;i++) ht[i].fontSize=7.9;
const boxes=[
  {type:'text',text:'A paragraph above.',bbox:[70,290,930,410]},
  {type:'text',text:'A paragraph below.',bbox:[70,525,930,640]}
];
const heading=D.ParallelPage.plan({view:hv,items:boxes,chars:ht}).find(u=>u.title);
assert.ok(heading?.placed && heading.modelText.includes('METHODS') && heading.tokens[0].display==='II.');
const graphic=D.ParallelPage.plan({view:hv,items:[...boxes,{type:'image',bbox:[70,430,930,520]}],chars:ht});
assert.ok(!graphic.some(u=>u.title),'never translate a heading-shaped label inside a graph');
assert.equal(D.ParallelPage.plan({...opts,items:[{...frame,text:'$$x^2=y$$'}]}).length,0);

for (const [header, continuation] of [
  ["A Model for Reconstructing,", "Generating and Simulating Worlds"],
  ["Pre-training Transformers for", "Language Understanding"]
]) {
  const view = [0, 0, 400, 400];
  const printed = (text, y, size = 14) => at(text, 200 - text.length * 2.5, y).map((c, i) => ({
    ...c, fontSize: size, fontName: size === 14 ? "Times-Bold" : "Times-Roman",
    lineBreakAfter: i === text.length - 1
  }));
  const bands = [printed(header, 350), printed(continuation, 337), printed("Research Team", 315, 10),
    printed("https://example.org", 300, 10), printed("Abstract", 280)];
  const bounds = chars => {
    const [l, b, r, t] = D.Overlay.unionRect(chars.map(c => c.rect));
    return [l*2.5, (400-t)*2.5, r*2.5, (400-b)*2.5];
  };
  const items = [
    { type:"text", page_idx:0, text_level:1, text:header, bbox:bounds(bands[0]) },
    { type:"text", page_idx:0, text:continuation + " · Research Team · https://example.org",
      bbox:bounds(bands.slice(1,4).flat()) },
    { type:"text", page_idx:0, text_level:1, text:"Abstract", bbox:bounds(bands[4]) },
  ];
  const title = D.ParallelPage.plan({view,items,chars:bands.flat()}).find(u => u.documentTitle);
  assert.equal(title.source, header + " " + continuation);
  assert.equal(title.rects.length, 2);
}

{
  const items = [
    {...frame, id:0, text:"Study of Documents", text_level:1, bbox:[80,60,880,90]},
    {...frame, id:1, text:"Alice Smith alice@example.org", bbox:[80,120,880,135]},
    {...frame, id:2, text:"Correspondence: alice@example.org", bbox:[80,150,880,165]},
    {...frame, id:3, text:"Abstract", text_level:1, bbox:[80,190,880,205]},
    {...frame, id:4, text:"1. https://example.org/project", bbox:[80,830,780,855]}
  ];
  const planned = D.ParallelPage.plan({...opts,items});
  assert.ok(!planned.some(u=>u.source===items[1].text || u.source===items[4].text));
  assert.ok(planned.some(u=>u.source.startsWith("Correspondence:")));
}

// The table separating the two halves of this sentence resides on page 2.
{
  const view=[0,0,500,700];
  const rows=[
    ["Excerpt 1: Camera setup",650,"NimbusSanL-Bold"],
    ["Read the supplied views before running the model.",634],
    ["## Operating this environment",619],
    ["demo describe",596],["demo observe --images /tmp/view",586],
    ["from demo_client import Client",564],["robot = Client()",554],
    ["# Supply a finite vector in order.",544],["# result = robot.step(action)",534],
    ["Run demo observe --images /tmp/view and inspect scene.json.",508],
  ].map(([s,y,font="SFVT0800"])=>{
    const cs=at(s,62,y).filter(c=>c.u!==" ");
    let n=0;
    for(let i=0;i<s.length;i++) if(s[i]!==" ") {
      const c=cs[n++]; c.fontName=font; c.fontSize=8; c.spaceAfter=s[i+1]===" ";
      c.lineBreakAfter=n===cs.length;
    }
    return cs;
  });
  const item=(indices,id,title=false)=>{
    const chars=indices.flatMap(i=>rows[i]),rect=D.Overlay.unionRect(chars.map(c=>c.rect));
    return {type:"text",id,page_idx:3,...(title?{text_level:1}:{}),
      text:indices.map(i=>rows[i].map(c=>c.u+(c.spaceAfter?" ":"")).join("")).join(" "),
      bbox:[rect[0]*2,(700-rect[3])*1000/700,rect[2]*2,(700-rect[1])*1000/700]};
  };
  const units=D.ParallelPage.plan({view,chars:rows.flat(),items:[
    item([0],1,true),item([1],2),item([3,4],3),item([5,6,7,8],4),item([9],5)
  ]});
  assert.ok(units.find(u=>u.source.startsWith("Excerpt"))?.typewriterHeading);
  assert.ok(units.some(u=>u.typewriterBody && u.source.startsWith("## Operating")));
  assert.ok(!units.some(u=>u.source.includes("robot =") || u.source.startsWith("# result") || u.source==="demo describe"));
  assert.equal(units.filter(u=>u.role==="code_comment" && u.source.startsWith("Supply")).length,1);
  const prose=units.find(u=>u.source.startsWith("Run demo"));
  assert.ok(prose.tokens.some(t=>t.kind==="code" && t.source==="demo observe --images /tmp/view"));
  assert.ok(prose.tokens.some(t=>t.kind==="code" && t.source==="scene.json"));
}

const line = (bbox, value) => ({bbox, spans:[{type:'text',content:value}]});
{
  const labels = ["• Review","• Repository","• Archive"];
  const printed = labels.flatMap((label,i) => at(label,20,155-i*15).map((c,j) =>
    ({...c,lineBreakAfter:j===label.length-1})));
  const units = D.ParallelPage.plan({view:[0,0,200,200],chars:printed,items:[
    {id:"links",type:"text",page_idx:0,bbox:[95,170,470,390],text:labels.join(" ")}
  ]});
  assert.deepEqual(Array.from(units,u=>u.source),labels);
  assert.ok(units.every(u=>u.matched && u.placed));
  assert.equal(units[0].translation,"评审");
}

const head = line([10,85,90,95],'The measurements depend on the');
{
  const lead="Figure 2. Applying modulation (FiLM)", tail="Smith et al. (2018) conditioning here.";
  const view=[0,0,400,200];
  const chars=[[lead,130],[tail,118]].flatMap(([s,y]) =>
    at(s,25,y).map((c,i)=>({...c,lineBreakAfter:i===s.length-1})));
  const items=[
    {type:"image",id:"fig",page_idx:3,image_caption:[lead],bbox:[50,80,610,350]},
    {type:"text",id:"rest",page_idx:3,text:tail,bbox:[50,355,610,415]}
  ];
  const units=D.ParallelPage.plan({view,items,chars,nativeParser:true});
  assert.equal(units.filter(u=>u.source.startsWith("Smith")).length,0);
  assert.ok(units.some(u=>u.caption && u.source===lead+" "+tail && u.rects.length===2));
}
{
  const rows=[
    ["We compare with the two best ranked metrics",150],
    ["(METHOD1 and METHOD2) and the METRIC",136],
    ["metrics, which are also highly ranked.",122]
  ];
  const chars=rows.flatMap(([s,y])=>at(s,30,y).map((c,j)=>({...c,lineBreakAfter:j===s.length-1})));
  const items=[0,2].map(i=>({id:i,type:"text",text:rows[i][0],page_idx:1,
    bbox:[75,(200-rows[i][1]-10)*5,750,(200-rows[i][1])*5]}));
  const units=D.ParallelPage.plan({view:[0,0,400,200],chars,items});
  assert.equal(units.length,1);
  assert.equal(units[0].source,rows.map(row=>row[0]).join(" "));
  assert.equal(units[0].rects.length,3);
}
const tail = line([10,10,90,20],'sampling interval used here.');
const sourcePart = (l) => ({type:'text',bbox:l.bbox,lines:[l]});
const layoutPages = {pdf_info:[
  {page_idx:0,page_size:[100,100],preproc_blocks:[sourcePart(head)],para_blocks:[{...sourcePart(head),lines:[head,tail]}]},
  {page_idx:1,page_size:[100,100],preproc_blocks:[],para_blocks:[]},
  {page_idx:2,page_size:[100,100],preproc_blocks:[sourcePart(tail)],para_blocks:[]}
]};
const merged=[{id:10,page_idx:0,type:'text',bbox:[100,850,900,950],text:head.spans[0].content+' '+tail.spans[0].content}];
D.ParallelVisual.attachLayout(merged,layoutPages);
const parts = [0,1,2].map(i=>D.ParallelVisual.pageItems(merged,i));
assert.deepEqual(parts.map(a=>a.length),[1,0,1]);
assert.equal(parts[2][0].text,tail.spans[0].content);
assert.deepEqual(Array.from(parts[0][0].context),[head.spans[0].content,tail.spans[0].content]);
const paperRef=D.ParallelPage.plan({...opts,items:[{...frame,type:'ref_text',text:'A. Researcher. A method for estimation.'}]});
assert.equal(paperRef.length,1); assert.equal(paperRef[0].role,'ref_text'); assert.equal(paperRef[0].marker,'');
assert.ok(D.Typography.bold({fontName:'FJTTTT+CMBX12'}));
assert.ok(D.Typography.italic({fontName:'ABCDEFG+CMTI10'}));
assert.ok(D.Typography.monospace({fontName:'ABCDEF+CMTT10'}));
assert.ok(D.Typography.monospace({fontName:'ABCDEF+SFTT1000'}));
const accented=at('Milos',20,85);
accented.splice(4,0,{...accented[4],u:'ˇ'});
assert.equal(D.Typography.composeAccents(accented).map(c=>c.u).join(''),'Miloš');
const variable=at('A method for data (WMT-12).',10,80).map(c=>({...c,fontName:'CMTI10'}));
const styled=D.ParallelInline.describe(variable,'A method for data (WMT-12).','',10,'zh');
assert.equal((styled.modelText.match(/\*/g)||[]).length,2,'a numeric token does not split one italic source title into two');
const cellRows=[
 ...at('Method',10,90),...at('Binary',60,90),...at('Binary',100,90),
 ...at('SVM',10,70),...at('0.805',60,70),...at('0.857',100,70)
];
const cells=D.ParallelVisual.labels({table_body:'<table><tr><th>Method</th><th>Binary</th><th>Binary</th></tr><tr><td>SVM</td><td>0.805</td><td>0.857</td></tr></table>'},cellRows);
assert.deepEqual(Array.from(cells,x=>x.source),['Method','Binary','Binary']);
assert.equal(D.ParallelVisual.compactLabel('fr-en','zh',true),'法-英');
assert.equal(D.ParallelVisual.compactLabel('en-fr','zh',true),'英-法');
assert.equal(D.ParallelVisual.compactLabel('en-fr','zh',false),'');
assert.equal(D.ParallelVisual.compactLabel('(ours)','zh',false,'**(ours)**'),'**本文**');
assert.equal(D.ParallelVisual.compactLabel('Succ%','zh',false),'成功率%');
console.log('parallelPage: cross-page physical fragments, bibliography, TeX faces, accents and table label ownership passed');
const dates=describe('Retrieved July 22, 2018, after 19 July 2018.');
const spanDates=describe('17–18 September 2015 and July 2-5, 2024.');
assert.deepEqual(Array.from(spanDates.tokens,t=>[t.kind,t.display]),[["date","2015年9月17日至18日"],["date","2024年7月2日至5日"]]);
assert.deepEqual(Array.from(dates.tokens,t=>[t.kind,t.display]),[['date','2018年7月22日'],['date','2018年7月19日']]);
assert.ok(D.ParallelInline.valid(dates,'于⟦D0⟧查阅，在⟦D1⟧之后。'));
assert.ok(!D.ParallelInline.valid(dates,'于⟦D0⟧年查阅，在⟦D1⟧之后。'));
const title=at('A Python Toolbox',10,80).map(c=>({...c,fontName:'CMBX12'}));
const article=D.ParallelInline.describe(title,'A Python Toolbox','',10,'zh');
assert.ok(!article.tokens.some(t=>t.source==='A'),'a bold indefinite article is still prose');
const caps=at('CHRF evaluation',10,80).map((c,i)=>({...c,fontSize:i<3?7.9:10,fontName:'CMBX12'}));
assert.ok(!D.ParallelInline.describe(caps,'CHRF evaluation','',10,'zh').tokens.some(t=>t.kind==='math'));
assert.ok(!describe('This ensures back-compatibility. Community-based work follows.').tokens.some(t=>t.kind==='url'));
const runs = [{lead:'First topic',body:' We describe the data.',y:80},{lead:'Second topic',body:' We compare the estimates.',y:68}];
const runChars=[],mapping=[];let printed='';
for(const {lead,body,y} of runs){
 const row=at(lead+body,12,y);
 row.forEach((c,j)=>{if(j<lead.length)c.fontName='CMTI10'; mapping.push(runChars.length);runChars.push(c);printed+=c.u;});
 runChars.at(-1).lineBreakAfter=true; mapping.push(runChars.length-1);printed+='\n';
}
assert.equal(D.TranslationLayout.analyze(printed,mapping,runChars).units.length,2,'flush-left run-in headings are independent paragraphs');
load('scripts/reader/parallelInk.js');
{
  const rgb = [[191, 0, 64], [191, 0, 64], [191, 0, 64], [198, 32, 88], [204, 51, 102], [216, 100, 138]];
  const pixels = {width: rgb.length, height: 1, data: Uint8ClampedArray.from(rgb.flatMap(c => [...c, 255]))};
  const page = {width: rgb.length, height: 1, transform: [1, 0, 0, 1, 0, 0]};
  assert.equal(D.ParallelInk.inkColor({samples: [[0, 0, rgb.length, 1]]}, page, pixels), "rgb(191,0,64)",
    "anti-aliased outlines must not bleach the printed contents colour");
  const field = {width:8,height:7,data:Uint8ClampedArray.from(Array(56).fill([86,193,255,255]).flat())};
  for (const y of [2,3,4]) for (const x of [2,5]) field.data.set([0,0,0,255],4*(y*8+x));
  assert.equal(D.ParallelInk.inkColor({samples:[[1,1,7,6]]},{...page,width:8,height:7},field),"rgb(0,0,0)",
    "a blue panel behind a black label must not become its translated ink");
}
{
  const ops = {save:1, restore:2, beginText:3, endText:4, showText:5, setFillRGBColor:6, setGState:7};
  const notes = ["Split note", "Repeated note", "Faded note", "Ordinary label"].map((source,owner) =>
    ({source,owner,stageNote:owner !== 3}));
  const draw = (...words) => [[ops.beginText], ...words.map(unicode => [ops.showText,[[{unicode}]]]), [ops.endText]];
  const rows = [[ops.setFillRGBColor,["#6b6b6b"]], [ops.save], [ops.setFillRGBColor,["#1f1f1f"]],
    ...draw("Repeated note"), [ops.restore], ...draw("Split ", "note"), ...draw("Repeated note"),
    ...draw("Ordinary label"), [ops.setGState,[[["ca",.6]]]], ...draw("Faded note")];
  const list = {lastChunk:true,fnArray:rows.map(r=>r[0]),argsArray:rows.map(r=>r[1])};
  assert.deepEqual(Array.from(D.ParallelInk.stageNoteInks(notes,list,ops), pair => Array.from(pair)),[[0,"#6b6b6b"]],
    "only an identified stage note with a consistent opaque fill inherits gray");
}
{
  const code = {display:"fit sample",codeSpaces:[{at:3,left:12,right:17,baseline:10,em:10}]};
  const paper = {width:40,height:30,transform:[1,0,0,1,0,0]};
  const pixels = {width:80,height:60,data:new Uint8ClampedArray(80*60*4).fill(255)};
  const line = (x0,x1) => {
    for (let x=x0;x<x1;x++) pixels.data.set([0,0,0,255],4*(20*80+x));
  };
  assert.equal(D.ParallelInk.codeText(code,paper,pixels),"fit sample");
  line(25,34);
  assert.equal(D.ParallelInk.codeText(code,paper,pixels),"fit_sample");
  line(0,80);
  assert.equal(D.ParallelInk.codeText(code,paper,pixels),"fit sample","horizontal page rules are not underscores");
  const typed=glyphs("fitsample").map((c,i)=>({...c,fontName:"CMTT10",spaceAfter:i===2,
    rect:c.rect.map((v,j)=>v+(j%2===0 && i>2 ? 4 : 0))}));
  const literal=D.ParallelInline.describe(typed,"fit sample","fit sample",10,"zh").tokens[0];
  assert.equal(literal.codeSpaces.length,1);
  assert.deepEqual([literal.codeSpaces[0].at,literal.codeSpaces[0].left,literal.codeSpaces[0].right],[3,15,19]);
}
const bitmap={width:80,height:30,data:new Uint8ClampedArray(80*30*4).fill(255)};
const inkPage={transform:[1,0,0,1,0,0],width:80,height:30};
assert.ok(D.ParallelInk.flatSource([4,4,20,14],inkPage,bitmap));
bitmap.data[(8*80+7)*4]=20;
assert.equal(D.ParallelInk.flatSource([4,4,20,14],inkPage,bitmap),false,
  'even a small visible stroke keeps a source frame eligible for translation');
function greyAt(x,y,shade){
 let start=(y*bitmap.width+x)*4;bitmap.data.set([shade,shade,shade,255],start);
}
for(let x=0;x<80;x++)greyAt(x,8,0);
for(let y=0;y<30;y++)greyAt(45,y,0);
for(let y=12;y<19;y++)for(let x=22;x<27;x++)greyAt(x,y,30);
const patch=D.ParallelInk.labelPatch(bitmap,[18,7,47,21],{transform:[1,0,0,1,0,0],width:80,height:30},10);
patch.erase({
 getImageData:(x,y,w,h)=>{const pixels=new Uint8ClampedArray(w*h*4);
   for(let row=0;row<h;row++)pixels.set(bitmap.data.slice(4*((y+row)*80+x),4*((y+row)*80+x+w)),row*w*4);
   return {data:pixels,width:w,height:h};},
 putImageData:(im,x,y)=>{for(let row=0;row<im.height;row++)bitmap.data.set(im.data.slice(4*row*im.width,4*(row+1)*im.width),4*((row+y)*80+x));}
});
assert.equal(bitmap.data[(15*80+24)*4],255);
assert.equal(bitmap.data[(8*80+24)*4],0,'horizontal cell rule survives text replacement');
assert.equal(bitmap.data[(14*80+45)*4],0,'vertical cell rule survives text replacement');
console.log('parallelPage: full dates, heading numbering, paragraph lead-ins and cell rules passed');

const proseUnit = source => ({...describe(source),source,translation:''});
const copy = proseUnit('Our method performs well on unseen data.');
assert.equal(D.ParallelInline.valid(copy,copy.source),false);
assert.equal(D.ParallelInline.valid(copy,'结果显示 Our method performs well on unseen data.'),false);
assert.equal(D.ParallelInline.fromLegacy(copy,copy.source),'');
assert.equal(D.ParallelInline.valid({...copy,language:'en'},copy.source),true);
assert.ok(D.ParallelInline.valid(proseUnit('RoboJEPA'),'RoboJEPA'));
assert.ok(D.ParallelInline.valid(proseUnit('We use V-JEPA and PyTorch.'),'我们使用 V-JEPA 和 PyTorch。'));
const again=[proseUnit('Introduction'),proseUnit('Training details'),proseUnit('Introduction')], requests=[], checkpoints=[];
await D.ParallelPage.translate(again,{language:'zh',signal:new AbortController().signal,onProgress:async rows=>checkpoints.push(rows.length),
  request:async ({messages})=>{
    const rows=JSON.parse(messages[0].content.split('\n')[1]);
    requests.push(rows.map(r=>r.source_text));
    return {content:JSON.stringify({translations:[{id:rows[0].id,translation:requests.length===1?'引言':'训练细节'}]})};
  }});
assert.deepEqual(requests,[['Introduction','Training details'],['Training details']]);
assert.deepEqual(checkpoints,[2,1]);
assert.deepEqual(again.map(u=>u.translation),['引言','训练细节','引言']);

const cachedCopy=D.ParallelPage.plan({...opts,items:[{...frame,text:copy.source}]});
cachedCopy[0].translation=copy.source;
const copiedRecords=D.ParallelPage.records(cachedCopy);
cachedCopy[0].translation='';
D.ParallelPage.hydrate(cachedCopy,copiedRecords);
assert.equal(cachedCopy[0].translation,'','a cached source-language echo is pending on reopening the reader');

const atY=(value,x,y,opts={})=>at(value,x,y).map((c,i)=>({...c,...opts,lineBreakAfter:i===value.length-1}));
{
  const url="https://example.org/paper";
  const field=atY("Project page: "+url,20,170);
  const separate=describe("We publish the results. Project page: "+url,"zh",
    [...atY("We publish the results.",20,183),...field]);
  const meta=separate.tokens.find(t=>t.kind==="url").fieldLabel;
  assert.ok(meta.startsLine && meta.samples.every(r=>r[2]<=field[14].rect[0]),
    "only a standalone field's printed prefix supplies its colour and line boundary");
  const continuation=describe("Find the project page: "+url,"zh",
    [...atY("Find the",20,183),...field]);
  assert.equal(continuation.tokens.find(t=>t.kind==="url").fieldLabel,undefined,
    "an ordinary wrapped sentence introducing a URL must not gain a hard break");
}
const tocRows=[
  atY('A Alpha methods . . . . 10',8,150),
  atY('B Other results . . . . 12',8,135),
  atY('C More examples . . . . 14',8,120)
];
const flatToc=tocRows.map(r=>r.map(c=>c.u).join('')).join(' ');
const tocPlan=D.ParallelPage.plan({view:hv,chars:tocRows.flat(),items:[{id:20,type:'text',text:flatToc,bbox:[0,160,1000,420]}]});
assert.deepEqual(Array.from(tocPlan,u=>u.source),['Alpha methods','Other results','More examples']);
assert.ok(tocPlan.every(u=>u.placed && u.rect[2]<120 && u.rect[0]>10),'destination numbers and leader dots keep their own ink');
assert.ok(tocPlan.every(u=>u.contentsLeader?.pitch===10),"the leader uses the printed dot pitch");
const unnumberedToc = atY('Contribution 38', 8, 106);
for (const c of unnumberedToc.slice(-2)) {
  const shift = tocRows[0].at(-1).rect[2] - unnumberedToc.at(-1).rect[2];
  c.rect = [c.rect[0]+shift,c.rect[1],c.rect[2]+shift,c.rect[3]];
}
const contentsWithBackMatter = D.ParallelPage.plan({view:hv,chars:[...tocRows.flat(),...unnumberedToc],
  items:[{id:20,type:'text',text:flatToc+' Contribution 38',bbox:[0,160,1000,510]}]});
const contribution = contentsWithBackMatter.find(u=>u.source==='Contribution');
assert.ok(contribution?.placed && contribution.layoutPart==='contents' && contribution.rect[0]===8,
  'an unnumbered contents entry keeps its left edge and prints its page number separately');
assert.equal(contribution.contentsLeader,undefined,"an undotted source row keeps its blank gap");

const splitAtScript=[...atY('the vector ',15,100),...atY('V',72,105,{fontSize:6,baseline:106,rect:[72,102,76,108]}),
  ...atY('t',71,99,{fontSize:6,baseline:99,rect:[71,98,76,104]}),...atY('is given.',80,100)];
const repaired=D.ParallelFrames.repairScripts(splitAtScript);
assert.ok(splitAtScript[11].lineBreakAfter && !repaired[11].lineBreakAfter && repaired[12].scriptContinuation);
assert.equal(D.ParallelFrames.repairScripts([...atY('normal line',10,110),...atY('next line',10,96)])[10].lineBreakAfter,true);
console.log('parallelPage: missing IDs, incremental cache, source-language echoes, contents and stacked PDF scripts passed');

assert.ok(D.ParallelInline.valid(proseUnit('The study was published in The International Journal of Robotics Research.'),
  '该研究发表于 The International Journal of Robotics Research。'),'a journal title can remain in English');
assert.ok(D.Typography.bold({fontName:'ABCDEF+OptimisticDisp-Bd'}));
const boundaryUnit=proseUnit('We use the compiler; the');
const edgeParts=[boundaryUnit.source,'next experiment reports a 5% difference in Table 18.'];
D.ParallelPage.setContext([boundaryUnit],new Map([[D.ParallelInline.geometryText(boundaryUnit.source),edgeParts]]));
assert.ok(!D.ParallelInline.valid(boundaryUnit,'我们使用编译器；下一次实验的差异为 5%。'));
assert.ok(D.ParallelInline.valid(boundaryUnit,'我们使用该编译器；'));
boundaryUnit.translation='我们使用编译器；下一次实验的差异为 5%。';
D.ParallelPage.hydrate([boundaryUnit],[]);
assert.equal(boundaryUnit.translation,'','a neighbouring page cannot donate its results to an old translation');

const rectOf = run => [Math.min(...run.map(c=>c.rect[0])),Math.min(...run.map(c=>c.rect[1])),
  Math.max(...run.map(c=>c.rect[2])),Math.max(...run.map(c=>c.rect[3]))];
const pageView=[0,0,500,250];
const itemFor=(id,run,value,role='text')=>{
  const [l,b,r,t]=rectOf(run);return {id,page_idx:0,type:role,text:value,bbox:[l*2,(250-t)*4,r*2,(250-b)*4]};
};
const algorithmLines=['Algorithm 1 Sample procedure','Require: initial state','1: for i = 1 do',
  '2: Draw one sample','3: end for','4: return state','The next paragraph continues on the next page.'];
const algRuns=algorithmLines.map((t,i)=>atY(t,20,214-i*16));
const algorithm=D.ParallelPage.plan({view:pageView,items:algRuns.map((r,i)=>itemFor(i,r,algorithmLines[i])),chars:algRuns.flat()});
assert.ok(algorithm.some(u=>u.source===algorithmLines.at(-1) && u.placed),'a following prose paragraph is not part of an algorithm');
assert.ok(algorithm.some(u=>u.role==='algorithm_step' && u.source==='Draw one sample'));
assert.ok(!algorithm.some(u=>u.source==='4: return state'),'leave pseudocode syntax as printed');

const keyRows=['short horizon: y = 0.32 + x','long horizon: y = 0.75 + x'];
const keyRuns=keyRows.map((t,i)=>atY(t,20,140-i*13));
const legend=D.ParallelPage.plan({view:pageView,items:[itemFor(80,keyRuns.flat(),keyRows.join(' '))],chars:keyRuns.flat()});
assert.deepEqual(Array.from(legend,u=>u.source),['short horizon','long horizon']);
assert.ok(legend.every(u=>u.placed && u.role==='figure_label'),'fit the legend name without repainting its equation');

const gridCaption='Table 1 Each platform has a separate entry and a notes field.';
const gridTop=atY(gridCaption,10,225);
const entries=[['#','Platform','Notes'],['1','Astra','First setting'],['2','Beryl','Second setting'],['3','Ceres','Third setting']];
const gridRuns=entries.map((cells,i)=>cells.flatMap((v,j)=>{
  const run=atY(v,[12,30,146][j],196-i*14);
  if(j<2)Object.assign(run.at(-1),{lineBreakAfter:false,spaceAfter:true});
  return run;
}));
const grid=D.ParallelPage.plan({view:pageView,chars:[...gridTop,...gridRuns.flat()],items:[
  itemFor(100,gridTop,gridCaption),itemFor(101,gridRuns.flat(),entries.flat().join(' '))]});
const translatedCells=Array.from(grid.filter(u=>u.role==='table_label'),u=>u.source);
assert.ok(['Platform','Notes','First setting','Second setting','Third setting'].every(label=>translatedCells.includes(label)),JSON.stringify(translatedCells));
assert.ok(!grid.some(u=>u.source.includes('First setting Second setting') || u.source==='Astra' || u.source==='1 Astra First setting'));

const alignedCache=D.ParallelPage.plan(opts);
{
  const parts = [atY("First Colour Panel",15,183,{fontName:"Times-Bold"}),atY("Second View",163,183,{fontName:"Times-Bold"})];
  Object.assign(parts[0].at(-1),{lineBreakAfter:false,spaceAfter:true});
  const header = {...itemFor(61,parts.flat(),"First Colour Panel Second View"),text_level:1};
  const region = {id:62,type:"image",image_caption:["Figure 1. Two views."],bbox:[0,260,510,860],page_idx:0};
  const opts = {view:pageView,items:[header,region],chars:parts.flat()};
  const labels = D.ParallelPage.plan(opts).filter(u=>u.panelHeading);
  assert.equal(labels.length,2);
  const palette = new Map([[String(labels[0].rect),[{text:"Colour",samples:parts[0].slice(6,12).map(c=>c.rect)}]]]);
  const coloured = D.ParallelPage.plan({...opts,panelColors:palette}).find(u=>u.panelBold);
  assert.equal(coloured?.modelText,"First **Colour** Panel");
}
{
  const headingLine = (number, words, y) => {
    const prefix = atY(number, 10, y, {fontName:"Times-Bold"});
    Object.assign(prefix.at(-1), {lineBreakAfter:false,spaceAfter:true});
    return [...prefix,...atY(words,34,y,{fontName:"Times-Bold"})];
  };
  const parent = headingLine("C","Ablation studies",190);
  const child = headingLine("C.1","Effect of training",175);
  const tail = atY("steps",34,162,{fontName:"Times-Bold"});
  const result = D.ParallelPage.plan({view:pageView,chars:[...parent,...child,...tail],items:[
    {...itemFor(96,[...parent,...child],"C Ablation studies C.1 Effect of training"),text_level:1},
    {...itemFor(97,tail,"steps"),text_level:1}
  ]});
  assert.deepEqual(Array.from(result, b => b.source),["C Ablation studies","C.1 Effect of training steps"]);
}
{
  const samples = [["Source dataset", "Environments"], ["GridNet", "4,132"], ["Method B", "450"], ["DemoSet", "16"], ["Total", "4,598"]];
  const rows = samples.map(([name, value], index) => {
    const baseline = 185 - index*13;
    const label = atY(name, 14, baseline);
    Object.assign(label.at(-1), {lineBreakAfter: false, spaceAfter: true});
    const number = atY(value, 14, baseline);
    const dx = 206 - number.at(-1).rect[2];
    for (const c of number) c.rect = [c.rect[0]+dx,c.rect[1],c.rect[2]+dx,c.rect[3]];
    return [...label,...number];
  });
  const cells = D.ParallelPage.plan({view:pageView, chars:rows.flat(), items:[
    itemFor(90,rows[0],samples[0].join(" ")), itemFor(91,rows.slice(1,-1).flat(),samples.slice(1,-1).flat().join(" ")),
    itemFor(92,rows.at(-1),samples.at(-1).join(" "))
  ]});
  assert.deepEqual(Array.from(cells, c => c.source), ["Source dataset","Environments","Total"],
    "original dataset names and right-aligned measurement cells retain their physical rows");
  assert.ok(cells[0].flushLeft && cells[1].flushRight && cells[2].flushLeft);
}
alignedCache[0].translation='采用统一术语。'; alignedCache[0].termBase='使用早期译名。';
const reconciled=D.ParallelPage.records(alignedCache);
const fromCards=D.ParallelPage.plan(opts);fromCards[0].translation='使用早期译名。';
D.ParallelPage.hydrate(fromCards,reconciled);
assert.equal(fromCards[0].translation,'采用统一术语。');
fromCards[0].translation='手工改好的新译文。';
D.ParallelPage.hydrate(fromCards,reconciled);
assert.equal(fromCards[0].translation,'手工改好的新译文。','a later edit is never replaced by the older terminology correction');

{
  // Only adjacent legacy slots with matching source/context may be coalesced.
  const math=(id,source,display=source)=>({id:"⟦D"+id+"⟧",source,display,kind:"math"});
  const label=(id,source,kind)=>({...math(id,source),kind});
  const old={source:"S in range",rect:[0,0,90,11],styled:"S in range",language:"zh",marker:"",
    modelText:"Measure ⟦D0⟧ ⟦D1⟧.",tokens:[math(0,"s ∈"),label(1,"[0, 1]","citation")],translation:"测量 ⟦D0⟧ ⟦D1⟧。"};
  const next={...old,modelText:"Measure ⟦D0⟧.",tokens:[math(0,"s ∈ [0, 1]")],translation:""};
  const cached=D.ParallelPage.records([old]);
  D.ParallelPage.hydrate([next],cached);assert.equal(next.translation,"测量 ⟦D0⟧。");
  for(const bad of ["⟦D1⟧ 或 ⟦D0⟧","⟦D0⟧ 或 ⟦D1⟧","⟦D0⟧ ⟦D0⟧"]){
    const copy={...next,translation:""};D.ParallelPage.hydrate([copy],[{...cached[0],text:bad}]);assert.equal(copy.translation,"");
  }
  const old2={...old,modelText:"In ⟦D0⟧ point tracker.",tokens:[math(0,"I , a 2D")],translation:"位于 ⟦D0⟧ 点跟踪器。"};
  const next2={...old2,modelText:"In ⟦D0⟧, a ⟦D1⟧D point tracker.",tokens:[math(0,"I"),label(1,"2","number")],translation:""};
  D.ParallelPage.hydrate([next2],D.ParallelPage.records([old2]));assert.equal(next2.translation,"位于 ⟦D0⟧，⟦D1⟧D 点跟踪器。");
}
console.log("parallelPage: verified interval and dimensional-prose cache migrations passed");
{
  const printed=(text,y)=>{
    const cs=at(text,20,y);cs.at(-1).lineBreakAfter=true;return cs;
  };
  const label="Dense point registration", tail="sistent trajectories across keyframes.";
  const fig={id:11,page_idx:4,type:"image",bbox:[0,0,1000,1000],image_caption:["Fig. 2: Dense point registration yields consistent trajectories across keyframes."]};
  const chars=[...printed(label,155),...printed("Fig. 2: Dense point registration yields con-",95),...printed(tail,82)];
  const result=D.ParallelFrames.recover([fig],chars,[0,0,400,200]);
  const labels=result.items.filter(it=>it.type==="figure_label").map(it=>it.text);
  assert.ok(labels.includes(label),"an actual figure label may also occur in the caption");
  assert.ok(!labels.includes(tail),"punctuation after a hyphenated final caption line belongs to the caption");
}

{
  const source="The robot selects keypoints using both their confidence scores and their distance from previously selected points. If the measured distance falls below the threshold, the selection rejects that candidate even when its confidence is high.";
  const u={source,modelText:source,language:"zh",role:"text",rects:[[],[],[]]};
  const requests=[];
  await D.ParallelPage.translate([u],{language:"zh",request:async args=>{
    requests.push(args);
    const rows=JSON.parse(args.messages[0].content.split("\n")[1]);
    assert.equal("source_lines" in rows[0],false,"the translator receives content, not physical line counts");
    const translation=requests.length===1 ? "机器人选择关键点。" :
      "机器人根据候选点的置信度以及它与已选点的距离来选择关键点。如果测得距离低于阈值，即使该点置信度很高，也会拒绝这个候选点。";
    return {content:JSON.stringify({translations:[{id:rows[0].id,translation}]})};
  }});
  assert.equal(requests.length,2);
  assert.equal(requests[0].reasoningEffort,"low");
  assert.equal(JSON.parse(requests[1].messages[0].content.split("\n")[1])[0].repair_issue,"coverage");
  assert.match(requests[1].system,/coverage means Translate the entire passage/);
  assert.match(u.translation,/即使该点置信度很高/);
}

{
  const names = Array.from({length: 25}, () => "Mei Chen").join(", ");
  const source = "Engineering & Infra: " + names;
  const inline = D.ParallelInline.describe([], source, source, 10, "zh", null, false, false, {creditList:true});
  assert.equal(inline.tokens.length, 1);
  assert.equal(inline.tokens[0].display, names);
  assert.equal(D.ParallelPage.translationIssue({...inline, source}, "工程与基础设施：⟦D0⟧"), "");
}

{
  const printedLine = (text, x, y) => {
    const result = at(text, x, y);
    result.at(-1).lineBreakAfter = true;
    return result;
  };
  const diagram = D.ParallelPage.plan({
    view: [0, 0, 300, 240],
    items: [
      {
        type: "image",
        page_idx: 0,
        bbox: [90, 120, 930, 735],
        image_caption: ["Figure 2. A diagram with two labels."]
      }
    ],
    chars: [
      ...printedLine("Model input", 35, 160),
      ...printedLine("Model output", 170, 160),
      ...printedLine("Figure 2. A diagram with two labels.", 32, 72)
    ],
    nativeParser: true
  });
  const label = diagram.find((u) => u.source === "Model input");
  assert.equal(label?.visualOwner, "item:0");
  assert.ok(label.placed, "a PDF-native diagram label is allowed inside its own image");
  const makeRow = (cells, y) => {
    const glyphs = cells.flatMap((value, i) => at(value, [28, 142, 268][i], y));
    glyphs.at(-1).lineBreakAfter = true;
    return glyphs;
  };
  const caption = "Table 1. Runtime and memory results for the measured methods.";
  const table = D.ParallelPage.plan({
    view: [0, 0, 360, 260],
    items: [{ type: "table", page_idx: 0, bbox: [60, 400, 940, 715], table_caption: [caption] }],
    chars: [
      ...makeRow(["Method", "Runtime", "Memory"], 218),
      ...makeRow(["Baseline", "1.70", "24.8"], 203),
      ...makeRow(["Proposed", "1.40", "18.2"], 188),
      ...printedLine(caption, 27, 148)
    ],
    nativeParser: true
  });
  const headers = table.filter((u) => u.role === "table_label");
  assert.deepEqual(
    Array.from(headers, (u) => u.source),
    ["Method", "Runtime", "Memory"]
  );
  assert.ok(headers.every((u) => u.placed && u.visualOwner === "item:0"));
  assert.ok(
    !table.some((u) => u.source === "1.70" || u.source === "24.8"),
    "keep numeric table cells verbatim"
  );
}

{
  const source = "User: In what year was the singer who popularized ‘I’ll Keep the Lovelight Burning’ born?";
  const unit = {source,modelText:"**User**"+source.slice(4),language:"zh",tokens:[]};
  assert.ok(D.ParallelInline.valid(unit,"**用户**：唱红《I’ll Keep the Lovelight Burning》的歌手出生于哪一年？"));
  assert.ok(!D.ParallelInline.valid(unit,"**User**: In what year was the singer who popularized ‘I’ll Keep the Lovelight Burning’ born?"));
  assert.ok(!D.ParallelInline.valid(unit,"**用户**：In what year was the singer who popularized《I’ll Keep the Lovelight Burning》出生？"));
}
