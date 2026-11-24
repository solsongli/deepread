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
const conflict = D.ParallelPage.plan({...opts,items:[frame,{id:5,type:'equation',bbox:[120,110,160,145]}]});
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
assert.ok(D.ParallelInline.valid(emph,'**结果。** 我们采用*滚动控制*。'));
assert.ok(!D.ParallelInline.valid(emph,'**结果。我们采用滚动控制。**'));
const glyphs = (str) => Array.from(str,(u,i)=>({u,rect:[i*5,20,i*5+5,30],fontSize:10,baseline:22,fontName:'Times-Roman'}));
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

// The table separating the two halves of this sentence resides on page 2.
const line = (bbox, value) => ({bbox, spans:[{type:'text',content:value}]});
const head = line([10,85,90,95],'The measurements depend on the');
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
console.log('parallelPage: cross-page physical fragments, bibliography, TeX faces, accents and table label ownership passed');
const dates=describe('Retrieved July 22, 2018, after 19 July 2018.');
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
const bitmap={width:80,height:30,data:new Uint8ClampedArray(80*30*4).fill(255)};
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
const tocRows=[
  atY('A Alpha methods . . . . 10',8,150),
  atY('B Other results . . . . 12',8,135),
  atY('C More examples . . . . 14',8,120)
];
const flatToc=tocRows.map(r=>r.map(c=>c.u).join('')).join(' ');
const tocPlan=D.ParallelPage.plan({view:hv,chars:tocRows.flat(),items:[{id:20,type:'text',text:flatToc,bbox:[0,160,1000,420]}]});
assert.deepEqual(Array.from(tocPlan,u=>u.source),['Alpha methods','Other results','More examples']);
assert.ok(tocPlan.every(u=>u.placed && u.rect[2]<120 && u.rect[0]>10),'destination numbers and leader dots keep their own ink');

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
