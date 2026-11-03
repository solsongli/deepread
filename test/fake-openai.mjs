#!/usr/bin/env node
// Fake OpenAI-compatible server that answers DeepRead pipeline prompts with valid structured output.
// Usage: node test/fake-openai.mjs [--port 18766] [--no-json-schema] [--delay-ms N]
import http from 'node:http';

const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argv('port', 18766));
const NO_SCHEMA = args.includes('--no-json-schema');
const DELAY = Number(argv('delay-ms', 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = '[\\u201c\\u201d"]'; // curly or straight quotes

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join('\n');
  }
  return '';
}

function detect(t) {
  if (/Guide source \(Markdown\):/.test(t)) return 'guide';
  if (/Paper \(Markdown\):/.test(t)) return 'guideApi';
  if (/Figures to explain \(JSON\):/.test(t)) return 'figures';
  if (/Paper blocks for the glossary \(JSON\):/.test(t)) return 'glossary';
  if (/Question to answer:/.test(t) && /Paper blocks \(JSON\):/.test(t)) return 'ask';
  if (/Paper blocks \(JSON\):/.test(t)) return 'questions';
  if (/Paragraphs to explain \(JSON\):/.test(t)) return 'explain';
  if (/article_summary field|包含 article_summary 字段/.test(t)) return 'article_summary';
  if (/outline field|包含 outline 字段/.test(t)) return 'outline';
  if (/point_split/.test(t) && /(Paragraph list|段落列表):/.test(t)) return 'page';
  if (/(filter out|过滤)/.test(t) && /(Paragraph list|段落列表)/.test(t)) return 'filter';
  return 'chat';
}

// ---- page summaries ----
function parsePageParagraphs(t) {
  const re = new RegExp('\\{\\s*id:\\s*' + Q + '([^\\u201c\\u201d"]+)' + Q + ',\\s*sentences:\\s*\\[\\n([\\s\\S]*?)\\n\\]\\s*\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const idxs = [];
    const texts = [];
    for (const line of m[2].split('\n')) {
      const lm = line.match(/^\s*\[(\d+)\]\s+(".*")\s*$/);
      if (!lm) continue;
      idxs.push(Number(lm[1]));
      try { texts.push(JSON.parse(lm[2])); } catch { texts.push(lm[2]); }
    }
    out.push({ id: m[1], n: idxs.length ? Math.max(...idxs) + 1 : 0, texts });
  }
  return out;
}
// Chinese-looking stand-in translation, about as long as a real one (~1 CJK char per 3 source chars).
const ZH = '本文提出的方法通过注意力机制直接建模序列中任意两个位置之间的依赖关系，不再依赖循环结构，因此可以在训练时充分并行，并在机器翻译任务上取得更好的效果';
function zhLike(source, k) {
  const n = Math.max(8, Math.round(String(source).length / 3.2));
  let out = '';
  while (out.length < n) out += ZH;
  out = out.slice(0, n).replace(/[，。]$/, '');
  return (k === 1 ? out.slice(0, Math.floor(n / 2)) + '，其复杂度为 $O(n^2 \\cdot d)$，' + out.slice(Math.floor(n / 2)) : out) + '。';
}

function buildPage(t) {
  const paras = parsePageParagraphs(t);
  const paragraphs = paras.map((p) => {
    const split = [];
    for (let i = 0; i < p.n; i += 2) split.push(i + 1 < p.n ? [i, i + 1] : [i]);
    return {
      id: p.id,
      paragraph_summary: `Fake summary of ${p.id}`,
      importance_level: 2,
      point_split: split,
      point_summaries: split.map((g, i) => `Fake point ${i + 1} of ${p.id}`),
      point_translations: split.map((g, i) => (i === 0 ? '【译】' : '') + g.map((k) => zhLike(p.texts[k] || '', k)).join('')),
    };
  });
  return { obj: { paragraphs }, info: `paragraphs=${paras.length}` };
}

// ---- sections JSON (article summary / outline) ----
function parseSections(t) {
  const marker = /(Paper sections JSON data:|论文 sections JSON 数据：)/;
  const mm = marker.exec(t);
  if (!mm) return [];
  const rest = t.slice(mm.index + mm[0].length);
  const start = rest.indexOf('[');
  const end = rest.lastIndexOf(']');
  try { return JSON.parse(rest.slice(start, end + 1)); } catch { return []; }
}
function summaryTitles(t) {
  // The "Output Format" example lists the 5 exact titles in order as “title”: “X”
  const cut = Math.max(t.lastIndexOf('Return strictly in JSON format'), t.lastIndexOf('严格返回 JSON 格式'));
  const seg = t.slice(cut >= 0 ? cut : 0);
  const re = new RegExp(Q + 'title' + Q + ':\\s*' + Q + '([^\\u201c\\u201d"]+)' + Q, 'g');
  const out = [];
  let m;
  while ((m = re.exec(seg)) && out.length < 5) out.push(m[1]);
  if (out.length < 5) return ['Paper Title', 'Research Background', 'Core Innovations', 'Experimental Results', 'Conclusions'];
  return out;
}
function buildArticle(t) {
  const sections = parseSections(t);
  const [tPaper, tBg, tInn, tExp, tConc] = summaryTitles(t);
  const ids = [];
  for (const s of sections) for (const b of s.blocks || []) if (typeof b.block_id === 'number') ids.push(b.block_id);
  const pick = (from, n) => ids.slice(from, from + n);
  const title = (sections[0] && sections[0].title) || 'Fake Paper';
  const obj = { article_summary: [
    { title: tPaper, content: title, points: [] },
    { title: tBg, content: 'Fake background: the paper addresses a sequence modelling problem.', points: [] },
    { title: tInn, content: '', points: [
      { point_title: 'Fake innovation A', content: 'Fake description of the first contribution.', block_ids: pick(0, 6) },
      { point_title: 'Fake innovation B', content: 'Fake description of the second contribution.', block_ids: pick(6, 6) } ] },
    { title: tExp, content: '', points: [
      { point_title: 'Fake experiment A', content: 'Fake key setup and result.', block_ids: pick(12, 6) },
      { point_title: 'Fake experiment B', content: 'Fake ablation result.', block_ids: pick(18, 6) } ] },
    { title: tConc, content: 'Fake conclusion: the approach is effective.', points: [] },
  ] };
  return { obj, info: `sections=${sections.length} blocks=${ids.length}` };
}
function levelOf(title, idx) {
  const m = /^\s*(\d+(?:\.\d+)*)\.?\s/.exec(title);
  if (m) return m[1].split('.').length;
  return idx === 0 ? 0 : 1;
}
function buildOutline(t) {
  const sections = parseSections(t);
  const root = { title: (sections[0] && sections[0].title) || 'Fake Paper', title_block_id: sections[0] ? sections[0].title_block_id : 0, level: 0, summary: 'Fake root summary', children: [] };
  const stack = [root];
  sections.forEach((s, i) => {
    if (i === 0) return;
    const lvl = Math.max(1, levelOf(String(s.title), i));
    const node = { title: s.title, title_block_id: s.title_block_id, level: lvl, summary: `Fake summary of ${s.title}`, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= lvl) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  return { obj: { outline: root }, info: `sections=${sections.length}` };
}

const ROLES = ['background', 'gap', 'prior', 'contribution', 'method', 'result', 'limitation'];
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

// ---- figure reading guides ----
function buildFigures(t) {
  const m = /Figures to explain \(JSON\):\s*(\{.*\})/.exec(t);
  let figs = [];
  try { figs = JSON.parse(m[1]).figures || []; } catch { /* keep empty */ }
  const out = figs.map((f, i) => ({
    id: String(f.id),
    title: `${f.label || f.id}：阅读指南`,
    steps: [
      { text: `先看${f.label || '该图表'}的整体结构，对照图注弄清各部分分别表示什么。`, panel: null },
      { text: i % 2 === 0 ? '再看 (b) 子图中的关键对比，注意 **趋势** 的变化。' : '再对比关键行与列，注意加粗的最优结果。', panel: i % 2 === 0 ? 'b' : null },
      { text: '最后结合正文，理解这一结果支持了论文的哪个结论。', panel: null },
    ],
  }));
  return { obj: { figures: out }, info: `figures=${figs.length}` };
}

// ---- paragraph explanations ("AI 讲解") ----
function buildExplain(t) {
  const m = /Paragraphs to explain \(JSON\):\s*(\{.*\})/.exec(t);
  let items = [];
  try { items = JSON.parse(m[1]).items || []; } catch { /* keep empty */ }
  const textFor = (key) => {
    let text = `这一段（${key}）讲的是作者如何用更直接的方式解决前文提到的问题。可以把它理解为整篇论文论证链条中的一环，后面的实验正是为了验证这里的说法。`;
    if (/_2$/.test(key)) text += ` 其中的 **自注意力** 需要对每一对位置计算一次，因此复杂度为 $O(n^2)$。`;
    return text;
  };
  if (/"cards"/.test(t)) {
    // grouped mode: merge the first two items of a batch with >= 3 items
    const cards = [];
    for (let i = 0; i < items.length; i++) {
      const merge = i === 0 && items.length >= 3;
      const keys = merge ? [String(items[0].key), String(items[1].key)] : [String(items[i].key)];
      if (merge) i++;
      cards.push({ keys, role: ROLES[hash(keys[0]) % 7], title: `Fake title of ${keys[0]}`, explanation: textFor(keys[0]) });
    }
    return { obj: { cards }, info: `items=${items.length} cards=${cards.length}` };
  }
  const explanations = items.map((it) => {
    const key = String(it.key);
    return { key, explanation: textFor(key), role: ROLES[hash(key) % 7] };
  });
  return { obj: { explanations }, info: `items=${items.length}` };
}

// ---- question-led reading, free questions, glossary ----
function requestBlocks(t) {
  const m = /Paper blocks(?: for the glossary)? \(JSON\):\s*(\{.*\})/.exec(t);
  try { return JSON.parse(m[1]).blocks || []; } catch { return []; }
}

function buildQuestions(t) {
  const keys = requestBlocks(t).map((b) => String(b.key));
  const std = ['这篇论文要解决什么问题？', '方法的核心是什么？', '关键设计有哪些？', '证据是否充分？', '局限是什么？'];
  const questions = std.map((q, i) => ({
    id: 'q' + (i + 1),
    question: q,
    answer: `（fake）针对“${q}”：作者给出了清晰的论述，详见相关段落。**自注意力** 是其中的关键。`,
    keys: keys.length ? [...new Set([keys[i % keys.length], keys[(i + 1) % keys.length]])].slice(0, i % 2 + 1) : [],
  }));
  return { obj: { questions }, info: `blocks=${keys.length}` };
}

function buildAsk(t) {
  const keys = requestBlocks(t).map((b) => String(b.key));
  return { obj: { answer: '（fake）论文在相关段落中回答了这个问题：核心思路是用注意力替代循环结构。', keys: keys.slice(0, 2) }, info: `blocks=${keys.length}` };
}

function buildGlossary(t) {
  const keys = requestBlocks(t).map((b) => String(b.key));
  const k = (i) => keys[Math.min(i, keys.length - 1)] || '';
  return {
    obj: {
      symbols: [
        { symbol: 'd_k', forms: ['dk', 'd_k'], meaning: '键向量的维度，用于缩放点积。', key: k(0) },
        { symbol: 'QK^T', forms: ['QKT', 'QK^T'], meaning: '查询与键的点积矩阵。', key: k(1) },
      ],
      terms: [
        { term: 'self-attention', aliases: ['intra-attention'], definition: '序列内每个位置都与其他位置计算相关性的注意力机制。', key: k(0) },
        { term: 'Transformer', aliases: [], definition: '完全基于注意力的序列转换模型架构。', key: k(1) },
        { term: 'multi-head attention', aliases: [], definition: '并行运行多组注意力并拼接结果。', key: k(2) },
      ],
    },
    info: `blocks=${keys.length}`,
  };
}

// ---- guided reading (带读): Stage A via API, Stage B structure ----
function buildGuideApi(t) {
  const card = ['基本信息', '一句话总结', '研究问题', '背景与脉络', '核心痛点', '核心想法', '方法概览', '模块拆解', '关键公式', '证据链', '结论的正确读法', '作者自述局限', '批判性分析', '我学到了什么', '与已有知识的联系', '研究想法']
    .map((n, i) => `## ${String(i + 1).padStart(2, '0')} ${n}\n\n（fake）${n}：见 [p. 1 ¶${(i % 3) + 1}]。`).join('\n\n');
  const xray = '# （fake）论文 X 光\n\n## 研究路径\n\n作者认为循环结构限制了并行 [p. 1 ¶2]，因此改用注意力 [p. 1 ¶3]。\n\n## 证据边界\n\n实验只覆盖机器翻译，可能 (likely) 不能推广 [p. 1 ¶1]。';
  return { obj: { xray, card }, info: `chars=${t.length}` };
}

function buildGuide(t) {
  const keys = requestBlocks(t).map((b) => String(b.key));
  const k = (i) => (keys.length ? [keys[Math.min(i, keys.length - 1)]] : []);
  const obj = {
    type: 'algorithmic',
    position: {
      claim: '（fake）作者主张用注意力取代循环结构，在翻译任务上更好且更易并行。',
      path: [
        { step: '什么失效了', text: '循环结构难以并行。', basis: 'source', keys: k(0) },
        { step: '作者押了什么', text: '只用注意力建模依赖。', basis: 'source', keys: k(1) },
        { step: '押注靠什么撑住', text: '翻译实验与消融。', basis: 'inference', keys: k(2) },
      ],
      focus: ['消融是否公平', '训练预算'],
      order: [{ text: '方法部分', minutes: 10, keys: k(1) }, { text: '实验部分', minutes: 15, keys: k(2) }],
      questions: ['为什么注意力足够？', '消融证明了什么？', '能否推广到其他任务？'],
    },
    skeleton: {
      moves: [
        { role: 'gap', text: '循环模型难以并行。', keys: k(0), status: 'proven' },
        { role: 'contribution', text: '提出 Transformer。', keys: k(1), status: 'proven' },
        { role: 'claim', text: '效果更好且训练更快。', keys: k(2), status: 'partial' },
        { role: 'limitation', text: '仅在翻译上验证。', keys: [], status: 'unproven' },
      ],
      terms: [{ term: 'self-attention', translation: '自注意力', variants: ['intra-attention'] }],
    },
    method: {
      components: [
        { name: '自注意力', verdict: 'load-bearing', basis: '消融中去掉后明显下降。', keys: k(1) },
        { name: '多头', verdict: 'contributing', basis: '头数消融有小幅增益。', keys: k(2) },
        { name: '位置编码形式', verdict: 'decorative', basis: '两种形式结果接近。', keys: k(0) },
      ],
      insight: { surface: '用注意力替代循环', core: '任意两位置直接交互', transferable: '可用于其他序列任务' },
      formulas: [{
        latex: '\\mathrm{softmax}(QK^T/\\sqrt{d_k})V',
        purpose: '缩放点积注意力',
        symbols: [{ symbol: 'd_k', shape: 'scalar', meaning: '键维度' }],
        example: '取 $d_k=4$，得分 $[2,0]$，缩放后 $[1,0]$，softmax 约为 $[0.73,0.27]$。',
        keys: k(1),
      }],
    },
    evidence: {
      chain: [
        { claim: '效果更好', evidence: 'WMT BLEU 提升', supports: '翻译任务', notSupports: '其他任务', status: 'proven', keys: k(2) },
        { claim: '训练更快', evidence: '只报告了训练成本', supports: '同等硬件', notSupports: '一般结论', status: 'partial', keys: k(2) },
        { claim: '可推广', evidence: '无', supports: '', notSupports: '', status: 'unproven', keys: [] },
      ],
      checks: [{ text: '基线预算是否一致？', effect: 'weakens', state: 'open' }],
      hedges: [{ quote: 'likely', strength: 'speculative', note: '作者对原因的推测。', keys: k(0) }],
    },
    takeaway: {
      summary: '（fake）注意力足以替代循环结构，但证据仅限翻译。',
      learned: ['并行性是关键', '消融要看预算'],
      ideas: [
        { title: '换任务验证', basis: '证据边界', hypothesis: '在其他任务上同样成立', test: '跑一个新任务', risk: '可能不成立' },
        { title: '简化位置编码', basis: '装饰性组件', hypothesis: '可以去掉', test: '消融', risk: '长序列退化' },
      ],
    },
  };
  return { obj, info: `blocks=${keys.length}` };
}

// ---- author filter: keep everything ----
function buildFilter() { return { obj: { indices: [] }, info: 'keep all' }; }

function chatAnswer() {
  return 'This is a fake answer. The attention weights are computed as $E=mc^2$ style scaled dot products (p. 2).\n\n- point one\n- point two';
}

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url, 'http://x');
  const log = (code, extra) => console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} -> ${code} ${extra || ''}`);
  if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
    log(200);
    return send(res, 200, { object: 'list', data: [{ id: 'fake', object: 'model', owned_by: 'fake' }] });
  }
  if (req.method === 'POST' && /\/chat\/completions$/.test(url.pathname)) {
    let body;
    try { body = JSON.parse(raw); } catch { log(400, 'bad json'); return send(res, 400, { error: { message: 'invalid JSON body' } }); }
    if (DELAY) await sleep(DELAY);
    const rfType = body.response_format && body.response_format.type;
    if (NO_SCHEMA && rfType === 'json_schema') {
      log(400, 'rejected response_format json_schema');
      return send(res, 400, { error: { message: 'response_format json_schema is not supported by this server', type: 'invalid_request_error', param: 'response_format' } });
    }
    const text = lastUserText(body.messages || []);
    const systemText = (body.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
    let kind = detect(text);
    if (kind === 'chat' && /"question"/.test(systemText) && /"answer"/.test(systemText)) kind = 'flashcard';
    let content, info = '';
    if (kind === 'chat') content = chatAnswer();
    else if (kind === 'flashcard') {
      content = JSON.stringify({ question: '这段话为什么重要？(fake)', answer: '因为它提出了 **注意力** 机制，复杂度为 $O(n^2)$。(fake)' });
    }
    else {
      const r = { page: buildPage, article_summary: buildArticle, outline: buildOutline, filter: buildFilter, explain: buildExplain, figures: buildFigures, questions: buildQuestions, ask: buildAsk, glossary: buildGlossary, guideApi: buildGuideApi, guide: buildGuide }[kind](text);
      content = JSON.stringify(r.obj);
      info = r.info;
    }
    log(200, `type=${kind} stream=${!!body.stream} ${info}`);
    const id = 'chatcmpl-fake';
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const parts = content.match(/.{1,24}/gs) || [''];
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      for (const p of parts) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake', choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
        if (DELAY) await sleep(Math.min(DELAY, 50));
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return send(res, 200, { id, object: 'chat.completion', created, model: body.model || 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 } });
  }
  log(404);
  send(res, 404, { error: { message: 'not found' } });
}).listen(PORT, '127.0.0.1', () => console.log(`fake-openai listening on http://127.0.0.1:${PORT}/v1${NO_SCHEMA ? ' (no json_schema)' : ''}`));
