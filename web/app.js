/* MikeCommand — PWA leve. Vanilla, sem build, polling só da aba ativa. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts) => {
  const r = await fetch('/api' + path, opts);
  if (!r.ok) { let e; try { e = await r.json(); } catch { e = {}; } throw new Error(e.error || ('HTTP ' + r.status)); }
  return r.json();
};

// ── Formatadores ─────────────────────────────────────────────────────────────
const fmtBytes = (b) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; b = Number(b);
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
};
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const fmtAgo = (ts) => {
  const s = Math.max(0, (Date.now() / 1000) - ts);
  if (s < 60) return 'agora'; if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
};
const colorFor = (pct) => pct >= 90 ? 'var(--crit)' : pct >= 75 ? 'var(--warn)' : 'var(--accent)';
const tempColor = (c) => c == null ? 'var(--dim)' : c >= 80 ? 'var(--crit)' : c >= 65 ? 'var(--warn)' : 'var(--accent)';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Toast ────────────────────────────────────────────────────────────────────
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', 2600);
}

// ── Gauge SVG ────────────────────────────────────────────────────────────────
function gauge({ value, label, sub, color, max = 100, suffix = '%' }) {
  const R = 42, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, (value ?? 0) / max));
  const off = C * (1 - pct);
  const display = value == null ? '—' : (Number.isInteger(value) ? value : value.toFixed(1));
  return `<div class="card gauge-card">
    <div class="gauge">
      <svg width="104" height="104" viewBox="0 0 104 104">
        <circle class="ring-bg" cx="52" cy="52" r="${R}" fill="none" stroke-width="9"></circle>
        <circle class="ring-fg" cx="52" cy="52" r="${R}" fill="none" stroke-width="9"
          stroke="${color}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
      </svg>
      <div class="center"><div class="v">${display}<span style="font-size:13px;color:var(--dim)">${value == null ? '' : suffix}</span></div><div class="l">${label}</div></div>
    </div>
    <div class="meta">${sub || ''}</div>
  </div>`;
}

// ── Sparkline ────────────────────────────────────────────────────────────────
const hist = { cpu: [], mem: [] };
function pushHist(k, v) { hist[k].push(v); if (hist[k].length > 40) hist[k].shift(); }
function sparkline(data, color = 'var(--accent)') {
  if (data.length < 2) return '';
  const w = 300, h = 38, max = 100;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`);
  const area = `0,${h} ` + pts.join(' ') + ` ${w},${h}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon class="area" points="${area}"></polygon>
    <polyline points="${pts.join(' ')}" style="stroke:${color}"></polyline></svg>`;
}

// ══ VISÃO ════════════════════════════════════════════════════════════════════
async function renderOverview() {
  const d = await api('/overview');
  const cpu = d.cpu.percent, mem = d.memory.percent, disk = d.disk.percent, temp = d.temperature.main_c;
  pushHist('cpu', cpu); pushHist('mem', mem);

  $('#gauges').innerHTML =
    gauge({ value: cpu, label: 'CPU', sub: `${d.cpu.cores} cores · load ${d.cpu.load[0]}`, color: colorFor(cpu) }) +
    gauge({ value: mem, label: 'RAM', sub: `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}`, color: colorFor(mem) }) +
    gauge({ value: temp, label: 'Temp', sub: temp == null ? 'sem sensor' : 'CPU', color: tempColor(temp), max: 100, suffix: '°' }) +
    gauge({ value: disk, label: 'Disco', sub: `${fmtBytes(d.disk.free)} livres`, color: colorFor(disk) });

  const cores = d.cpu.per_cpu.map((c, i) =>
    `<div class="core"><div class="bar"><span style="width:${c}%;background:${colorFor(c)}"></span></div>${i}</div>`).join('');

  $('#overviewExtra').innerHTML = `
    <div class="card">
      <div class="row between"><span class="kpi-label">Atividade CPU</span><span class="mono dim" style="font-size:12px">${cpu}%</span></div>
      ${sparkline(hist.cpu)}
      <div class="row between" style="margin-top:6px"><span class="kpi-label">Memória</span><span class="mono dim" style="font-size:12px">${mem}%</span></div>
      ${sparkline(hist.mem, 'var(--info)')}
    </div>
    <div class="card">
      <div class="kpi-label" style="margin-bottom:10px">Núcleos</div>
      <div class="cores">${cores}</div>
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="kpi-label">Uptime</div><div class="kpi-value">${fmtUptime(d.uptime_seconds)}</div></div>
      <div class="card"><div class="kpi-label">Load (1·5·15)</div><div class="kpi-value" style="font-size:17px">${d.cpu.load.join(' · ')}</div></div>
      <div class="card"><div class="kpi-label">Rede ↓</div><div class="kpi-value" style="font-size:17px">${fmtBytes(d.network.bytes_recv)}</div></div>
      <div class="card"><div class="kpi-label">Rede ↑</div><div class="kpi-value" style="font-size:17px">${fmtBytes(d.network.bytes_sent)}</div></div>
    </div>`;
  markSync();
}

// ══ DOCKER ═══════════════════════════════════════════════════════════════════
async function renderDocker() {
  const d = await api('/containers');
  const el = $('#containerList');
  if (!d.available) { el.innerHTML = emptyState('🐳', 'Docker indisponível', 'docker.sock não está montado.'); return; }
  if (!d.containers.length) { el.innerHTML = emptyState('🐳', 'Sem containers', 'Nada a correr.'); return; }
  el.innerHTML = d.containers.map(ct => {
    const ports = ct.ports.map(p => p.public).filter(Boolean).join(', ');
    return `<button class="item" onclick='openContainer(${JSON.stringify(ct).replace(/'/g, "&#39;")})'>
      <span class="dot ${ct.state}"></span>
      <div class="grow"><div class="name">${esc(ct.name)}</div>
        <div class="meta">${esc(ct.image)}${ports ? ' · :' + ports : ''}</div></div>
      <span class="pill ${ct.state === 'running' ? 'ok' : ct.state === 'paused' ? 'warn' : 'crit'}">${esc(ct.state)}</span>
      <span class="chev">›</span></button>`;
  }).join('');
  markSync();
}

window.openContainer = function (ct) {
  const acts = ct.state === 'running'
    ? [['restart', '↻ Reiniciar', 'primary'], ['stop', '⏹ Parar', 'danger'], ['pause', '⏸ Pausar', '']]
    : ct.state === 'paused'
      ? [['unpause', '▶ Retomar', 'primary'], ['stop', '⏹ Parar', 'danger']]
      : [['start', '▶ Arrancar', 'primary']];
  openSheet(`
    <h2>${esc(ct.name)}</h2>
    <div class="dim" style="font-size:13px;margin-bottom:14px">${esc(ct.image)} · ${esc(ct.status)}</div>
    <div class="btn-row">${acts.map(([a, l, k]) =>
      `<button class="btn ${k}" style="flex:1" onclick="containerAction('${ct.id}','${a}',this)">${l}</button>`).join('')}</div>
    <button class="btn block" style="margin-top:10px" onclick="loadLogs('${ct.id}',this)">📜 Ver logs</button>
    ${ct.compose_workdir ? `<div class="dim mono" style="font-size:11.5px;margin-top:14px">📁 ${esc(ct.compose_workdir)}</div>` : ''}
    <div id="logArea" style="margin-top:12px"></div>`);
};
window.containerAction = async function (id, action, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  try { await api(`/containers/${id}/${action}`, { method: 'POST' }); toast(`${action} ok`, 'ok'); closeSheet(); setTimeout(renderDocker, 600); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = old; }
};
window.loadLogs = async function (id, btn) {
  btn.disabled = true; btn.textContent = 'a carregar…';
  try { const d = await api(`/containers/${id}/logs?tail=200`); $('#logArea').innerHTML = `<div class="logbox">${esc(d.logs || '(vazio)')}</div>`; }
  catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = '📜 Atualizar logs';
};

// ══ SISTEMA ══════════════════════════════════════════════════════════════════
async function renderSystem() {
  const h = await api('/host');
  $('#hostCard').innerHTML = `<div class="card">
    <div class="row" style="gap:14px;margin-bottom:8px"><div class="brand"><div class="logo">🖥️</div></div>
      <div><div style="font-weight:680;font-size:16px">${esc(h.server_name)}</div><div class="dim" style="font-size:12.5px">${esc(h.os)}</div></div></div>
    ${kv('CPU', h.cpu_model)}${kv('Núcleos', h.cores)}${kv('RAM', fmtBytes(h.ram_total))}
    ${kv('Kernel', h.kernel)}${kv('Arquitetura', h.arch)}${kv('Tailscale', h.tailscale_host)}</div>`;
  renderProcs(procSort);
}
const kv = (k, v) => `<div class="row between" style="padding:7px 0;border-top:1px solid var(--line)"><span class="dim" style="font-size:13px">${k}</span><span class="mono" style="font-size:12.5px;text-align:right;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v)}</span></div>`;
let procSort = 'cpu';
async function renderProcs(sort) {
  procSort = sort;
  $('#procCpu').className = 'btn' + (sort === 'cpu' ? ' primary' : ''); $('#procCpu').style.flex = '1';
  $('#procMem').className = 'btn' + (sort === 'mem' ? ' primary' : ''); $('#procMem').style.flex = '1';
  const d = await api(`/processes?sort=${sort}&limit=18`);
  $('#procList').innerHTML = d.processes.map(p => `<div class="row between" style="padding:8px 0;border-top:1px solid var(--line)">
    <div class="grow" style="min-width:0"><div class="name" style="font-size:13.5px">${esc(p.name)}</div>
      <div class="meta">${esc(p.user)} · pid ${p.pid}</div></div>
    <span class="mono" style="font-size:13px;color:${sort === 'cpu' ? colorFor(p.cpu) : 'var(--info)'}">${sort === 'cpu' ? p.cpu + '%' : p.mem + '%'}</span></div>`).join('');
}

window.confirmReboot = function () {
  openSheet(`<h2 style="color:var(--crit)">⏻ Reiniciar a VM</h2>
    <div class="muted" style="font-size:13.5px;margin:6px 0 16px">Vais reiniciar o SO do <b>${esc(SERVER)}</b>. Os serviços sobem sozinhos, mas ficas sem acesso ~1 min. Escreve <b class="mono">${esc(SERVER)}</b> para confirmar.</div>
    <input id="rebootInput" class="logbox" style="width:100%;font-size:15px;padding:12px" placeholder="${esc(SERVER)}" autocapitalize="off" autocorrect="off" />
    <button class="btn danger block" style="margin-top:14px" onclick="doReboot(this)">Confirmar reboot</button>`);
};
window.doReboot = async function (btn) {
  const v = $('#rebootInput').value.trim();
  if (v !== SERVER) { toast('Confirmação não corresponde', 'err'); return; }
  btn.disabled = true; btn.textContent = 'a reiniciar…';
  try { const r = await api(`/system/reboot?confirm=${encodeURIComponent(SERVER)}`, { method: 'POST' }); toast(r.message || 'Reboot disparado', 'ok'); closeSheet(); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Confirmar reboot'; }
};

// ══ COMANDOS ═════════════════════════════════════════════════════════════════
async function renderCommands() {
  const d = await api('/commands');
  $('#cmdHint').innerHTML = d.host_cmd ? '' :
    `<div class="install" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.1)">⚠️ Execução no host indisponível (precisa de privileged + pid:host no compose).</div>`;
  $('#cmdList').innerHTML = d.commands.map(c => `<div class="item" style="flex-direction:column;align-items:stretch;gap:10px">
    <div class="row" style="gap:12px"><span class="ico">${c.danger ? '⚠️' : '⚡'}</span>
      <div class="grow"><div class="name">${esc(c.label)}</div><div class="meta">${esc(c.desc || '')}</div></div>
      <button class="btn ${c.danger ? 'danger' : 'primary'}" onclick="runCmd('${c.id}',this)">Correr</button></div>
    <div id="out-${c.id}"></div></div>`).join('');
}
window.runCmd = async function (id, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  const out = $('#out-' + id);
  try {
    const r = await api(`/commands/${id}/run`, { method: 'POST' });
    const body = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '') + (r.error ? '\n⚠ ' + r.error : '');
    out.innerHTML = `<div class="logbox">${esc(body.trim() || '(sem saída) · rc=' + r.rc)}</div>`;
    toast(r.ok ? 'concluído' : 'terminou com erro', r.ok ? 'ok' : 'err');
  } catch (e) { toast(e.message, 'err'); out.innerHTML = `<div class="logbox">${esc(e.message)}</div>`; }
  btn.disabled = false; btn.textContent = old;
};

// ══ APPS ═════════════════════════════════════════════════════════════════════
async function renderApps() {
  const d = await api('/apps');
  $('#appList').innerHTML = d.apps.map(a => `<a class="item" href="${esc(a.url)}" target="_blank" rel="noopener">
    <span class="ico">${a.icon}</span>
    <div class="grow"><div class="name">${esc(a.name)}</div>
      <div class="meta">:${a.port}${a.path ? ' · ' + esc(a.path) : a.container ? ' · ' + esc(a.container) : a.process ? ' · ' + esc(a.process) : ''}</div></div>
    <span class="dot ${a.state === 'running' || a.state === 'listen' ? (a.state === 'running' ? 'running' : 'listen') : 'exited'}"></span>
    <span class="chev">↗</span></a>`).join('') || emptyState('🔌', 'Sem apps', 'Nenhuma porta detetada.');
  markSync();
}

// ══ ALERTAS ══════════════════════════════════════════════════════════════════
async function renderAlerts() {
  const d = await api('/alerts');
  const t = d.thresholds;
  $('#alertConfig').innerHTML = `<div class="card">
    <div class="row between"><span style="font-weight:650">Notificações Telegram</span>
      <span class="pill ${d.telegram ? 'ok' : 'crit'}">${d.telegram ? 'ligado' : 'por configurar'}</span></div>
    <div class="dim" style="font-size:12.5px;margin:8px 0 14px">${d.telegram ? 'Recebes push quando algo precisa de ação.' : 'Preenche TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env.'}</div>
    <div class="grid grid-2" style="gap:8px">
      ${thr('CPU', t.cpu_pct, '%')}${thr('RAM', t.mem_pct, '%')}${thr('Disco', t.disk_pct, '%')}${thr('Temp', t.temp_c, '°C')}</div>
    <button class="btn primary block" style="margin-top:14px" onclick="testAlert(this)" ${d.telegram ? '' : 'disabled'}>📲 Enviar teste</button>
  </div>`;
  const h = d.history;
  $('#alertHistory').innerHTML = h.length ? h.map(a => `<div class="item">
    <span class="dot ${a.level === 'critical' ? 'crit' : a.level === 'warning' ? 'warn' : 'ok'}"></span>
    <div class="grow"><div class="name" style="font-size:13.5px">${esc(a.title)}</div><div class="meta">${esc(a.body.replace(/<[^>]+>/g, ''))}</div></div>
    <div style="text-align:right"><div class="dim" style="font-size:11px">${fmtAgo(a.ts)}</div>${a.pushed ? '<div class="dim" style="font-size:10px">📲</div>' : ''}</div></div>`).join('')
    : emptyState('✅', 'Tudo calmo', 'Sem alertas recentes.');
}
const thr = (l, v, u) => `<div class="card" style="padding:11px"><div class="kpi-label">${l}</div><div class="kpi-value" style="font-size:18px">${v}<span class="unit">${u}</span></div></div>`;
window.testAlert = async function (btn) {
  btn.disabled = true; btn.textContent = 'a enviar…';
  try { await api('/alerts/test', { method: 'POST' }); toast('Push enviado ✅', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = '📲 Enviar teste';
};

// ── Helpers UI ───────────────────────────────────────────────────────────────
const emptyState = (icon, t, s) => `<div class="empty"><div class="big">${icon}</div><div style="font-weight:600;color:var(--mut)">${t}</div><div style="font-size:13px;margin-top:4px">${s}</div></div>`;
function openSheet(html) { $('#sheet').innerHTML = `<div class="handle"></div>` + html; $('#sheet').classList.add('open'); $('#scrim').classList.add('open'); }
function closeSheet() { $('#sheet').classList.remove('open'); $('#scrim').classList.remove('open'); }
$('#scrim').addEventListener('click', closeSheet);

let lastSync = 0;
function markSync() { lastSync = Date.now(); updateSync(); }
function updateSync() {
  const el = $('#syncText');
  if (!lastSync) return;
  const s = Math.floor((Date.now() - lastSync) / 1000);
  el.textContent = 'sync ' + (s < 5 ? 'agora' : s + 's');
}
setInterval(updateSync, 5000);

function setStatus(ok) {
  $('#statusDot').className = 'statusdot' + (ok ? '' : ' off');
  $('#statusText').textContent = ok ? 'online' : 'offline';
}

// ── Router + polling ─────────────────────────────────────────────────────────
const RENDER = { overview: renderOverview, docker: renderDocker, system: renderSystem, commands: renderCommands, apps: renderApps, alerts: renderAlerts };
const POLL_MS = { overview: 4000, docker: 7000, apps: 15000, alerts: 12000 };
let current = 'overview', pollT = null;

async function load(view) {
  try { await RENDER[view](); setStatus(true); }
  catch (e) { setStatus(false); if (view === current) console.warn(view, e.message); }
}
function schedule() {
  clearTimeout(pollT);
  const ms = POLL_MS[current];
  if (!ms) return;
  pollT = setTimeout(async function tick() {
    if (document.visibilityState === 'visible') await load(current);
    pollT = setTimeout(tick, ms);
  }, ms);
}
function go(view) {
  current = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  window.scrollTo({ top: 0 });
  load(view); schedule();
}
$$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
$('#procCpu').addEventListener('click', () => renderProcs('cpu'));
$('#procMem').addEventListener('click', () => renderProcs('mem'));
$('#rebootBtn').addEventListener('click', confirmReboot);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(current); });

// ── Bootstrap ────────────────────────────────────────────────────────────────
let SERVER = 'MikeServer';
(async function init() {
  try { const h = await api('/host'); SERVER = h.server_name; $('#hostSub').textContent = h.os; } catch {}
  go('overview');
  // badge de alertas críticos no tab
  setInterval(async () => {
    try {
      const d = await api('/alerts');
      const crit = d.history.filter(a => a.level === 'critical' && (Date.now() / 1000 - a.ts) < 3600).length;
      const tab = $('.tab[data-view="alerts"]');
      tab.querySelector('.badge')?.remove();
      if (crit) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = crit > 9 ? '9+' : crit; tab.appendChild(b); }
    } catch {}
  }, 20000);
})();

// ── Install banner (PWA) ─────────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  if (localStorage.getItem('mc_install_dismissed')) return;
  $('#installBanner').innerHTML = `<div class="install">📲 <div>Instala o MikeCommand no telemóvel</div>
    <button class="btn primary" style="min-height:36px;margin-left:auto" id="installBtn">Instalar</button>
    <span class="x" id="installX">✕</span></div>`;
  $('#installBtn').onclick = async () => { deferredPrompt.prompt(); deferredPrompt = null; $('#installBanner').innerHTML = ''; };
  $('#installX').onclick = () => { localStorage.setItem('mc_install_dismissed', '1'); $('#installBanner').innerHTML = ''; };
});

// ── Service worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
