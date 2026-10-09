/* ==========================================================================
   绘职 AI — 历史记录页
   ========================================================================== */
(function () {
  'use strict';

  const { api, ui } = window.HZ;
  const $ = (sel) => document.querySelector(sel);

  let records = [];
  let openedId = null;

  /* ------------------------------------------------------------------ 列表 */
  /* 生成结果是整页 HTML，缩略图用一个被 transform 等比缩小的沙箱 iframe 直接渲染，
     既保留真实视觉，也不必再落一张图片。 */
  const BASE_W = 1600;

  function frameBase(ratio) {
    const p = String(ratio || '16:9').split(':');
    const a = parseFloat(p[0]) || 16;
    const b = parseFloat(p[1]) || 9;
    const ar = a / b;
    return ar >= 1
      ? { w: BASE_W, h: Math.round(BASE_W / ar) }
      : { w: Math.round(BASE_W * ar), h: BASE_W };
  }

  function thumbHTML(html, ratio) {
    if (!html) return '<span class="ph">无预览</span>';
    const base = frameBase(ratio);
    return '<iframe class="thumb-frame" sandbox="" scrolling="no" tabindex="-1" aria-hidden="true" ' +
      'data-bw="' + base.w + '" style="width:' + base.w + 'px;height:' + base.h + 'px" ' +
      'srcdoc="' + ui.esc(html) + '"></iframe>';
  }

  function cardHTML(r, latest) {
    const thumb = thumbHTML(r.html, r.ratio);

    const tags = (r.keywords || []).slice(0, 3)
      .map((k) => '<span class="tag">' + ui.esc(k) + '</span>').join('');

    const vCount = (r.revisions || []).length;

    return '<div class="tl-item' + (latest ? ' is-latest' : '') + '">' +
      '<div class="hist-card" data-id="' + ui.esc(r.id) + '" role="button" tabindex="0">' +
        '<div class="hist-thumb">' + thumb + '</div>' +
        '<div class="hist-body">' +
          '<div class="hist-title">' + ui.esc(r.title || '未命名视觉稿') + '</div>' +
          '<div class="hist-meta">' +
            '<span class="tag">' + ui.esc(r.roleName || '') + '</span>' +
            '<span class="tag">' + ui.esc(r.size || 'AI 自动画幅') + '</span>' +
            '<span>' + ui.fmtDate(r.updatedAt || r.createdAt) + '</span>' +
            (vCount > 1 ? '<span>· ' + vCount + ' 个版本</span>' : '') +
          '</div>' +
          '<div class="hist-sum">' + ui.esc(r.summary || r.requirement || '') + '</div>' +
          (tags ? '<div class="tags" style="margin-top:9px;margin-left:0">' + tags + '</div>' : '') +
        '</div>' +
        '<div class="hist-actions">' +
          '<button class="btn is-primary" type="button" data-act="open">' +
            '<span data-icon="sparkle"></span><span>继续编辑</span></button>' +
          '<button class="btn" type="button" data-act="view">' +
            '<span data-icon="eye"></span><span>查看详情</span></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function render() {
    records.sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));

    $('#count').textContent = '共 ' + records.length + ' 条记录';

    if (!records.length) {
      $('#list').innerHTML =
        '<div class="empty">' +
          '<div class="empty-ico" data-icon="history"></div>' +
          '<h3>还没有生成记录</h3>' +
          '<p>回到首页描述一次业务需求，生成的视觉稿会自动保存在这里。</p>' +
          '<a class="btn is-primary" href="index.html"><span data-icon="sparkle"></span><span>去生成第一稿</span></a>' +
        '</div>';
      ui.mountIcons($('#list'));
      return;
    }

    $('#list').innerHTML = '<div class="timeline">' +
      records.map((r, i) => cardHTML(r, i === 0)).join('') + '</div>';
    ui.mountIcons($('#list'));
    bindCards();
    fitThumbs();
  }

  /* 缩略图按卡片宽度缩放。整页等比缩到卡片宽度后字会小到看不清，
     因此再放大到卡片宽度的 2 倍并裁切，让缩略图能看清头部与指标卡。 */
  function fitThumbs() {
    document.querySelectorAll('.hist-thumb').forEach((th) => {
      const f = th.querySelector('iframe');
      if (!f) return;
      const bw = parseFloat(f.dataset.bw) || BASE_W;
      const w = th.clientWidth;
      if (!w) return;
      f.style.transform = 'scale(' + (w / bw) * 2 + ')';
    });
  }

  /* 抽屉里的预览：等比缩放到抽屉宽度，过高时按高度上限收缩并水平居中 */
  function fitDrawer() {
    const box = $('#drawerFrame');
    if (!box) return;
    const f = box.querySelector('iframe');
    if (!f) return;
    const bw = parseFloat(f.dataset.bw) || BASE_W;
    const bh = parseFloat(f.dataset.bh) || 900;
    const w = box.clientWidth;
    if (!w) return;
    const s = Math.min(w / bw, 460 / bh);
    box.style.height = Math.round(bh * s) + 'px';
    f.style.transform = 'scale(' + s + ')';
    f.style.left = Math.round((w - bw * s) / 2) + 'px';
  }

  function bindCards() {
    $('#list').querySelectorAll('.hist-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (btn && btn.dataset.act === 'open') { openInGenerator(card.dataset.id); return; }
        openDrawer(card.dataset.id);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(card.dataset.id); }
      });
    });
  }

  /* ------------------------------------------------------------------ 详情 */
  function find(id) { return records.filter((r) => r.id === id)[0]; }

  function openDrawer(id) {
    const r = find(id);
    if (!r) return;
    openedId = id;

    $('#drawerTitle').textContent = r.title || '记录详情';

    const revs = r.revisions || [];
    const chat = (r.messages || []).map((m) => {
      const agent = m.role !== 'user';
      return '<div class="bubble ' + (agent ? 'agent' : 'user') + '">' +
        '<span class="bubble-avatar">' + (agent ? 'AI' : '我') + '</span>' +
        '<div class="bubble-text">' + ui.esc(m.text) + '</div></div>';
    }).join('');

    const revList = revs.map((v, i) =>
      '<div class="kv-row"><dt>第 ' + (i + 1) + ' 版</dt><dd>' +
      ui.esc((v.size || '') + ' · ' + ui.fmtDate(v.at)) + '</dd></div>').join('');

    const base = frameBase(r.ratio);
    const preview = r.html
      ? '<div class="drawer-frame" id="drawerFrame">' +
          '<iframe class="drawer-frame-inner" sandbox="" scrolling="no" tabindex="-1" ' +
            'data-bw="' + base.w + '" data-bh="' + base.h + '" ' +
            'style="width:' + base.w + 'px;height:' + base.h + 'px" ' +
            'srcdoc="' + ui.esc(r.html) + '"></iframe>' +
        '</div>'
      : '<div class="drawer-img"><div class="empty" style="padding:44px 20px"><p>该记录还没有可用的页面</p></div></div>';

    $('#drawerBody').innerHTML =
      preview +
      '<dl class="kv">' +
        '<div class="kv-row"><dt>岗位</dt><dd>' + ui.esc(r.roleName || '') + '</dd></div>' +
        '<div class="kv-row"><dt>画幅</dt><dd>AI 按需求自动适配（' + ui.esc(r.size || '') + '）</dd></div>' +
        '<div class="kv-row"><dt>创建</dt><dd>' + ui.esc(ui.fmtDate(r.createdAt)) + '</dd></div>' +
        '<div class="kv-row"><dt>原始需求</dt><dd>' + ui.esc(r.requirement || '') + '</dd></div>' +
        '<div class="kv-row"><dt>业务 Prompt</dt><dd>' + ui.esc(r.visiblePrompt || '') + '</dd></div>' +
      '</dl>' +
      (revList ? '<h4 style="font-size:13px;margin:18px 0 10px">版本记录</h4><dl class="kv">' + revList + '</dl>' : '') +
      (chat ? '<h4 style="font-size:13px;margin:18px 0 10px">对话上下文</h4>' +
              '<div class="chat-log" style="max-height:none;margin:0">' + chat + '</div>' : '');

    $('#mask').classList.add('is-open');
    $('#drawer').classList.add('is-open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    fitDrawer();
  }

  function closeDrawer() {
    $('#mask').classList.remove('is-open');
    $('#drawer').classList.remove('is-open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    openedId = null;
  }

  function openInGenerator(id) {
    sessionStorage.setItem('hz.currentId', id);
    location.href = 'index.html';
  }

  /* ------------------------------------------------------------------ 动作 */
  async function load() {
    // 静态托管没有后端：不做 404 请求，直接说明
    if (!ui.hasLocalBackend()) {
      records = [];
      $('#count').textContent = '静态预览部署';
      $('#list').innerHTML =
        '<div class="empty">' +
          '<div class="empty-ico" data-icon="monitor"></div>' +
          '<h3>静态预览部署</h3>' +
          '<p>本站没有后端服务，暂时无法读取生成历史。' +
            '在本机运行 start.ps1 后，通过 http://localhost:8230/ 访问即可正常使用。</p>' +
          '<a class="btn is-primary" href="index.html">' +
            '<span data-icon="sparkle"></span><span>返回首页</span></a>' +
        '</div>';
      ui.mountIcons($('#list'));
      return;
    }

    $('#list').innerHTML =
      '<div class="skeleton" style="height:104px;margin-bottom:14px"></div>' +
      '<div class="skeleton" style="height:104px;margin-bottom:14px"></div>' +
      '<div class="skeleton" style="height:104px"></div>';
    try {
      const data = await api.history();
      records = data.records || [];
    } catch (err) {
      records = [];
      $('#list').innerHTML =
        '<div class="empty">' +
          '<div class="empty-ico" data-icon="alert"></div>' +
          '<h3>读取失败</h3><p>' + ui.esc(api.friendly(err)) + '</p>' +
        '</div>';
      ui.mountIcons($('#list'));
      $('#count').textContent = '共 0 条记录';
      return;
    }
    render();
  }

  async function removeOne(id) {
    const r = find(id);
    if (!r) return;
    if (!window.confirm('确定删除「' + (r.title || '这条记录') + '」吗？该操作不可撤销。')) return;
    try {
      await api.remove(id);
      records = records.filter((x) => x.id !== id);
      if (sessionStorage.getItem('hz.currentId') === id) sessionStorage.removeItem('hz.currentId');
      closeDrawer();
      render();
      ui.toast('已删除', 'ok');
    } catch (err) {
      ui.toast(api.friendly(err), 'err');
    }
  }

  async function clearAll() {
    if (!records.length) { ui.toast('当前没有记录', 'info'); return; }
    if (!window.confirm('确定清空全部 ' + records.length + ' 条记录吗？该操作不可撤销。')) return;
    try {
      await api.clear();
      records = [];
      sessionStorage.removeItem('hz.currentId');
      closeDrawer();
      render();
      ui.toast('已清空全部记录', 'ok');
    } catch (err) {
      ui.toast(api.friendly(err), 'err');
    }
  }

  function downloadOpened() {
    const r = find(openedId);
    if (!r || !r.html) { ui.toast('暂无可下载的页面', 'err'); return; }
    const safe = (r.title || '视觉稿').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24);
    const blob = new Blob([r.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    ui.download(url, '绘职AI-' + (r.roleName || '') + '-' + safe + '.html');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ui.toast('已开始下载 HTML 页面', 'ok');
  }

  /* ------------------------------------------------------------------ 启动 */
  function init() {
    ui.initNav();
    ui.mountIcons(document);
    ui.guardOrigin();
    ui.pingServer();

    $('#refresh').addEventListener('click', () => { load(); ui.toast('已刷新', 'ok'); });
    $('#clearAll').addEventListener('click', clearAll);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#mask').addEventListener('click', closeDrawer);
    $('#drawerOpen').addEventListener('click', () => openedId && openInGenerator(openedId));
    $('#drawerDownload').addEventListener('click', downloadOpened);
    $('#drawerDelete').addEventListener('click', () => openedId && removeOne(openedId));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

    // 缩略图与抽屉预览都是按容器宽度缩放的，窗口尺寸变化后要重算
    window.addEventListener('resize', () => { fitThumbs(); fitDrawer(); });

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
