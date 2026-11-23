// Source frame ownership, protected graphics and reuse of physical translations.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const scope = vm.createContext({ DeepRead: { bilingual: (zh) => zh } });
const load = (file) => vm.runInContext(readFileSync(new URL('../addon/content/' + file, import.meta.url), 'utf8'), scope);
load('lib/retainpdf/rendering/rects.js');
for (const name of ['services/typography','services/translationLayout','services/continuations','reader/overlay','services/parallelInline','services/parallelPage']) load('scripts/' + name + '.js');
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
const pending = Array.from({length:6},(_,i)=>({source:`Paragraph ${i}`,styled:`Paragraph ${i}`,translation:''}));
let calls=0;
await assert.rejects(D.ParallelPage.translate(pending,{language:'zh',signal:new AbortController().signal,request:async (args)=>{
  const list=JSON.parse(args.messages[0].content.split('\n').slice(1).join('\n'));calls++;
  return {content:JSON.stringify({translations:calls===2?[]:list.map(row=>({id:row.id,translation:'译文'}))})};
}}));
assert.equal(calls,2);assert.ok(pending.every(u=>u.translation===''),'a failed page cannot claim completion after a successful first batch');
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
  assert.deepEqual(sizes,[2,1]);
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
