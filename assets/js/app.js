/* ==========================================================================
   绘职 AI — 首页（生成器）逻辑
   ========================================================================== */
(function () {
  'use strict';

  const { api, ui } = window.HZ;
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* 服务端不可用时的兜底岗位表，保证页面依然可用、可读 */
  const FALLBACK_ROLES = [
    { id: 'pm',  index: '01', name: '产品经理', icon: 'board',     defaultRatio: '16:9', tagline: '把 PRD 变成可评审的 Dashboard' },
    { id: 'ixd', index: '02', name: '交互设计', icon: 'flow',      defaultRatio: '16:9', tagline: '把任务链路画成可推演的流程图' },
    { id: 'ui',  index: '03', name: 'UI 设计',  icon: 'palette',   defaultRatio: '9:16', tagline: '直接产出高保真界面视觉稿' },
    { id: 'ops', index: '04', name: '运营设计', icon: 'megaphone', defaultRatio: '9:16', tagline: '快速产出活动主视觉与 Banner' },
    { id: 'fe',  index: '05', name: '前端开发', icon: 'code',      defaultRatio: '16:9', tagline: '拿到带标注的 UI 结构与组件库' }
  ];

  /* 岗位化示例需求
     place —— 输入框占位提示（短句）
     text  —— 「填入示例」按钮写入的完整内容（代表该岗位最典型的需求描述） */
  const EXAMPLES = {
    pm: {
      place: '为电商运营团队做一个数据看板…',
      text: '为电商运营团队设计一个每日晨会用的数据看板。需要展示 GMV、订单量、转化率三个核心指标，并能一眼看出近 30 天的趋势变化；右侧放一个待办任务列表，标注负责人与完成进度。整体风格专业克制，关键数字要远距离可读，适合会议室投屏。'
    },
    ixd: {
      place: '梳理「从购物车到支付成功」的交互流程…',
      text: '梳理「从加入购物车到支付成功」的完整交互流程。需要包含正常路径，以及库存不足、优惠券失效、支付失败这三条异常分支与对应的重试和回退路径；用泳道区分用户操作与系统反馈，并标注每一步的页面跳转、状态变化与提示文案。'
    },
    ui: {
      place: '一款主打睡眠监测的 App 首页…',
      text: '一款主打睡眠监测的 App 首页高保真视觉稿。深色系，气质高级克制，需要包含睡眠评分环形图、本周睡眠趋势图、助眠音频入口和「开始入睡」主按钮，并给出完整的图标风格、字号阶梯与深色模式的语义色规范。'
    },
    ops: {
      place: '中秋礼盒的电商大促主视觉 Banner…',
      text: '中秋礼盒的电商大促主视觉 Banner，竖版用于手机端投放。要突出「限时 5 折」的促销利益点，画面以礼盒实物为主角，暖色木质调，氛围厚重精致有节日感，避免廉价促销的堆砌感，主标题要第一眼就抓住注意力。'
    },
    fe: {
      place: '后台管理系统的组件库总览页…',
      text: '后台管理系统的组件库总览页。需要把按钮、输入框、下拉框、表格、标签这几个组件的默认、悬停、禁用、加载四种状态并排展示，并标注出栅格列数、间距规范与响应式断点，方便前端照着直接落地成代码。'
    }
  };

  const QUICK_PROMPTS = [
    '整体配色再暗一点，更有质感',
    '把主按钮换成蓝色',
    '信息密度降低，留白多一点',
    '标题字号再放大一档'
  ];

  const ZOOMS = [0, 50, 75, 100, 125, 150];

  const state = {
    roles: FALLBACK_ROLES.slice(),
    roleId: 'pm',
    ratio: '16:9',          // 仅用于尚未出图时的示例占位画框
    record: null,
    revIndex: -1,
    zoom: 0,
    busy: false
  };

  const els = {};

  /* --------------------------------------------------------------- 状态渲染 */
  function roleById(id) {
    return state.roles.filter((r) => r.id === id)[0] || state.roles[0] || FALLBACK_ROLES[0];
  }

  function renderRoles() {
    els.roles.innerHTML = state.roles.map((r) => {
      const on = r.id === state.roleId;
      return '<button class="role' + (on ? ' is-on' : '') + '" type="button" role="radio" ' +
        'aria-checked="' + on + '" data-role="' + ui.esc(r.id) + '" ' +
        'title="' + ui.esc(r.tagline || r.name) + '">' +
        '<span class="role-ico" data-icon="' + ui.esc(r.icon) + '"></span>' +
        '<span class="role-name">' + ui.esc(r.name) + '</span>' +
        '<span class="role-tag">' + ui.esc(r.index) + '</span>' +
        (on ? '<span class="role-badge">已选择</span>' : '') +
        '</button>';
    }).join('');
    ui.mountIcons(els.roles);
  }

  function syncRoleUI() {
    const role = roleById(state.roleId);
    els.rolePillText.textContent = role.name;
    const ex = EXAMPLES[role.id];
    els.requirement.placeholder = ex ? '例如：' + ex.place : '请描述你的产品功能、目标用户和核心场景…';
    if (els.fillExample) {
      els.fillExample.title = '填入「' + role.name + '」的示例需求';
      els.fillExample.disabled = !ex;
    }
  }

  /* 字数统计：不设上限，仅用于给用户一个直观反馈 */
  function updateCounter() {
    els.counter.textContent = els.requirement.value.length + ' 字';
  }

  /* 「填入示例」：按当前岗位写入该岗位最具代表性的需求描述 */
  function fillExample() {
    const role = roleById(state.roleId);
    const ex = EXAMPLES[role.id];
    if (!ex) { ui.toast('该岗位暂无示例内容', 'info'); return; }

    const current = els.requirement.value.trim();
    if (current && current !== ex.text) {
      if (!window.confirm('当前输入框已有内容，确定用「' + role.name + '」的示例覆盖吗？')) return;
    }

    els.requirement.value = ex.text;
    updateCounter();
    els.requirement.focus();
    // 光标移到末尾，方便用户接着改
    try { els.requirement.setSelectionRange(ex.text.length, ex.text.length); } catch (_) {}
    ui.toast('已填入「' + role.name + '」示例需求', 'ok');
  }

  function setBusy(on, label) {
    state.busy = on;
    els.generate.disabled = on;
    els.generate.innerHTML = on
      ? '<span class="spinner" aria-hidden="true"></span><span>' + ui.esc(label || '生成中…') + '</span>'
      : '<span data-icon="plus" aria-hidden="true"></span><span>开始生成视觉稿</span>' +
        '<span class="arrow" data-icon="arrowRight" aria-hidden="true"></span>';
    if (!on) ui.mountIcons(els.generate);
  }

  /* ----------------------------------------------------------------- 工具栏 */
  /* 画幅不再由用户选择：模型会按需求描述自动适配，工具栏只保留对结果的操作。
     控件可用性由数据决定：
     hasPage   —— 当前是否有可展示/可下载的页面（决定下载）
     hasPrompt —— 是否已有解析结果（决定复制 Prompt 与重新生成）
     避免出现「看起来能点、点了没反应」的死控件 */
  function toolbarHTML(opt) {
    const o = opt || {};
    const busy = !!o.busy;
    const canPage = !busy && !!o.hasPage;
    const canPrompt = !busy && !!o.hasPrompt;

    return '<div class="toolbar">' +
      '<div class="tool-group">' +
        '<button class="ico-btn" type="button" data-act="undo" title="上一步" aria-label="上一步"' +
          (o.canUndo && !busy ? '' : ' disabled') + ' data-icon="undo"></button>' +
        '<button class="ico-btn" type="button" data-act="redo" title="下一步" aria-label="下一步"' +
          (o.canRedo && !busy ? '' : ' disabled') + ' data-icon="redo"></button>' +
      '</div>' +
      '<div class="tool-right">' +
        '<button class="btn" type="button" data-act="copy"' + (canPrompt ? '' : ' disabled') +
          ' title="复制本次的业务 Prompt"><span data-icon="copy"></span><span class="btn-label">复制 Prompt</span></button>' +
        '<button class="btn" type="button" data-act="regen"' + (canPrompt ? '' : ' disabled') +
          ' title="换一个全新的创意方向"><span data-icon="refresh"></span><span class="btn-label">重新生成</span></button>' +
        '<button class="btn is-primary" type="button" data-act="download"' + (canPage ? '' : ' disabled') +
          ' title="下载当前页面（HTML 源文件）"><span data-icon="download"></span><span class="btn-label">下载</span></button>' +
      '</div>' +
    '</div>';
  }

  function chatHTML(opt) {
    const o = opt || {};
    const dis = o.disabled ? ' disabled' : '';
    const quick = o.disabled ? '' :
      '<div class="quick-prompts">' +
        QUICK_PROMPTS.map((q) => '<button type="button" data-quick="' + ui.esc(q) + '">' + ui.esc(q) + '</button>').join('') +
      '</div>';

    return '<div class="chat">' +
      '<div class="chat-head"><span data-icon="sparkle"></span>继续与视觉 Agent 对话</div>' +
      '<div class="chat-log" id="chatLog">' + (o.log || '') + '</div>' +
      '<form class="chat-form" id="chatForm">' +
        '<input type="text" id="chatInput" autocomplete="off"' + dis +
          ' aria-label="与视觉 Agent 对话" placeholder="对结果不满意？告诉我怎么改。例如：把按钮换成蓝色…">' +
        '<button class="send" type="submit" title="发送" aria-label="发送"' + dis + ' data-icon="send"></button>' +
      '</form>' + quick +
    '</div>';
  }

  function bubblesHTML(messages) {
    if (!messages || !messages.length) return '';
    return messages.map((m) => {
      const agent = m.role !== 'user';
      return '<div class="bubble ' + (agent ? 'agent' : 'user') + '">' +
        '<span class="bubble-avatar">' + (agent ? 'AI' : '我') + '</span>' +
        '<div class="bubble-text">' + ui.esc(m.text) + '</div>' +
      '</div>';
    }).join('');
  }

  /* 画幅比例 → 宽高比数值，供 iframe 容器计算像素尺寸 */
  function ratioToAR(ratio) {
    const p = String(ratio || '16:9').split(':');
    const a = parseFloat(p[0]) || 16;
    const b = parseFloat(p[1]) || 9;
    return a / b;
  }

  /* 画布像素尺寸（如 1400x1050）。生成页是按这个尺寸写死版式的，
     所以 iframe 必须用同样的像素渲染，再整体缩放去适应容器。 */
  function parseCanvasSize(size) {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(size || '').trim());
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    return (w > 0 && h > 0) ? { w: w, h: h } : null;
  }

  /* 生成结果用原生 DOM 渲染：把模型产出的整页 HTML 直接放进沙箱 iframe。
     DOM 渲染天然是矢量级的，任意缩放与投屏都保持清晰，不需要先转位图。
     sandbox 留空表示禁止脚本执行，生成页只作为静态视图呈现。 */
  function canvasHTML(html, ratio, meta, size) {
    const ar = ratioToAR(ratio);
    const dim = parseCanvasSize(size) || { w: 0, h: 0 };

    const inner = html
      ? '<div class="frame-shell" id="frameShell" data-ar="' + ar + '"' +
          ' data-cw="' + dim.w + '" data-ch="' + dim.h + '">' +
          '<div class="frame-fit" id="frameFit">' +
            '<iframe class="canvas-frame" title="AI 生成的高保真界面" sandbox="" ' +
              'srcdoc="' + ui.esc(html) + '"></iframe>' +
          '</div>' +
        '</div>'
      : $('#tpl-mock').innerHTML;

    const note = html
      ? ''
      : '<div class="placeholder-note"><span class="meta-pill">示例预览 · 生成后替换</span></div>';

    const zoomLabel = state.zoom === 0 ? '适应' : state.zoom + '%';

    return '<div class="canvas">' +
      '<div class="canvas-stage">' + note +
        '<div class="canvas-viewport" id="viewport">' + inner + '</div>' +
        '<div class="canvas-meta">' + (meta || '') + '</div>' +
        '<div class="canvas-zoom">' +
          (html ? '<button class="meta-pill" type="button" data-act="fullscreen" ' +
            'title="全屏展示，适合会议投屏">全屏展示</button>' : '') +
          '<button class="meta-pill" type="button" data-act="zoom" title="点击切换缩放">' + zoomLabel + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* --------------------------------------------------------------- 各视图 */
  function renderEmpty() {
    els.result.innerHTML =
      toolbarHTML({}) +
      canvasHTML('', state.ratio, '') +
      chatHTML({ disabled: true });
    ui.mountIcons(els.result);
    bindResult();
  }

  function renderLoading(step, title) {
    const steps = ['解析业务需求', '生成界面代码'];
    const stepsHTML = steps.map((s, i) => {
      const cls = i < step ? 'is-done' : (i === step ? 'is-active' : '');
      return '<div class="loading-step ' + cls + '"><span class="bulb"></span>' + s + '</div>';
    }).join('');

    els.result.innerHTML =
      toolbarHTML({ busy: true }) +
      '<div class="canvas"><div class="canvas-stage"><div class="loading">' +
        '<div class="loading-orb"><span></span><span></span><span></span><b>' +
          (step === 0 ? '01' : '02') + '</b></div>' +
        '<h3>' + ui.esc(title || steps[step] || '处理中') + '</h3>' +
        '<div class="loading-steps">' + stepsHTML + '</div>' +
        '<p style="font-size:12px;color:var(--text-4);max-width:320px">' +
          '高保真界面生成通常需要 20–60 秒，请保持页面打开，不要刷新。</p>' +
      '</div></div></div>' +
      chatHTML({ disabled: true });
    ui.mountIcons(els.result);
  }

  function renderError(err, canRetryRender) {
    const msg = api.friendly(err);
    // 没配模型不算"故障"，直接把用户引到设置页，而不是让他反复重试
    const isSetup = api.isSetupError(err);

    const actions = isSetup
      ? '<button class="btn is-primary" type="button" data-act="recheck">' +
          '<span data-icon="refresh"></span><span>重新检测</span></button>'
      : '<button class="btn is-primary" type="button" data-act="retry">' +
          '<span data-icon="refresh"></span><span>' + (canRetryRender ? '只重新生成页面' : '重试一次') + '</span></button>' +
        '<button class="btn" type="button" data-act="regen">' +
          '<span data-icon="bolt"></span><span>换个方向重生成</span></button>';

    // 服务端没配密钥属部署侧问题，说明清楚即可，不提供任何配置入口
    const needList = isSetup
      ? '<ul class="need-list">' +
          '<li><span class="need-ico ok" data-icon="check"></span>' +
            '<span><b>现在就能用</b>：岗位选择、填入示例、浏览示例预览、历史记录</span></li>' +
          '<li><span class="need-ico todo" data-icon="plug"></span>' +
            '<span><b>需求解析、多轮微调与高保真界面生成</b> —— 服务端配置好 Agnes AI 密钥后会自动恢复</span></li>' +
        '</ul>'
      : '';

    els.result.innerHTML =
      toolbarHTML({
        hasPrompt: !!(state.record && state.record.visiblePrompt),
        hasPage: false
      }) +
      '<div class="canvas"><div class="canvas-stage"><div class="empty">' +
        '<div class="empty-ico" data-icon="' + (isSetup ? 'plug' : 'alert') + '"></div>' +
        '<h3>' + (isSetup ? 'AI 服务暂时不可用' : '这次没能生成成功') + '</h3>' +
        '<p>' + ui.esc(msg) + '</p>' +
        needList +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' + actions + '</div>' +
      '</div></div></div>' +
      chatHTML({ disabled: !state.record });
    ui.mountIcons(els.result);
    bindResult();
    if (state.record && state.record.messages) fillChat(state.record.messages);
  }

  /* 静态托管（无后端）时点击生成给出的说明面板：说清"能做什么 / 要怎么做" */
  function renderStaticPanel() {
    els.result.innerHTML =
      toolbarHTML({}) +
      '<div class="canvas"><div class="canvas-stage"><div class="empty">' +
        '<div class="empty-ico" data-icon="monitor"></div>' +
        '<h3>静态预览部署 · 无法生成视觉稿</h3>' +
        '<p>本站是纯静态托管，没有后端服务，因此无法调用大模型。</p>' +
        '<ul class="need-list">' +
          '<li><span class="need-ico ok" data-icon="check"></span>' +
            '<span><b>现在就能用</b>：岗位选择、填入示例、界面预览、页面跳转 —— 均可正常体验</span></li>' +
          '<li><span class="need-ico todo" data-icon="plug"></span>' +
            '<span><b>要真正生成视觉稿</b>：在本机运行 <code>start.ps1</code>，' +
            '再打开 <code>http://localhost:8230/</code> 即可接入你自己的大模型并出图</span></li>' +
        '</ul>' +
      '</div></div></div>' +
      chatHTML({ disabled: true });
    ui.mountIcons(els.result);
    bindResult();
  }

  function renderRecord() {
    const rec = state.record;
    if (!rec) return renderEmpty();

    const revs = rec.revisions || [];
    const idx = state.revIndex >= 0 && state.revIndex < revs.length ? state.revIndex : revs.length - 1;
    state.revIndex = idx;
    const rev = revs[idx] || null;
    const html = rev ? rev.html : '';
    const ratio = rev ? rev.ratio : rec.ratio;
    const size = rev ? rev.size : rec.size;

    const meta = '<span class="meta-pill">' + ui.esc(rec.roleName) + '</span>' +
      '<span class="meta-pill">AI 自动画幅</span>' +
      (size ? '<span class="meta-pill">' + ui.esc(size) + '</span>' : '') +
      (revs.length > 1 ? '<span class="meta-pill">第 ' + (idx + 1) + ' / ' + revs.length + ' 版</span>' : '');

    const tags = (rec.keywords || []).map((k) => '<span class="tag">' + ui.esc(k) + '</span>').join('');

    els.result.innerHTML =
      toolbarHTML({
        canUndo: idx > 0,
        canRedo: idx < revs.length - 1,
        hasPage: !!html,
        hasPrompt: !!rec.visiblePrompt
      }) +
      canvasHTML(html, ratio, meta, size) +
      '<div class="result-brief">' +
        '<h4>' + ui.esc(rec.title || '未命名视觉稿') + '</h4>' +
        '<div class="tags">' + tags + '</div>' +
      '</div>' +
      '<div class="prompt-box">' +
        '<button class="prompt-toggle" type="button" aria-expanded="false" data-act="toggle-prompt">' +
          '<span data-icon="file"></span><span>查看本次《业务 Prompt》</span>' +
          '<span class="caret" data-icon="chevronDown"></span>' +
        '</button>' +
        '<div class="prompt-body is-hidden" id="promptBody">' + ui.esc(rec.visiblePrompt || '') + '</div>' +
      '</div>' +
      chatHTML({ log: bubblesHTML(rec.messages) });

    ui.mountIcons(els.result);
    layoutFrame();
    bindResult();
    scrollChatToEnd();
  }

  function fillChat(messages) {
    const log = $('#chatLog', els.result);
    if (log) { log.innerHTML = bubblesHTML(messages); scrollChatToEnd(); }
  }

  function scrollChatToEnd() {
    const log = $('#chatLog', els.result);
    if (log) log.scrollTop = log.scrollHeight;
  }

  /* -------------------------------------------------------- 画幅布局与全屏 */
  /* 生成页是按画布像素（例如 1400×1050）写死版式的。若把 iframe 直接按容器
     宽度渲染，页面里那些固定像素的栏宽就会溢出并被 overflow:hidden 裁掉，
     右侧整栏会凭空消失。正确做法：iframe 严格按画布像素渲染，再用
     transform: scale() 等比缩放去适应容器 —— 与设计稿预览（Figma）一致，
     任何容器尺寸下都完整可见，且文字仍是矢量级清晰。 */
  function layoutFrame() {
    const shell = $('#frameShell', els.result);
    const fit = $('#frameFit', els.result);
    if (!shell || !fit) return;
    const frame = $('.canvas-frame', els.result);

    const ar = parseFloat(shell.dataset.ar) || 16 / 9;
    const cw = parseFloat(shell.dataset.cw) || 0;
    const ch = parseFloat(shell.dataset.ch) || 0;
    const fs = document.fullscreenElement === shell;

    let availW, availH;
    if (fs) {
      availW = window.innerWidth;
      availH = window.innerHeight;
    } else {
      const vp = $('#viewport', els.result);
      if (!vp) return;
      availW = vp.clientWidth;
      availH = vp.clientHeight;
    }
    if (!availW || !availH) return;

    /* 没有画布像素（示例占位、历史旧数据）：保持容器自适应 */
    if (!cw || !ch) {
      const w = (state.zoom === 0 || fs) ? Math.min(availW, availH * ar) : availW * state.zoom / 100;
      fit.style.width = Math.round(w) + 'px';
      fit.style.height = Math.round(w / ar) + 'px';
      if (frame) frame.style.transform = '';
      return;
    }

    const fitScale = Math.min(availW / cw, availH / ch);   // 完整装下整页
    const k = (state.zoom === 0 || fs) ? fitScale : fitScale * state.zoom / 100;

    fit.style.width = Math.round(cw * k) + 'px';
    fit.style.height = Math.round(ch * k) + 'px';
    if (frame) {
      frame.style.width = cw + 'px';
      frame.style.height = ch + 'px';
      frame.style.transformOrigin = '0 0';
      frame.style.transform = 'scale(' + k + ')';
    }
  }

  /* 全屏展示：投屏时让页面撑满屏幕，矢量渲染保证文字锐利 */
  function toggleFullscreen() {
    const shell = $('#frameShell', els.result);
    if (!shell) { ui.toast('暂无可展示的页面', 'err'); return; }
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (!shell.requestFullscreen) { ui.toast('当前浏览器不支持全屏展示', 'err'); return; }
    shell.requestFullscreen().catch(() => ui.toast('全屏展示被浏览器拒绝', 'err'));
  }

  /* ------------------------------------------------------------- 结果交互 */
  function bindResult() {
    const root = els.result;

    root.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'undo')   return setRevision(state.revIndex - 1);
        if (act === 'redo')   return setRevision(state.revIndex + 1);
        if (act === 'copy')   return copyPrompt();
        if (act === 'regen')  return regenerate();
        if (act === 'download') return downloadCurrent();
        if (act === 'retry')  return retryLast();
        if (act === 'recheck') return recheck();
        if (act === 'zoom')   return cycleZoom();
        if (act === 'fullscreen') return toggleFullscreen();
        if (act === 'toggle-prompt') return togglePrompt(b);
      }));

    root.querySelectorAll('.quick-prompts [data-quick]').forEach((b) =>
      b.addEventListener('click', () => refine(b.dataset.quick)));

    const form = $('#chatForm', root);
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#chatInput', root);
        const text = input ? input.value : '';
        input.value = '';
        refine(text);
      });
    }
  }

  /* 重新探测模型状态：在设置页接入完成后，回到首页点一下即可生效，无需刷新 */
  async function recheck() {
    ui.toast('正在重新检测模型接入状态…', 'info');
    await refreshStatus();
    if (els.live.dataset.ready === '1') {
      ui.toast('已检测到可用模型，可以开始生成了', 'ok');
      renderEmpty();
    } else {
      ui.toast('仍未检测到可用模型，请先完成接入', 'err');
    }
  }

  function togglePrompt(btn) {
    const body = $('#promptBody', els.result);
    if (!body) return;
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    body.classList.toggle('is-hidden', open);
  }

  function cycleZoom() {
    const i = ZOOMS.indexOf(state.zoom);
    state.zoom = ZOOMS[(i + 1) % ZOOMS.length];
    const btn = $('[data-act="zoom"]', els.result);
    if (btn) btn.textContent = state.zoom === 0 ? '适应' : state.zoom + '%';
    layoutFrame();
  }

  function setRevision(i) {
    const revs = (state.record && state.record.revisions) || [];
    if (i < 0 || i >= revs.length) return;
    state.revIndex = i;
    renderRecord();
  }

  /* 接住服务端返回的新记录：统一把进度指到最新版本，并把缩放复位，
     否则上一张图上放大到 150% 会原样套用到新图上 */
  function adoptRecord(rec) {
    state.record = rec;
    state.revIndex = (rec.revisions || []).length - 1;
    state.zoom = 0;
  }

  /* --------------------------------------------------------------- 核心动作 */
  async function generate() {
    if (state.busy) return;

    // 完全没有可用后端时才直接说明，不去发注定失败的请求
    if (!ui.hasBackend()) {
      renderStaticPanel();
      ui.toast('静态预览部署不含后端，无法生成视觉稿', 'err');
      scrollToResult();
      return;
    }

    const requirement = els.requirement.value.trim();
    if (!requirement) {
      ui.toast('请先描述你的需求', 'err');
      els.requirement.focus();
      return;
    }

    setBusy(true, '解析需求…');
    renderLoading(0, '正在解析你的业务需求…');
    scrollToResult();

    try {
      const planned = await api.plan({ roleId: state.roleId, requirement });
      state.record = planned.record;
      state.revIndex = -1;
      sessionStorage.setItem('hz.currentId', state.record.id);

      setBusy(true, '生成界面…');
      renderLoading(1, '正在生成高保真界面…');

      const rendered = await api.render({ id: state.record.id });
      adoptRecord(rendered.record);

      renderRecord();
      ui.toast('高保真界面已生成', 'ok');
    } catch (err) {
      // 服务端不下发 designBrief，因此以 visiblePrompt 判断"已完成解析、只差生成页面"
      const canPartial = !!(state.record && state.record.visiblePrompt);
      renderError(err, canPartial);
      ui.toast(api.friendly(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function renderOnly() {
    if (state.busy || !state.record) return;
    setBusy(true, '生成界面…');
    renderLoading(1, '正在按设计说明生成视觉稿…');
    try {
      const rendered = await api.render({ id: state.record.id });
      adoptRecord(rendered.record);
      renderRecord();
      ui.toast('高保真界面已生成', 'ok');
    } catch (err) {
      renderError(err, true);
      ui.toast(api.friendly(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function retryLast() {
    if (state.record && state.record.visiblePrompt) return renderOnly();
    return generate();
  }

  async function regenerate() {
    if (state.busy) return;
    const requirement = els.requirement.value.trim();
    // 输入框改过了 → 按新需求重跑；否则只换一个创意方向重掷
    if (!state.record || (requirement && requirement !== state.record.requirement)) return generate();

    setBusy(true, '重新生成…');
    renderLoading(0, '正在换一个创意方向…');
    try {
      const r = await api.regenerate({ id: state.record.id });
      adoptRecord(r.record);
      renderRecord();
      ui.toast('已生成全新的一版', 'ok');
    } catch (err) {
      renderRecord();
      ui.toast(api.friendly(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function refine(text) {
    if (state.busy || !state.record) return;
    const instruction = String(text || '').trim();
    if (!instruction) { ui.toast('请输入你想调整的内容', 'err'); return; }

    setBusy(true, '微调中…');
    renderLoading(0, '正在理解你的修改…');
    try {
      const r1 = await api.refine({ id: state.record.id, instruction });
      state.record = r1.record;              // 先留住最新对话，再出图
      renderLoading(1, '正在按新要求重绘…');
      const r2 = await api.render({ id: state.record.id });
      adoptRecord(r2.record);
      renderRecord();
      ui.toast('已按你的要求更新', 'ok');
    } catch (err) {
      // 失败时回到服务端已确认的状态，不显示未落库的本地气泡
      if (state.record && state.record.visiblePrompt) renderRecord(); else renderError(err, false);
      ui.toast(api.friendly(err), 'err');
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------- 复制下载 */
  async function copyPrompt() {
    if (!state.record) return;
    const ok = await ui.copyText(state.record.visiblePrompt || '');
    ui.toast(ok ? '业务 Prompt 已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'err');
  }

  /* 下载当前版本的 HTML 源文件：它是自包含单文件，双击即可在浏览器打开，
     也可以在会议室投屏时直接用浏览器全屏展示。 */
  function downloadCurrent() {
    const rec = state.record;
    if (!rec) return;
    const revs = rec.revisions || [];
    const rev = revs[state.revIndex] || revs[revs.length - 1];
    if (!rev || !rev.html) { ui.toast('暂无可下载的页面', 'err'); return; }

    const safe = (rec.title || '视觉稿').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24);
    const name = '绘职AI-' + rec.roleName + '-' + safe + '-' + (rev.size || rev.ratio || 'view').replace(/[:\s]/g, '-') + '.html';
    const blob = new Blob([rev.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    ui.download(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ui.toast('已开始下载 HTML 页面', 'ok');
  }

  /* ------------------------------------------------------------------ 滚动 */
  function scrollToResult() {
    const top = els.result.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------------ 启动 */
  async function loadRoles() {
    // 静态托管下没有后端，直接用内置的兜底岗位表，避免发出必然 404 的请求
    if (ui.hasBackend()) {
      try {
        const data = await api.roles();
        if (data && data.roles && data.roles.length) {
          state.roles = data.roles;
          if (!state.roles.some((r) => r.id === state.roleId)) state.roleId = state.roles[0].id;
        }
      } catch (_) { /* 保留 FALLBACK_ROLES */ }
    }

    // 应用「设置」页保存的默认岗位偏好（画幅已改为由模型按需求自动适配）
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('hz.prefs') || '{}'); } catch (_) { prefs = {}; }
    if (prefs.roleId && state.roles.some((r) => r.id === prefs.roleId)) state.roleId = prefs.roleId;

    state.ratio = roleById(state.roleId).defaultRatio || '16:9';

    renderRoles();
    syncRoleUI();
    // 有会话记录待恢复时不要先渲染空态，否则会出现一次「示例预览」闪烁
    if (!state.record && !sessionStorage.getItem('hz.currentId')) renderEmpty();
  }

  async function restoreSession() {
    if (!ui.hasBackend()) return;   // 静态托管没有历史记录接口
    const id = sessionStorage.getItem('hz.currentId');
    if (!id) return;
    try {
      const data = await api.history();
      const rec = (data.records || []).filter((r) => r.id === id)[0];
      if (!rec || !rec.html) return;
      adoptRecord(rec);
      state.roleId = rec.roleId;
      state.ratio = rec.ratio;
      els.requirement.value = rec.requirement || '';
      updateCounter();
      renderRoles();
      syncRoleUI();
      renderRecord();
    } catch (_) { /* 静默失败即可 */ }
  }

  function bindStatic() {
    els.roles.addEventListener('click', (e) => {
      const btn = e.target.closest('.role');
      if (!btn || state.busy) return;
      state.roleId = btn.dataset.role;
      state.ratio = roleById(state.roleId).defaultRatio || state.ratio;
      renderRoles();
      syncRoleUI();
    });

    els.fillExample.addEventListener('click', fillExample);
    els.requirement.addEventListener('input', updateCounter);
    els.requirement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        generate();
      }
    });

    els.generate.addEventListener('click', generate);
  }

  /* --------------------------------------------- 服务状态（纯展示，不阻塞） */
  /* 只负责告诉用户现在能不能用；任何一步失败都不影响已渲染好的界面。 */
  /* 一次探测失败不等于服务挂了：后端跑长任务时是单线程，会被短暂占满。
     因此重试 3 次，仍然失败才提示，并转入后台复查等待自愈。 */
  async function probeHealth() {
    for (let i = 0; i < 3; i++) {
      try { return await api.health(4000); }
      catch (_) { if (i < 2) await new Promise((r) => setTimeout(r, 1200)); }
    }
    return null;
  }

  async function refreshStatus() {
    // 静态托管（如 GitHub Pages）没有后端：不做注定失败的探测，直接如实说明。
    // 界面与交互此时依然完全可用，不受影响。
    if (!ui.hasBackend()) {
      els.live.className = 'live is-warn';
      els.liveText.textContent = '静态预览模式';
      els.live.dataset.ready = '0';
      ui.clearOfflineBar();
      ui.offlineBar(ui.STATIC_NOTICE);
      return;
    }

    const h = await probeHealth();

    // 服务不可达：只做提示，界面本身继续可用；后台持续复查，恢复后自动刷新
    if (!h) {
      els.live.className = 'live is-off';
      els.liveText.textContent = '服务未连接';
      els.live.dataset.ready = '0';
      ui.offlineBar('本地服务未响应，正在自动重试…（若长时间未恢复，请在本机运行 <strong>start.ps1</strong>）');
      ui.watchBackend();
      return;
    }

    ui.clearOfflineBar();

    const chat    = !!(h.chat    && h.chat.configured);
    const codegen = !!(h.codegen && h.codegen.configured);

    if (chat && codegen) {
      els.live.className = 'live is-on';
      els.liveText.textContent = 'AI Agent 在线';
      els.live.dataset.ready = '1';
    } else {
      // 服务在跑但没配密钥 —— 属部署侧问题，界面只如实说明，不提供配置入口
      els.live.className = 'live is-warn';
      els.liveText.textContent = '服务未就绪';
      els.live.dataset.ready = '0';
      ui.offlineBar('AI 服务尚未就绪：服务端缺少 Agnes AI 密钥，请联系服务提供方。');
    }
  }

  function init() {
    els.roles = $('#roles');
    els.requirement = $('#requirement');
    els.counter = $('#counter');
    els.rolePill = $('#rolePill');
    els.rolePillText = $('#rolePillText');
    els.fillExample = $('#fillExample');
    els.generate = $('#generate');
    els.result = $('#result');
    els.live = $('#live');
    els.liveText = $('#liveText');

    // 顺序很重要：先把基础界面完整渲染出来，再去做模型状态探测，
    // 这样"打开网站即可操作"，模型有没有接入都不影响首屏。
    ui.initNav();
    ui.mountIcons(document);
    ui.guardOrigin();

    renderEmpty();
    updateCounter();
    bindStatic();

    // 状态探测放在渲染之后；它自己会吞掉异常，不会影响上面已完成的部分
    // 服务恢复后由 ui 统一回调，自动把状态刷回"在线"，无需用户手动刷新
    ui.onBackendUp(refreshStatus);
    refreshStatus();

    loadRoles().then(restoreSession);

    // 状态胶囊只做展示，不再提供任何配置入口
    // 从设置页切回来时刷新一次（万一服务端状态变了）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshStatus();
    });

    // 画幅尺寸依赖容器大小，窗口变化与进出全屏时都要重新计算
    window.addEventListener('resize', layoutFrame);
    document.addEventListener('fullscreenchange', layoutFrame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
