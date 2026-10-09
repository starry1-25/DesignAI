'use strict';

/**
 * 绘职 AI · 云端 AI 代理（Vercel Serverless Function）
 *
 * 把原先由本地 server.ps1 提供的 /api/* 端点搬到云端，供 GitHub Pages 上的静态站点调用。
 * 与 server.ps1 是 1:1 移植：规划 / 生成 / 微调 / 重新生成四个阶段、HTML 净化流水线、
 * 错误码与记录投影都保持一致；密钥只从 Vercel 项目环境变量读取，绝不出现在前端代码里。
 *
 * 与本地版唯一的架构差异是「存储」：
 *   Vercel 函数没有可写的持久化文件系统，历史记录改用模块级内存数组实现。
 *   ⚠ 冷启动会清空该数组，且多个并发实例之间互不共享 —— 刷新/扩容后历史可能"变小"。
 *   这是纯前端部署的已知取舍，不引入数据库或任何第三方服务。
 */

const fs = require('fs');
const path = require('path');

/* ---------------- 配置（仅来自环境变量，与 server.ps1 的 Get-Cfg 对应） ---------------- */

const API_KEY = process.env.AGNES_API_KEY || '';
// baseUrl 保留原样（health 会原样回显），拼接前才去尾斜杠
const BASE_URL = process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1';
const TEXT_MODEL = process.env.AGNES_TEXT_MODEL || 'agnes-3.0-flash';
const MAX_TOKENS = parseInt(process.env.AGNES_MAX_TOKENS || '4096', 10) || 4096;
// 生成的页面远长于提示词，代码阶段单独给预算；推理模型还会先花 token 输出 reasoning_content
const HTML_MAX_TOKENS = parseInt(process.env.AGNES_HTML_MAX_TOKENS || '12288', 10) || 12288;

// 只在这几种状态下重试（server.ps1 的白名单，另加 1305）
const RETRYABLE = [429, 500, 502, 503, 504, 1305];
const BACKOFF_SEC = [5, 10];

/* 本函数允许自己占用的总墙钟预算（秒）。必须小于 vercel.json 里的 maxDuration，
   留出几秒把错误写成正常 JSON 再返回。Hobby 计划上限 60s，Pro 可到 300s：
   升级后只需在 Vercel 环境变量里把 FN_BUDGET_SEC 调大，并把 maxDuration 同步调大。 */
const FN_BUDGET_SEC = Math.max(10, parseInt(process.env.FN_BUDGET_SEC || '58', 10) || 58);

// ratio -> 生成页面必须铺满的画布（CSS 像素），与 server.ps1 的 $script:RatioCanvas 完全一致
const RATIO_CANVAS = {
  '1:1':  { label: '1200x1200', w: 1200, h: 1200 },
  '16:9': { label: '1600x900',  w: 1600, h: 900  },
  '9:16': { label: '900x1600',  w: 900,  h: 1600 },
  '4:3':  { label: '1400x1050', w: 1400, h: 1050 }
};
const RATIOS = ['1:1', '16:9', '9:16', '4:3'];

/** 允许调用本代理的前端来源；无 Origin（同源/服务调用）时直接放行 */
const ALLOWED_ORIGINS = [
  'https://starry1-25.github.io',
  'http://localhost:8230',
  'http://127.0.0.1:8230'
];

/* ---------------- 记录存储（内存，见文件头说明） ---------------- */

const MAX_RECORDS = 50;
let records = [];

function getRecordById(id) {
  for (const r of records) { if (r.id === id) { return r; } }
  return null;
}

function addRecord(rec) {
  records.push(rec);
  // 保留最近 50 条，避免函数实例常驻内存无限增长
  if (records.length > MAX_RECORDS) { records = records.slice(-MAX_RECORDS); }
}

function removeRecord(id) {
  records = records.filter(r => r.id !== id);
}

function clearRecords() {
  records = [];
}

/* ---------------- 工具 ---------------- */

function normalizeBaseUrl(url) {
  if (url == null) { return ''; }
  const s = String(url).trim();
  return s.replace(/\/+$/, ''); // 等价于 PowerShell TrimEnd('/')
}

function getCanvas(ratio) {
  return RATIO_CANVAS[ratio] || RATIO_CANVAS['1:1'];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** yyyy-MM-dd HH:mm:ss（本地时间），对应 Get-NowIso */
function nowIso() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** g + yyMMddHHmmss + 3 位随机数，对应 New-RecordId（Get-Random 100..998） */
function newRecordId() {
  const d = new Date();
  const rand = Math.floor(Math.random() * (999 - 100)) + 100;
  return 'g' + pad2(d.getFullYear() % 100) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + rand;
}

/** 6 位随机数 + '-' + .NET ticks，对应 New-VariationSeed */
function newVariationSeed() {
  const rand = Math.floor(Math.random() * (999999 - 100000)) + 100000;
  // .NET DateTime.Ticks = 自 0001-01-01 起的 100ns 数
  const ticks = (Date.now() + 62135596800000) * 10000;
  return rand + '-' + ticks;
}

/** 纯字符串替换 {key}，对应 Fill-Template（用 split/join 避免值里出现正则元字符） */
function fillTemplate(template, vars) {
  let out = String(template == null ? '' : template);
  for (const k of Object.keys(vars)) {
    out = out.split('{' + k + '}').join(String(vars[k] == null ? '' : vars[k]));
  }
  return out;
}

/** 取 body 里的字符串字段，空值回退默认，对应 Get-Step */
function step(body, name, def) {
  if (body == null) { return def; }
  const v = body[name];
  if (v == null) { return def; }
  const s = String(v);
  if (s === '') { return def; }
  return s;
}

function asString(v) { return v == null ? '' : String(v); }

/** 从 variationDirections 里随机取 count 条不重复，逐行 '- ' 开头换行连接 */
function getRandomDirections(config, count) {
  const pool = (config && config.shared && config.shared.variationDirections) || [];
  const picked = [];
  let guard = 0;
  while (picked.length < count && guard < 100) {
    guard++;
    const c = pool[Math.floor(Math.random() * pool.length)];
    if (picked.indexOf(c) < 0) { picked.push(c); }
  }
  return picked.map(p => '- ' + p).join('\n');
}

/** 解析模型返回的 JSON（可能带 ``` 围栏与前后说明），对应 Parse-LlmJson */
function parseLlmJson(text) {
  if (!text) { return null; }
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*/, '');
    t = t.replace(/```\s*$/, '');
    t = t.trim();
  }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { t = t.substring(i, j + 1); }
  try { return JSON.parse(t); } catch (e) { return null; }
}

/* ---------------- 岗位配置 ---------------- */

/** 读取与函数同目录的 roles.json（Vercel 根目录为 serverless/，读不到上级 data/） */
function readRoles() {
  const raw = fs.readFileSync(path.join(__dirname, 'roles.json'), 'utf8');
  return JSON.parse(raw);
}

function getRole(config, roleId) {
  for (const r of config.roles) { if (r.id === roleId) { return r; } }
  return config.roles[0];
}

/* ---------------------------------------------------------------- HTML 净化流水线 */
/* 模型返回整页 HTML，下面把原始文本变成可安全塞进 <iframe srcdoc> 的文档。 */

/** 去掉 ```html 围栏与文档前后的说明文字，对应 Get-HtmlPayload */
function getHtmlPayload(text) {
  if (!text || !String(text).trim()) { return ''; }
  let h = String(text).trim();
  h = h.replace(/^```[a-zA-Z]*\s*/, '');
  h = h.replace(/```\s*$/, '');
  h = h.trim();

  let i = h.toLowerCase().indexOf('<!doctype');
  if (i < 0) { i = h.toLowerCase().indexOf('<html'); }
  if (i > 0) { h = h.substring(i); }

  const j = h.toLowerCase().lastIndexOf('</html>');
  if (j >= 0) { h = h.substring(0, j + 7); }
  return h.trim();
}

/** 删除可执行/远程内容，对应 Remove-UnsafeHtml（十六进制色值刻意保留：那是设计系统） */
function removeUnsafeHtml(html) {
  if (!html || !String(html).trim()) { return ''; }
  let h = String(html);
  h = h.replace(/<script\b[^>]*>.*?<\/script\s*>/gis, '');
  h = h.replace(/<\/?script\b[^>]*>/gis, '');
  // input / button 刻意不删：在 sandbox="" 的 iframe 里它们是无害的，却是原型里
  // 唯一能渲染真实输入框（含占位符）与按钮的方式。删掉它们会导致占位符与按钮样式凭空消失。
  h = h.replace(/<\/?(iframe|frame|frameset|object|embed|applet|base|link|meta|form|audio|video|source|track)\b[^>]*>/gis, '');
  h = h.replace(/\son[a-z]+\s*=\s*"[^"]*"/gis, '');
  h = h.replace(/\son[a-z]+\s*=\s*'[^']*'/gis, '');
  h = h.replace(/\son[a-z]+\s*=\s*[^\s>]+/gis, '');
  h = h.replace(/javascript\s*:/gi, '');
  h = h.replace(/vbscript\s*:/gi, '');
  h = h.replace(/@import[^;]*;/gis, '');
  h = h.replace(/url\(\s*['"]?\s*https?:\/\/[^)]*\)/gi, 'none');
  return h;
}

/** 只清洗可见文本节点，对应 Clear-PlaceholderText（属性值绝不触碰，否则 color:#00E5FF 会失效） */
function clearPlaceholderText(html) {
  if (!html || !String(html).trim()) { return ''; }
  const styleBag = [];
  // 先把 <style> 整体抽走保护，避免 CSS 里的色值被清洗
  const protectedHtml = String(html).replace(/<style\b[^>]*>.*?<\/style\s*>/gis, (m) => {
    styleBag.push(m);
    return '@@HZSTYLE' + (styleBag.length - 1) + '@@';
  });
  const cleaned = protectedHtml.replace(/>([^<]*)</gs, (m, t) => {
    let s = t;
    // 被当成文字显示的十六进制色值，如 #1A2B44 / #00C4B4 / #FFF
    s = s.replace(/(?<![0-9A-Za-z_])#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z_])/g, '');
    // lorem ipsum 类占位词
    s = s.replace(/\b(lorem|ipsum|dolor|consectetur|adipiscing|elit|eiusmod|tempor|incididunt|labore|dolore|magna|aliqua|placeholder|sample)\b/gi, '');
    s = s.replace(/[ \t]{2,}/g, ' ');
    return '>' + s + '<';
  });
  let out = cleaned;
  for (let i = 0; i < styleBag.length; i++) {
    out = out.split('@@HZSTYLE' + i + '@@').join(styleBag[i]);
  }
  return out;
}

/** 完整流水线：剥围栏 -> 净化 -> 清文本 -> 保证是完整文档，对应 ConvertTo-SafeHtml */
function toSafeHtml(raw) {
  let h = getHtmlPayload(raw);
  if (!h || !h.trim()) { return ''; }
  h = removeUnsafeHtml(h);
  h = clearPlaceholderText(h);

  // 注入 reset，避免 body 默认边距与滚动条；放在模型样式前，模型仍可覆盖
  const reset = '<style id="hz-reset">html,body{margin:0;padding:0;box-sizing:border-box}' +
    '*,*::before,*::after{box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden}</style>';
  // 用 <head\b 词边界匹配，否则会误匹配 <header> 把样式注进 header 里
  if (/<head\b[^>]*>/i.test(h)) {
    h = h.replace(/<head\b([^>]*)>/i, '<head$1><meta charset="utf-8">' + reset);
  } else {
    h = '<!doctype html><html><head><meta charset="utf-8">' + reset + '</head><body>' + h + '</body></html>';
  }
  return h;
}

/* ---------------- 上游调用（对应 Invoke-AgnesPost + Invoke-ChatCompletion） ---------------- */

/** POST 到 Agnes 的 /chat/completions，带超时、重试与错误分类 */
async function agnesPost(apiPath, payload, maxAttempts, timeoutSec) {
  const root = normalizeBaseUrl(BASE_URL);
  if (!root) {
    return { ok: false, status: 0, body: '', ms: 0, attempts: 0, msg: 'no_base_url' };
  }
  const url = root + apiPath;
  let lastStatus = 0;
  let lastMsg = '';

  // Vercel 会按 maxDuration 强杀函数，被杀时浏览器只看到连接被重置。
  // 因此这里把「单次超时 × 尝试次数 + 退避」压进函数总预算内，宁可自己
  // 提前返回一个语义明确的 504 JSON，也不要被平台中途掐断。
  const perCall = Math.max(5, Math.min(timeoutSec, FN_BUDGET_SEC - 3));
  let maxTry = 0;
  let used = 0;
  for (let i = 0; i < maxAttempts; i++) {
    const need = perCall + (i > 0 ? BACKOFF_SEC[Math.min(i - 1, BACKOFF_SEC.length - 1)] : 0);
    if (used + need > FN_BUDGET_SEC) { break; }
    used += need; maxTry++;
  }
  maxTry = Math.max(1, maxTry);
  if (maxTry < maxAttempts || perCall < timeoutSec) {
    console.log('[api] budget path=' + apiPath + ' budget=' + FN_BUDGET_SEC + 's -> perCall=' + perCall + 's attempts=' + maxTry + '/' + maxAttempts);
  }

  for (let i = 1; i <= maxTry; i++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perCall * 1000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + API_KEY
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = await resp.text();
      const ms = Date.now() - started;

      if (!resp.ok) {
        const code = resp.status;
        lastStatus = code;
        lastMsg = (body || '').slice(0, 240) || ('HTTP ' + code);
        if (RETRYABLE.indexOf(code) >= 0 && i < maxTry) {
          const wait = BACKOFF_SEC[Math.min(i - 1, BACKOFF_SEC.length - 1)];
          console.log('[api] RETRY path=' + apiPath + ' attempt=' + i + ' status=' + code + ' wait=' + wait + 's');
          await sleep(wait * 1000);
          continue;
        }
        return { ok: false, status: code, body: body, ms: ms, attempts: i, msg: lastMsg, reason: '' };
      }
      return { ok: true, status: 200, body: body, ms: ms, attempts: i };
    } catch (err) {
      const ms = Date.now() - started;
      // 超时、DNS、连接、TLS 分别归类，让前端能提示到底修哪一项
      let code = 0;
      let reason = '';
      const message = (err && err.message) || '';
      const errno = (err && err.code) || '';
      if (err && err.name === 'AbortError') {
        code = 504;
      } else if (/ENOTFOUND|EAI_AGAIN/i.test(errno) || /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        code = 502; reason = 'dns';
      } else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i.test(errno)) {
        code = 502; reason = 'connect';
      } else if (/certificate|TLS|SSL|self.signed|CERT_/i.test(message)) {
        code = 502; reason = 'tls';
      } else {
        code = 502;
      }
      lastStatus = code;
      lastMsg = message || 'request failed';
      if (lastMsg.length > 240) { lastMsg = lastMsg.slice(0, 240); }
      if (RETRYABLE.indexOf(code) >= 0 && i < maxTry) {
        const wait = BACKOFF_SEC[Math.min(i - 1, BACKOFF_SEC.length - 1)];
        console.log('[api] RETRY path=' + apiPath + ' attempt=' + i + ' status=' + code + ' wait=' + wait + 's');
        await sleep(wait * 1000);
        continue;
      }
      return { ok: false, status: code, body: '', ms: ms, attempts: i, msg: lastMsg, reason: reason };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: lastStatus, body: lastMsg, ms: 0, attempts: maxTry, msg: lastMsg };
}

/** 文本补全。密钥缺失时返回失败对象（不抛错），让前端能解释情况而非报传输错误。 */
async function chatCompletion(prompt, system, temperature, maxTokens, maxAttempts, timeoutSec) {
  if (!API_KEY || !API_KEY.trim()) {
    return { ok: false, status: 0, attempts: 0, ms: 0, msg: 'no_api_key' };
  }
  const mt = (maxTokens > 0) ? maxTokens : MAX_TOKENS;
  const messages = (system && String(system).trim())
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  const payload = { model: TEXT_MODEL, messages: messages, temperature: temperature, max_tokens: mt };
  const r = await agnesPost('/chat/completions', payload, maxAttempts, timeoutSec);
  if (!r.ok) { return r; }

  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (e) { /* 非 JSON，走下面的形状校验 */ }
  if (parsed && parsed.choices && parsed.choices.length > 0) {
    const msg = parsed.choices[0].message || {};
    let content = asString(msg.content);
    // 推理模型可能把正文放在 reasoning_content 而 content 为空，必须回退，否则结果为空
    if (!content.trim() && msg.reasoning_content) {
      content = asString(msg.reasoning_content);
      console.log('[api] CHAT reasoning_content fallback used model=' + TEXT_MODEL);
    }
    r.content = content;
    if (parsed.choices[0].finish_reason) { r.finish = String(parsed.choices[0].finish_reason); }
  } else {
    r.ok = false;
    r.status = 502;
    r.msg = 'unexpected chat response shape';
  }
  return r;
}

/* ------------------------------------------------------------ 第 2 阶段：页面生成 */
async function htmlGeneration(brief, ratio, extra) {
  if (!API_KEY || !API_KEY.trim()) {
    return { ok: false, status: 0, attempts: 0, ms: 0, msg: 'no_api_key' };
  }
  const config = readRoles();
  const canvas = getCanvas(ratio);
  const prompt = fillTemplate(config.shared.htmlTemplate, {
    roleName: extra.roleName,
    styleGuide: extra.styleGuide,
    requirement: extra.requirement,
    designBrief: brief,
    ratio: ratio,
    canvasW: String(canvas.w),
    canvasH: String(canvas.h),
    seed: extra.seed
  });

  // 16KB 页面可能要 ~90s，代码阶段给更宽的单次预算且只重试 1 次（共 2 次尝试）
  const r = await chatCompletion(prompt, config.shared.systemPrompt, 0.7, HTML_MAX_TOKENS, 2, 150);
  if (!r.ok) { return r; }

  const html = toSafeHtml(r.content);
  if (!html || !html.trim() || html.length < 200) {
    r.ok = false; r.status = 502; r.msg = 'model returned no usable html';
    return r;
  }
  r.html = html;
  r.ratio = ratio;
  r.size = canvas.label;
  return r;
}

/* ---------------- 记录投影 ---------------- */

/** 公开投影：绝不把 designBrief（提示词工程）与 seed 下发给前端 */
function publicRecord(rec) {
  if (!rec) { return null; }
  return {
    id: rec.id,
    roleId: rec.roleId,
    roleName: rec.roleName,
    roleIndex: rec.roleIndex,
    requirement: rec.requirement,
    ratio: rec.ratio,
    title: rec.title,
    summary: rec.summary,
    visiblePrompt: rec.visiblePrompt,
    agentReply: rec.agentReply,
    keywords: rec.keywords,
    html: rec.html,
    size: rec.size,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    revisions: rec.revisions,
    messages: rec.messages
  };
}

/* ---------------- 各阶段 ---------------- */

// 第 1 阶段：模型把自然语言需求翻译成可直接交付的设计说明
async function planStage(body, res) {
  const config = readRoles();
  const role = getRole(config, step(body, 'roleId', 'pm'));
  const req = step(body, 'requirement', '');
  if (!req || !req.trim()) { writeFail(res, 'empty_requirement', 'requirement is required', 400); return; }

  // 画幅不再是用户选项：由模型根据需求自动选择，取回后再校验
  const seed = newVariationSeed();
  const prompt = fillTemplate(config.shared.plannerTemplate, {
    roleName: role.name,
    deliverable: role.deliverable,
    styleGuide: role.styleGuide,
    requirement: req,
    seed: seed,
    directions: getRandomDirections(config, 3)
  });

  console.log('[api] PLAN start role=' + role.id + ' seed=' + seed + ' reqLen=' + req.length);
  const llm = await chatCompletion(prompt, '', 1.0, 0, 3, 60);
  if (!llm.ok) { upstreamFail(res, llm, 'plan'); return; }

  const plan = parseLlmJson(llm.content);
  if (!plan || !plan.designBrief) {
    writeFail(res, 'plan_parse_failed', 'The model did not return a parsable plan.', 502);
    return;
  }

  // 自动适配画幅：未知或缺失的 ratio 回退到岗位默认
  let ratio = asString(plan.ratio);
  if (RATIOS.indexOf(ratio) < 0) { ratio = role.defaultRatio; }
  const canvas = getCanvas(ratio);

  const rec = {
    id: newRecordId(),
    roleId: role.id,
    roleName: role.name,
    roleIndex: role.index,
    requirement: req,
    ratio: ratio,
    size: canvas.label,
    seed: seed,
    title: asString(plan.title),
    summary: asString(plan.summary),
    visiblePrompt: asString(plan.visiblePrompt),
    designBrief: asString(plan.designBrief),
    agentReply: asString(plan.agentReply),
    keywords: plan.keywords == null ? [] : (Array.isArray(plan.keywords) ? plan.keywords : [plan.keywords]),
    html: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    revisions: [],
    messages: [
      { role: 'agent', text: asString(plan.agentReply), at: nowIso() },
      { role: 'user',  text: req,                      at: nowIso() }
    ]
  };
  addRecord(rec);

  console.log('[api] PLAN ok id=' + rec.id + ' ratio=' + ratio + ' size=' + canvas.label + ' ms=' + llm.ms);
  writeJson(res, { ok: true, record: publicRecord(rec) });
}

// 第 2 阶段：用记录里已定的画幅（不再接受前端传 ratio）生成 HTML 页面
async function renderStage(body, res) {
  const id = step(body, 'id', '');
  const rec = getRecordById(id);
  if (!rec) { writeFail(res, 'not_found', 'record ' + id + ' not found', 404); return; }
  if (!rec.designBrief || !String(rec.designBrief).trim()) {
    writeFail(res, 'missing_brief', 'record has no design brief', 400); return;
  }

  let ratio = asString(rec.ratio);
  if (RATIOS.indexOf(ratio) < 0) { ratio = '16:9'; }

  const config = readRoles();
  const role = getRole(config, rec.roleId);

  console.log('[api] RENDER start id=' + id + ' ratio=' + ratio);
  const gen = await htmlGeneration(rec.designBrief, ratio, {
    roleName: role.name,
    styleGuide: role.styleGuide,
    requirement: rec.requirement,
    seed: rec.seed
  });
  if (!gen.ok) { upstreamFail(res, gen, 'render'); return; }

  const rev = { at: nowIso(), ratio: gen.ratio, size: gen.size, html: gen.html, note: 'initial' };
  rec.html = gen.html;
  rec.ratio = gen.ratio;
  rec.size = gen.size;
  rec.revisions = (Array.isArray(rec.revisions) ? rec.revisions : []).concat([rev]);
  rec.updatedAt = nowIso();

  console.log('[api] RENDER ok id=' + id + ' ms=' + gen.ms + ' htmlLen=' + gen.html.length + ' finish=' + gen.finish);
  writeJson(res, { ok: true, record: publicRecord(rec) });
}

// 多轮微调：只重生成增量部分，其余全部保留
async function refineStage(body, res) {
  const id = step(body, 'id', '');
  const instruction = step(body, 'instruction', '');
  if (!instruction || !instruction.trim()) {
    writeFail(res, 'empty_instruction', 'instruction is required', 400); return;
  }

  const config = readRoles();
  const rec = getRecordById(id);
  if (!rec) { writeFail(res, 'not_found', 'record ' + id + ' not found', 404); return; }

  const role = getRole(config, rec.roleId);

  const session = (Array.isArray(rec.messages) ? rec.messages : []).map(m => {
    const who = (m && m.role === 'user') ? 'user' : 'agent';
    return '[' + who + '] ' + asString(m && m.text);
  }).join('\n');

  const canvas = getCanvas(rec.ratio);
  const prompt = fillTemplate(config.shared.refineTemplate, {
    roleName: role.name,
    styleGuide: role.styleGuide,
    ratio: rec.ratio,
    canvasW: String(canvas.w),
    canvasH: String(canvas.h),
    currentBrief: rec.designBrief,
    currentVisible: rec.visiblePrompt,
    session: session,
    instruction: instruction
  });

  console.log('[api] REFINE start id=' + id + ' instrLen=' + instruction.length);
  const llm = await chatCompletion(prompt, '', 0.3, 0, 3, 60);
  if (!llm.ok) { upstreamFail(res, llm, 'refine'); return; }

  const upd = parseLlmJson(llm.content);
  if (!upd || !upd.designBrief) {
    writeFail(res, 'refine_parse_failed', 'The model did not return a parsable refinement.', 502);
    return;
  }

  rec.designBrief = asString(upd.designBrief);
  if (upd.visiblePrompt) { rec.visiblePrompt = asString(upd.visiblePrompt); }
  let reply = asString(upd.agentReply);
  if (!reply) { reply = asString(upd.changed); }
  rec.agentReply = reply;
  rec.messages = (Array.isArray(rec.messages) ? rec.messages : []).concat([
    { role: 'user',  text: instruction, at: nowIso() },
    { role: 'agent', text: reply,       at: nowIso() }
  ]);
  rec.updatedAt = nowIso();

  console.log('[api] REFINE ok id=' + id + ' ms=' + llm.ms);
  writeJson(res, { ok: true, record: publicRecord(rec), changed: asString(upd.changed) });
}

// 重新生成：全新的创作方向 + 新种子，同样的需求也绝不产出相同视觉
async function regenerateStage(body, res) {
  const id = step(body, 'id', '');
  const rec = getRecordById(id);
  if (!rec) { writeFail(res, 'not_found', 'record ' + id + ' not found', 404); return; }

  const config = readRoles();
  const role = getRole(config, rec.roleId);
  const seed = newVariationSeed();
  const prompt = fillTemplate(config.shared.plannerTemplate, {
    roleName: role.name,
    deliverable: role.deliverable,
    styleGuide: role.styleGuide,
    requirement: rec.requirement,
    seed: seed,
    directions: getRandomDirections(config, 3)
  });

  console.log('[api] REGENERATE start id=' + id + ' seed=' + seed);
  const llm = await chatCompletion(prompt, '', 1.0, 0, 3, 60);
  if (!llm.ok) { upstreamFail(res, llm, 'regenerate'); return; }

  const plan = parseLlmJson(llm.content);
  if (!plan || !plan.designBrief) {
    writeFail(res, 'plan_parse_failed', 'The model did not return a parsable plan.', 502);
    return;
  }

  // 新方向也可能配新画幅；模型没给可用值就沿用原记录
  let ratio = asString(plan.ratio);
  if (RATIOS.indexOf(ratio) < 0) { ratio = rec.ratio; }

  const gen = await htmlGeneration(asString(plan.designBrief), ratio, {
    roleName: role.name,
    styleGuide: role.styleGuide,
    requirement: rec.requirement,
    seed: seed
  });
  if (!gen.ok) { upstreamFail(res, gen, 'regenerate-render'); return; }

  const rev = { at: nowIso(), ratio: gen.ratio, size: gen.size, html: gen.html, note: 'regenerate' };
  rec.title = asString(plan.title);
  rec.summary = asString(plan.summary);
  rec.visiblePrompt = asString(plan.visiblePrompt);
  rec.designBrief = asString(plan.designBrief);
  rec.agentReply = asString(plan.agentReply);
  rec.keywords = plan.keywords == null ? [] : (Array.isArray(plan.keywords) ? plan.keywords : [plan.keywords]);
  rec.seed = String(seed);
  rec.html = gen.html;
  rec.ratio = gen.ratio;
  rec.size = gen.size;
  rec.revisions = (Array.isArray(rec.revisions) ? rec.revisions : []).concat([rev]);
  rec.messages = (Array.isArray(rec.messages) ? rec.messages : []).concat([
    { role: 'agent', text: asString(plan.agentReply), at: nowIso() }
  ]);
  rec.updatedAt = nowIso();

  console.log('[api] REGENERATE ok id=' + id + ' ms=' + llm.ms + '+' + gen.ms);
  writeJson(res, { ok: true, record: publicRecord(rec) });
}

/* ---------------- HTTP 输出 ---------------- */

function writeJson(res, obj, status) {
  const body = JSON.stringify(obj);
  res.statusCode = status || 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function writeFail(res, code, message, status) {
  writeJson(res, { ok: false, error: code, message: message }, (status == null ? 400 : status));
}

/** 把上游失败翻译成前端认识的错误码，对应 Write-UpstreamFail */
function upstreamFail(res, result, stage) {
  console.log('[api] UPSTREAM_FAIL stage=' + stage + ' status=' + result.status +
    ' attempts=' + result.attempts + ' ms=' + result.ms);

  // 上游没坏，只是 Agnes 密钥没配
  if (result.msg === 'no_api_key' || result.msg === 'no_base_url') {
    writeFail(res, 'no_api_key', 'AGNES_API_KEY is not set in the environment', 503);
    return;
  }

  let status = 502;
  if (result.status === 429) { status = 429; }
  else if (result.status === 504) { status = 504; }

  let code = 'upstream_error';
  if (result.reason === 'dns' || result.reason === 'connect') { code = 'upstream_unreachable'; }
  else if (result.reason === 'tls') { code = 'upstream_tls'; }
  else if (result.status === 401 || result.status === 403) { code = 'upstream_auth_failed'; }
  else if (result.status === 429) { code = 'upstream_rate_limited'; }
  else if (result.status === 504) { code = 'upstream_timeout'; }
  writeFail(res, code, "model endpoint failed at stage '" + stage + "' status=" + result.status, status);
}

/* ---------------- CORS ---------------- */

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (!origin) {
    // 无 Origin：同源或服务端调用，直接放行
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS.indexOf(origin) >= 0) {
    // 只回显白名单来源：避免任意网站借本代理消耗额度
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/* ---------------- 路由 ---------------- */

function queryValue(req, name) {
  if (req.query && req.query[name] != null) {
    const v = req.query[name];
    return Array.isArray(v) ? v[0] : String(v);
  }
  const raw = req.url || '';
  const q = raw.indexOf('?');
  if (q >= 0) {
    const v = new URLSearchParams(raw.slice(q + 1)).get(name);
    if (v != null) { return v; }
  }
  return '';
}

/** 取路由段：优先 ?path=（vercel rewrite 注入），否则从原始 URL 推导 */
function deriveRoute(req) {
  let p = '';
  if (req.query && req.query.path != null) {
    p = Array.isArray(req.query.path) ? req.query.path[0] : String(req.query.path);
  }
  if (!p) {
    const raw = req.url || '';
    const q = raw.indexOf('?');
    p = (q >= 0 ? raw.slice(0, q) : raw).replace(/^\/api\/?/, '');
  }
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 读取 JSON 请求体（Vercel 已按 Content-Type 解析；兜底手动解析字符串） */
function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { return null; }
  }
  if (!b || typeof b !== 'object') { return null; }
  return b;
}

async function handleApi(route, method, req, res) {
  // health / roles 与 server.ps1 一致，不校验方法
  if (route === 'health') {
    const keyOk = !!(API_KEY && API_KEY.trim());
    const pub = { configured: keyOk, name: 'Agnes AI', model: TEXT_MODEL, baseUrl: BASE_URL };
    writeJson(res, {
      ok: true,
      service: 'huizhi-ai',
      version: '4.0.0',
      provider: 'Agnes AI',
      baseUrl: BASE_URL,
      ratios: RATIOS,
      chat: pub,
      codegen: pub,
      configured: keyOk,
      time: nowIso()
    });
    return;
  }

  if (route === 'roles') {
    const config = readRoles();
    const pub = config.roles.map(r => ({
      id: r.id,
      index: r.index,
      name: r.name,
      short: r.short,
      icon: r.icon,
      tagline: r.tagline,
      description: r.description,
      defaultRatio: r.defaultRatio
    }));
    writeJson(res, { ok: true, roles: pub, ratios: RATIOS });
    return;
  }

  if (route === 'history' && method === 'GET') {
    writeJson(res, { ok: true, records: records.map(publicRecord) });
    return;
  }

  if (route === 'history' && method === 'DELETE') {
    const id = queryValue(req, 'id');
    if (!id) { writeFail(res, 'missing_id', 'query id is required', 400); return; }
    removeRecord(id);
    console.log('[api] HISTORY delete id=' + id);
    writeJson(res, { ok: true });
    return;
  }

  if (route === 'history/clear' && method === 'POST') {
    clearRecords();
    console.log('[api] HISTORY clear');
    writeJson(res, { ok: true });
    return;
  }

  // 先判路径：未知端点给 404，405 专指"端点对、方法错"
  const postOnly = ['plan', 'render', 'refine', 'regenerate'];
  if (postOnly.indexOf(route) < 0) {
    writeFail(res, 'unknown_endpoint', 'unknown endpoint ' + route, 404);
    return;
  }
  if (method !== 'POST') {
    writeFail(res, 'method_not_allowed', 'unsupported method', 405);
    return;
  }

  const body = readBody(req);
  switch (route) {
    case 'plan':       await planStage(body, res); break;
    case 'render':     await renderStage(body, res); break;
    case 'refine':     await refineStage(body, res); break;
    case 'regenerate': await regenerateStage(body, res); break;
  }
}

/* ---------------- 入口（vercel.json 把所有 /api/* 重写到这里） ---------------- */

module.exports = async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const route = deriveRoute(req);
  try {
    await handleApi(route, req.method || 'GET', req, res);
  } catch (err) {
    console.error('[api] unhandled error route=' + route + ' ' + ((err && err.stack) || err));
    writeFail(res, 'internal_error', 'server error: ' + ((err && err.message) || err), 500);
  }
};
