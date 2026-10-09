/* ==========================================================================
   绘职 AI — 设置 / 个人中心
   ========================================================================== */
(function () {
  'use strict';

  const { api, ui } = window.HZ;
  const $ = (sel) => document.querySelector(sel);

  const FALLBACK_ROLES = [
    { id: 'pm', name: '产品经理', defaultRatio: '16:9' },
    { id: 'ixd', name: '交互设计', defaultRatio: '16:9' },
    { id: 'ui', name: 'UI 设计', defaultRatio: '9:16' },
    { id: 'ops', name: '运营设计', defaultRatio: '9:16' },
    { id: 'fe', name: '前端开发', defaultRatio: '16:9' }
  ];

  let roles = FALLBACK_ROLES.slice();
  let prefs = {};

  /* ------------------------------------------------------------------ 偏好 */
  function loadPrefs() {
    try { prefs = JSON.parse(localStorage.getItem('hz.prefs') || '{}') || {}; }
    catch (_) { prefs = {}; }
  }

  function savePrefs() {
    try { localStorage.setItem('hz.prefs', JSON.stringify(prefs)); } catch (_) {}
  }

  function roleName(id) {
    const r = roles.filter((x) => x.id === id)[0];
    return r ? r.name : id;
  }

  function renderPrefs() {
    if (!prefs.roleId) prefs.roleId = (roles[0] || FALLBACK_ROLES[0]).id;

    $('#prefRoles').innerHTML = roles.map((r) =>
      '<button class="chip chip-text' + (r.id === prefs.roleId ? ' is-on' : '') + '" type="button" ' +
      'data-role="' + ui.esc(r.id) + '">' + ui.esc(r.name) + '</button>').join('');

    $('#prefSummary').textContent = roleName(prefs.roleId) + ' · 画幅由 AI 按需求自动适配';
  }

  function bindPrefs() {
    $('#prefRoles').addEventListener('click', (e) => {
      const b = e.target.closest('[data-role]');
      if (!b) return;
      prefs.roleId = b.dataset.role;
      savePrefs(); renderPrefs();
      ui.toast('默认岗位已设为「' + roleName(prefs.roleId) + '」', 'ok');
    });
  }

  /* -------------------------------------------------------------- 运行状态 */
  function describe(side) {
    if (!side || !side.configured) return '未启用';
    const name = side.name ? '（' + side.name + '）' : '';
    return side.model + name;
  }

  async function loadHealth() {
    const live = $('#svcLive');

    // 完全没有可用后端时：不探测，直接说明
    if (!ui.hasBackend()) {
      live.classList.remove('is-off');
      live.classList.add('is-warn');
      live.innerHTML = '<i aria-hidden="true"></i> 静态预览';
      $('#svcVersion').textContent = '静态部署';
      $('#svcProvider').textContent = 'Agnes AI';
      $('#svcChat').textContent = '需在本机运行后端';
      $('#svcCodegen').textContent = '需在本机运行后端';
      $('#svcReady').textContent = '静态部署不可用';
      ui.offlineBar(ui.STATIC_NOTICE);
      return;
    }

    // 一次探测失败不等于服务挂了：后端跑长任务时会被短暂占满，重试几次再下结论
    let h = null;
    for (let i = 0; i < 3 && !h; i++) {
      try { h = await api.health(4000); }
      catch (_) { if (i < 2) await new Promise((r) => setTimeout(r, 1200)); }
    }

    if (!h) {
      live.classList.remove('is-on');
      live.classList.add('is-off');
      live.innerHTML = '<i aria-hidden="true"></i> 未连接';
      ['#svcVersion', '#svcProvider', '#svcChat', '#svcCodegen', '#svcReady'].forEach((s) => {
        const el = $(s);
        if (el) el.textContent = '—';
      });
      ui.offlineBar('本地服务未响应，正在自动重试…（若长时间未恢复，请在本机运行 <strong>start.ps1</strong>）');
      ui.watchBackend();
      return;
    }

    live.classList.remove('is-off');
    live.innerHTML = '<i aria-hidden="true"></i> 正常';
    $('#svcVersion').textContent = 'v' + (h.version || '—');
    $('#svcProvider').textContent = h.provider || 'Agnes AI';
    $('#svcChat').textContent = describe(h.chat);
    $('#svcCodegen').textContent = describe(h.codegen);
    $('#svcReady').textContent = h.configured ? '就绪，可以生成视觉稿' : '服务端未配置 API 密钥';
  }

  /* -------------------------------------------------------------- 数据统计 */
  async function loadData() {
    if (!ui.hasBackend()) { $('#dataCount').textContent = '—'; return; }
    try {
      const d = await api.history();
      const n = (d.records || []).length;
      $('#dataCount').textContent = n + ' 条';
    } catch (_) {
      $('#dataCount').textContent = '—';
    }
  }

  /* ------------------------------------------------------------------ 启动 */
  function init() {
    ui.initNav();
    ui.mountIcons(document);
    ui.guardOrigin();

    loadPrefs();

    // 岗位列表优先取服务端（静态托管下没有后端，直接用内置列表）
    if (ui.hasBackend()) {
      api.roles().then((d) => {
        if (d && d.roles && d.roles.length) roles = d.roles;
        renderPrefs();
      }).catch(() => { renderPrefs(); });
    }

    renderPrefs();
    bindPrefs();

    $('#resetPrefs').addEventListener('click', () => {
      prefs = {};
      try { localStorage.removeItem('hz.prefs'); } catch (_) {}
      renderPrefs();
      ui.toast('已重置本机偏好', 'ok');
    });

    loadHealth();
    loadData();
    // 服务恢复后自动把状态刷回正常，无需用户手动刷新
    ui.onBackendUp(() => { loadHealth(); loadData(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
