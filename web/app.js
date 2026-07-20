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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Toast + haptics ──────────────────────────────────────────────────────────
const haptic = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  if (kind === 'ok') haptic(12); else if (kind === 'err') haptic([30, 40, 30]);
  clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', 2600);
}

// ── Gauge SVG (size ajustável p/ 3-up) ───────────────────────────────────────
function sparkline(arr, color, w = 72, h = 20) {
  if (!arr || arr.length < 2) return '';
  const max = Math.max(...arr, 1), min = Math.min(...arr, 0);
  const span = Math.max(max - min, 1);
  const pts = arr.map((v, i) => `${(i / (arr.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="gspark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" opacity=".8"/></svg>`;
}
function gauge({ value, label, sub, color, max = 100, suffix = '%', size = 104, spark = null }) {
  const sw = Math.max(6, Math.round(size * 0.085));
  const R = (size - sw) / 2 - 2;
  const c = size / 2, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, (value ?? 0) / max));
  const off = C * (1 - pct);
  const display = value == null ? '—' : (Number.isInteger(value) ? value : value.toFixed(1));
  const vf = Math.round(size * 0.25);
  return `<div class="card gauge-card">
    <div class="gauge">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
        <circle class="ring-bg" cx="${c}" cy="${c}" r="${R}" fill="none" stroke-width="${sw}"></circle>
        <circle class="ring-fg" cx="${c}" cy="${c}" r="${R}" fill="none" stroke-width="${sw}"
          stroke="${color}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
      </svg>
      <div class="center"><div class="v" style="font-size:${vf}px">${display}<span style="font-size:${Math.round(vf * 0.5)}px;color:var(--dim)">${value == null ? '' : suffix}</span></div><div class="l">${label}</div></div>
    </div>
    ${sub ? `<div class="meta">${sub}</div>` : ''}
    ${spark ? sparkline(spark, color) : ''}
  </div>`;
}

// ── Carga traduzida (load vs nº de cores) ────────────────────────────────────
function loadHealth(load, cores) {
  const r = load / (cores || 1);
  if (r < 0.7) return ['folgado', 'var(--ok)'];
  if (r < 1.0) return ['ocupado', 'var(--warn)'];
  return ['sobrecarga', 'var(--crit)'];
}


// ══ HOME ═════════════════════════════════════════════════════════════════════
const _aux = { t: 0, containers: null, alerts: null, apps: null, map: null };
const _gb = (b) => (b / 1e9).toFixed(b >= 1e10 ? 0 : 1);
const fact = (l, v) => `<div><div class="kpi-label">${l}</div><div style="font-weight:650;font-size:14px;margin-top:3px">${v}</div></div>`;
// séries curtas para as sparklines dos gauges (cliente, leve)
const _hist = { cpu: [], mem: [], disk: [] };
const _push = (k, v) => { const a = _hist[k]; if (v != null) { a.push(v); if (a.length > 40) a.shift(); } };

let _histSeeded = false;
async function renderHome() {
  // seed das sparklines a partir do histórico do servidor (sobrevive a reloads)
  if (!_histSeeded) {
    _histSeeded = true;
    try {
      const h = await api('/metrics/history?minutes=30');
      h.points.forEach(p => { _push('cpu', p.cpu); _push('mem', p.mem); _push('disk', p.disk); });
    } catch {}
  }
  const d = await api('/overview');
  const cpu = d.cpu.percent, mem = d.memory.percent, disk = d.disk.percent;
  _push('cpu', cpu); _push('mem', mem); _push('disk', disk);

  $('#gauges').innerHTML =
    gauge({ value: cpu, label: 'CPU', sub: `${d.cpu.cores} cores`, color: colorFor(cpu), size: 84, spark: _hist.cpu }) +
    gauge({ value: mem, label: 'RAM', sub: `${_gb(d.memory.used)}/${_gb(d.memory.total)}G`, color: colorFor(mem), size: 84, spark: _hist.mem }) +
    gauge({ value: disk, label: 'Disco', sub: `${_gb(d.disk.free)}G livres`, color: colorFor(disk), size: 84, spark: _hist.disk });

  // dados auxiliares (containers/alertas/apps/mapa) — puxados com menos frequência (leve no N97)
  if (Date.now() - _aux.t > 11000) {
    _aux.t = Date.now();
    Promise.all([api('/containers').catch(() => null), api('/alerts').catch(() => null),
                 api('/apps').catch(() => null), api('/map').catch(() => null)])
      .then(([c, a, ap, m]) => { _aux.containers = c; _aux.alerts = a; _aux.apps = ap; _aux.map = m; if (current === 'home') drawHome(d); });
  }
  drawHome(d);
  markSync();
}

// ── Hero de saúde global — um estado que resume tudo, antes de qualquer detalhe ──
function heroState(d) {
  const now = Date.now() / 1000;
  const critAlerts = ((_aux.alerts && _aux.alerts.history) || []).filter(a => a.level === 'critical' && now - a.ts < 3600).length;
  let run = null, total = null, down = 0;
  if (_aux.containers && _aux.containers.available) {
    const cs = _aux.containers.containers;
    total = cs.length; run = cs.filter(x => x.state === 'running').length; down = total - run;
  }
  const hot = d.cpu.percent >= 90 || d.memory.percent >= 90 || d.disk.percent >= 90;
  const warm = d.cpu.percent >= 75 || d.memory.percent >= 75 || d.disk.percent >= 88;
  let cls = 'ok', icon = '✓', title = 'Tudo saudável';
  if (critAlerts || hot) { cls = 'crit'; icon = '!'; title = 'Problemas ativos'; }
  else if (down > 0 || warm) { cls = 'warn'; icon = '△'; title = 'Precisa de atenção'; }
  const bits = [];
  if (total != null) bits.push(`${run}/${total} containers`);
  bits.push(critAlerts ? `${critAlerts} alerta${critAlerts > 1 ? 's' : ''} crítico${critAlerts > 1 ? 's' : ''} (1h)` : '0 alertas ativos');
  return { cls, icon, title, sub: bits.join(' · ') };
}

function drawHome(d) {
  // onboarding 1ª vez — explica a Home e onde vive o mapa
  if (!localStorage.getItem('mc_onboarded')) {
    $('#onboard').innerHTML = `<div class="install">👋 <div><b>Bem-vindo ao cockpit.</b> Esta é a Home — a saúde do servidor num relance. O mapa vive em <b>Infra → Mapa</b>; comandos e sessões Claude em <b>Automação</b>.</div>
      <button class="x" id="onboardX" aria-label="Dispensar boas-vindas">✕</button></div>`;
    $('#onboardX').onclick = () => { localStorage.setItem('mc_onboarded', '1'); $('#onboard').innerHTML = ''; };
  }
  const hs = heroState(d);
  $('#heroHealth').innerHTML = `<div class="hero ${hs.cls}">
    <div class="hero-ico" aria-hidden="true">${hs.icon}</div>
    <div><div class="hero-title">${hs.title}</div><div class="hero-sub">${hs.sub}</div></div>
  </div>`;

  // ── Precisa de atenção — só aparece quando há algo; o que está bem recolhe-se ──
  const now = Date.now() / 1000;
  const hist = ((_aux.alerts && _aux.alerts.history) || []).filter(a => now - a.ts < 6 * 3600).slice(0, 4);
  $('#attention').innerHTML = !hist.length ? '' :
    `<div class="view-title" style="margin:14px 2px 8px">Precisa de atenção</div><div class="list">` +
    hist.map(a => `<div class="item">
      <span class="dot ${a.level === 'critical' ? 'crit' : a.level === 'warning' ? 'warn' : 'ok'}"></span>
      <div class="grow"><div class="name" style="font-size:13.5px">${esc(a.title)}</div>
        <div class="meta">${esc((a.body || '').replace(/<[^>]+>/g, ''))}</div></div>
      <span class="dim" style="font-size:12px">${fmtAgo(a.ts)}</span></div>`).join('') + `</div>`;

  drawMapPreview();

  // ── Faixa de factos ──
  const [lw, lc] = loadHealth(d.cpu.load[2], d.cpu.cores);
  let cRun = '—', cStop = '—';
  if (_aux.containers && _aux.containers.available) {
    const cs = _aux.containers.containers;
    cRun = cs.filter(x => x.state === 'running').length;
    cStop = cs.length - cRun;
  }
  const appsN = _aux.apps ? _aux.apps.apps.filter(a => a.state === 'running' || a.state === 'listen').length : '—';
  $('#facts').innerHTML = `<div class="card" style="padding:14px"><div class="grid grid-2" style="gap:14px">
    ${fact('Uptime', fmtUptime(d.uptime_seconds))}
    ${fact('Carga', `<span style="color:${lc}">${lw}</span> · ${d.cpu.load[2]}/${d.cpu.cores}`)}
    ${fact('Containers', `${cRun} <span class="dim">a correr</span> · ${cStop} <span class="dim">parados</span>`)}
    ${fact('Apps', `${appsN} <span class="dim">online</span>`)}
  </div></div>`;
}

// ── Mapa como preview vivo — cartão clicável que abre a vista completa ──
function drawMapPreview() {
  const m = _aux.map;
  if (!m || !m.nodes) { return; }
  const W = 300, H = 132, cx = W / 2, cy = H / 2;
  const n = m.nodes.length || 1;
  const dots = m.nodes.map((nd, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(ang) * (W * 0.36), y = cy + Math.sin(ang) * (H * 0.36);
    return `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${cx}" y2="${cy}" stroke="${nd.status === 'up' ? 'var(--ok)' : 'var(--crit)'}" stroke-width="1" stroke-dasharray="2 5" opacity=".4"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#0a0f18" stroke="${nd.status === 'up' ? 'var(--ok)' : 'var(--crit)'}" stroke-width="1.6"/>`;
  }).join('');
  const core = `<circle cx="${cx}" cy="${cy}" r="13" fill="#07120f" stroke="var(--accent)" stroke-width="2"/>`;
  $('#mapPreview').innerHTML = `<button class="card mappre" onclick="openFullMap()" aria-label="Abrir o mapa do servidor">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${dots}${core}</svg>
    <div class="row between" style="margin-top:8px">
      <div><div style="font-weight:650;font-size:14px">Mapa do servidor</div>
        <div class="meta" style="font-size:12px;color:var(--dim)">${m.up}/${m.total} serviços · tocar para abrir</div></div>
      <span class="pill ok">ao vivo</span>
    </div>
  </button>`;
}
window.openFullMap = function () { setSeg('map'); go('infra'); };

// ══ DOCKER (agrupado por stack compose, com ações em lote) ═══════════════════
async function renderDocker() {
  const d = await api('/containers');
  const el = $('#containerList');
  if (!d.available) { el.innerHTML = emptyState('🐳', 'Docker indisponível', esc(d.error || 'docker.sock não acessível.')); return; }
  if (!d.containers.length) { el.innerHTML = emptyState('🐳', 'Sem containers', 'Nada a correr.'); return; }
  const item = (ct) => {
    const ports = ct.ports.map(p => p.public).filter(Boolean).join(', ');
    return `<button class="item" onclick='openContainer(${JSON.stringify(ct).replace(/'/g, "&#39;")})'>
      <span class="dot ${ct.state}"></span>
      <div class="grow"><div class="name">${esc(ct.name)}</div>
        <div class="meta">${esc(ct.image)}${ports ? ' · :' + ports : ''}</div></div>
      <span class="pill ${ct.state === 'running' ? 'ok' : ct.state === 'paused' ? 'warn' : 'crit'}">${esc(ct.state)}</span>
      <span class="chev">›</span></button>`;
  };
  // agrupar por projeto compose; containers soltos ficam num grupo próprio
  const groups = new Map();
  d.containers.forEach(ct => {
    const k = ct.compose_project || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(ct);
  });
  const solo = groups.size === 1 && groups.has('');
  el.innerHTML = [...groups.entries()].map(([proj, cs]) => {
    const head = solo ? '' : proj
      ? `<div class="stackhead"><span class="stackname">📦 ${esc(proj)}</span><span class="dim" style="font-size:12px">${cs.length}</span>
          <button class="btn stackbtn" onclick="stackRestart('${esc(proj)}',this)">↻ stack</button></div>`
      : `<div class="stackhead"><span class="stackname">sem stack</span></div>`;
    return head + cs.map(item).join('');
  }).join('');
  markSync();
}
window.stackRestart = async function (proj, btn) {
  // dois toques: o primeiro arma, o segundo confirma (ação em lote)
  if (btn.dataset.arm !== '1') {
    btn.dataset.arm = '1'; btn.textContent = 'confirmar ↻'; btn.classList.add('danger');
    setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = ''; btn.textContent = '↻ stack'; btn.classList.remove('danger'); } }, 3500);
    return;
  }
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api(`/stacks/${encodeURIComponent(proj)}/restart`, { method: 'POST' });
    const n = (r.results || []).filter(x => x.ok).length;
    toast(`Stack ${proj}: ${n} reiniciado${n === 1 ? '' : 's'}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  setTimeout(renderDocker, 800);
};

window.openContainer = function (ct) {
  const acts = ct.state === 'running'
    ? [['restart', '↻ Reiniciar', 'primary'], ['stop', '⏹ Parar', 'danger'], ['pause', '⏸ Pausar', '']]
    : ct.state === 'paused'
      ? [['unpause', '▶ Retomar', 'primary'], ['stop', '⏹ Parar', 'danger']]
      : [['start', '▶ Arrancar', 'primary']];
  openSheet(`
    <h2>${esc(ct.name)}</h2>
    <div class="dim" style="font-size:13px;margin-bottom:12px">${esc(ct.image)} · ${esc(ct.status)}</div>
    <div id="ctHelper"><div class="skeleton" style="height:90px;border-radius:14px"></div></div>
    <div id="ctStats" class="grid grid-2" style="margin:14px 0"></div>
    <div class="btn-row">${acts.map(([a, l, k]) =>
      `<button class="btn ${k}" style="flex:1" onclick="containerAction('${ct.id}','${a}',this)">${l}</button>`).join('')}</div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn" style="flex:1" onclick="loadLogs('${ct.id}',this)">📜 Logs</button>
      <button class="btn" style="flex:1" onclick="toggleLiveLogs('${ct.id}',this)">▶ Ao vivo</button>
    </div>
    ${ct.compose_workdir ? `<div class="dim mono" style="font-size:11.5px;margin-top:14px">📁 ${esc(ct.compose_workdir)}</div>` : ''}
    <div id="logArea" style="margin-top:12px"></div>
    ${ct.state !== 'running' ? `<div id="rmZone" style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <button class="btn danger block" onclick="confirmRemove('${ct.id}','${esc(ct.name)}',this)">🗑️ Remover container</button></div>` : ''}`);
  loadHelper(ct.id);
  if (ct.state === 'running') loadStats(ct.id);
};
const CRIT = {
  alta: ['crit', '🔴 Crítico'], media: ['warn', '🟠 Importante'],
  baixa: ['ok', '🟢 Não-crítico'], desconhecida: ['warn', '❓ A triar'],
};
window.loadHelper = async function (id) {
  try {
    const d = await api(`/containers/${id}/inspect`);
    if (!d.ok) { $('#ctHelper').innerHTML = ''; return; }
    const h = d.helper; const [cls, label] = CRIT[h.critical] || CRIT.desconhecida;
    const urls = (d.urls || []).map(u => `<a class="btn primary" style="flex:1" href="${esc(u.url)}" target="_blank" rel="noopener">↗ Abrir :${u.port}</a>`).join('');
    const meta = [
      d.health ? `saúde: ${esc(d.health)}` : null,
      `restarts: ${d.restart_count}`,
      d.mounts ? `${d.mounts} volume(s)` : null,
      d.ports.length ? 'porta ' + d.ports.map(p => p.public).join(', ') : 'sem porta exposta',
    ].filter(Boolean).join(' · ');
    $('#ctHelper').innerHTML = `<div class="card" style="border-color:${cls === 'crit' ? 'rgba(251,113,133,.3)' : cls === 'warn' ? 'rgba(251,191,36,.25)' : 'var(--line)'}">
      <div class="row between"><div class="row" style="gap:9px"><span class="ico">${h.icon}</span><span style="font-weight:650">${esc(h.what)}</span></div><span class="pill ${cls}">${label}</span></div>
      ${h.purpose ? `<div class="muted" style="font-size:13px;margin-top:8px">${esc(h.purpose)}</div>` : ''}
      <div style="font-size:12.5px;margin-top:8px"><span class="dim">Se desligar:</span> ${mdBold(esc(h.impact))}</div>
      <div class="dim mono" style="font-size:11px;margin-top:10px">${meta}</div>
      ${urls ? `<div class="btn-row" style="margin-top:12px">${urls}</div>` : ''}
    </div>`;
  } catch { $('#ctHelper').innerHTML = ''; }
};
const mdBold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
window.confirmRemove = function (id, name, btn) {
  // 1ª confirmação: revela a zona de perigo com input para escrever o nome (2ª confirmação)
  const zone = document.getElementById('rmZone');
  zone.innerHTML = `<div class="card" style="border-color:rgba(251,113,133,.4);background:rgba(251,113,133,.06)">
    <div style="color:var(--crit);font-weight:680;margin-bottom:6px">⚠️ Remover definitivamente</div>
    <div class="muted" style="font-size:12.5px;margin-bottom:10px">Remove o container <b class="mono">${esc(name)}</b>. Os volumes/dados ficam, mas o container desaparece e não há volta. Escreve <b class="mono">${esc(name)}</b> para confirmar:</div>
    <input id="rmInput" class="logbox" style="width:100%;font-size:14px;padding:11px" placeholder="${esc(name)}" autocapitalize="off" autocorrect="off" spellcheck="false" />
    <div class="btn-row" style="margin-top:10px">
      <button class="btn" style="flex:1" onclick="closeSheet()">Cancelar</button>
      <button class="btn danger" style="flex:1" onclick="doRemove('${id}','${esc(name)}',this)">Remover</button>
    </div></div>`;
  $('#rmInput').focus();
};
window.doRemove = async function (id, name, btn) {
  if ($('#rmInput').value.trim() !== name) { toast('O nome não corresponde', 'err'); return; }
  btn.disabled = true; btn.textContent = '…';
  try {
    await api(`/containers/${id}/remove?confirm=${encodeURIComponent(name)}`, { method: 'POST' });
    toast(`${name} removido`, 'ok'); closeSheet(); setTimeout(renderDocker, 500);
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Remover'; }
};
window.loadStats = async function (id) {
  try {
    const s = await api(`/containers/${id}/stats`);
    if (!s.ok) return;
    $('#ctStats').innerHTML =
      `<div class="card" style="padding:11px"><div class="kpi-label">CPU</div><div class="kpi-value" style="font-size:19px;color:${colorFor(s.cpu)}">${s.cpu}<span class="unit">%</span></div></div>
       <div class="card" style="padding:11px"><div class="kpi-label">RAM</div><div class="kpi-value" style="font-size:19px;color:${colorFor(s.mem_pct)}">${s.mem_pct}<span class="unit">%</span></div><div class="dim" style="font-size:11px;margin-top:2px">${fmtBytes(s.mem_used)}</div></div>`;
  } catch {}
};
window.containerAction = async function (id, action, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  try { await api(`/containers/${id}/${action}`, { method: 'POST' }); toast(`${action} ok`, 'ok'); closeSheet(); setTimeout(renderDocker, 600); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = old; }
};
window.loadLogs = async function (id, btn) {
  stopLiveLogs();
  btn.disabled = true; btn.textContent = 'a carregar…';
  try { const d = await api(`/containers/${id}/logs?tail=200`); $('#logArea').innerHTML = `<div class="logbox">${esc(d.logs || '(vazio)')}</div>`; }
  catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = '📜 Atualizar';
};

// ── Logs ao vivo (SSE) — streaming em vez de snapshot + refresh manual ──────
let _es = null, _esBtn = null;
function stopLiveLogs() {
  if (_es) { _es.close(); _es = null; }
  if (_esBtn && _esBtn.isConnected) _esBtn.textContent = '▶ Ao vivo';
  _esBtn = null;
}
window.toggleLiveLogs = function (id, btn) {
  if (_es) { stopLiveLogs(); return; }
  $('#logArea').innerHTML = `<div class="logbox" id="liveLog" style="max-height:32vh">a ligar ao stream…\n</div>`;
  const box = $('#liveLog');
  _es = new EventSource(`/api/containers/${id}/logs/stream?tail=100`);
  _esBtn = btn; btn.textContent = '⏸ Parar';
  let first = true;
  _es.onmessage = (ev) => {
    if (first) { box.textContent = ''; first = false; }
    box.textContent += ev.data + '\n';
    if (box.textContent.length > 60000) box.textContent = box.textContent.slice(-45000);
    box.scrollTop = box.scrollHeight;
  };
  _es.onerror = () => { stopLiveLogs(); };
};

// ══ SISTEMA ══════════════════════════════════════════════════════════════════
async function renderSystem() {
  const h = await api('/host');
  $('#hostCard').innerHTML = `<div class="card">
    <div class="row" style="gap:14px;margin-bottom:8px"><div class="brand"><div class="logo">🖥️</div></div>
      <div><div style="font-weight:680;font-size:16px">${esc(h.server_name)}</div><div class="dim" style="font-size:12.5px">${esc(h.os)}</div></div></div>
    ${kv('CPU', h.cpu_model)}${kv('Núcleos', h.cores)}${kv('RAM', fmtBytes(h.ram_total))}
    ${kv('Kernel', h.kernel)}${kv('Arquitetura', h.arch)}${kv('Tailscale', h.tailscale_host)}</div>`;
  renderTailscale(); renderBackups(); renderProcs(procSort); renderHistory();
}

// ── Histórico de métricas (gráfico SVG leve, sem dependências) ───────────────
let histMin = 60;
async function renderHistory() {
  $$('.hwin').forEach(b => { b.classList.toggle('primary', +b.dataset.min === histMin); });
  const el = $('#histChart');
  try {
    const d = await api(`/metrics/history?minutes=${histMin}`);
    const pts = d.points || [];
    if (pts.length < 2) { el.innerHTML = `<div class="empty" style="padding:12px">Ainda a recolher amostras — volta daqui a uns minutos.</div>`; return; }
    const W = 320, H = 120;
    const line = (key, color, max = 100) => {
      if (!pts.some(p => p[key] != null)) return '';
      const path = pts.map((p, i) => p[key] == null ? null :
        `${(i / (pts.length - 1) * W).toFixed(1)},${(H - 6 - Math.min(1, p[key] / max) * (H - 14)).toFixed(1)}`)
        .filter(Boolean).join(' ');
      return `<polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    const fmt = (ts) => new Date(ts * 1000).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img" aria-label="Gráfico de CPU, RAM e temperatura">
        <line x1="0" y1="${H - 6}" x2="${W}" y2="${H - 6}" stroke="var(--line-2)"/>
        <line x1="0" y1="${H - 6 - (H - 14) / 2}" x2="${W}" y2="${H - 6 - (H - 14) / 2}" stroke="var(--line)" stroke-dasharray="3 6"/>
        ${line('cpu', 'var(--accent)')}${line('mem', 'var(--info)')}${line('temp', 'var(--warn)', 110)}
      </svg>
      <div class="row between" style="margin-top:6px">
        <span class="dim" style="font-size:12px">${fmt(pts[0].ts)}</span>
        <span style="font-size:12px"><span style="color:var(--accent)">■</span> CPU&nbsp; <span style="color:var(--info)">■</span> RAM&nbsp; <span style="color:var(--warn)">■</span> Temp</span>
        <span class="dim" style="font-size:12px">${fmt(pts[pts.length - 1].ts)}</span>
      </div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="padding:12px">${esc(e.message)}</div>`; }
}
$$('.hwin').forEach(b => b.addEventListener('click', () => { histMin = +b.dataset.min; renderHistory(); }));
async function renderTailscale() {
  const el = $('#tailscaleCard');
  try {
    const t = await api('/tailscale');
    if (!t.available) { el.innerHTML = `<div class="card"><div class="dim">${esc(t.error || 'indisponível')}</div></div>`; return; }
    const ok = t.state === 'Running';
    const devices = t.devices.map(d => `<div class="row between" style="padding:6px 0;border-top:1px solid var(--line)">
      <div class="row" style="gap:9px"><span class="dot ${d.online ? 'ok' : 'exited'}"></span><span style="font-size:13.5px">${esc(d.name)}</span><span class="dim" style="font-size:11px">${esc(d.os)}</span></div>
      <span class="mono dim" style="font-size:11px">${esc(d.ip)}</span></div>`).join('');
    el.innerHTML = `<div class="card">
      <div class="row between"><div class="row" style="gap:9px"><span class="dot ${ok ? 'ok' : 'crit'}"></span><span style="font-weight:650">${esc(t.state)}</span></div>
        <span class="pill ${ok ? 'ok' : 'crit'}">${t.peers_online}/${t.peers_total} online</span></div>
      ${kv('Este host', t.hostname + ' · ' + t.ip)}${t.key_expiry ? kv('Chave expira', new Date(t.key_expiry).toLocaleDateString('pt-PT')) : ''}
      <div class="dim" style="font-size:11.5px;margin:10px 0 2px">Dispositivos na tailnet</div>${devices}</div>`;
  } catch (e) { el.innerHTML = `<div class="card"><div class="dim">${esc(e.message)}</div></div>`; }
}
async function renderBackups() {
  const el = $('#backupsCard');
  try {
    const b = await api('/backups');
    if (!b.available) { el.innerHTML = `<div class="card"><div class="dim">${esc(b.error || 'indisponível')}</div></div>`; return; }
    el.innerHTML = b.repos.map(r => {
      const unsaved = r.ahead > 0 || r.dirty > 0;
      const pill = !r.ok ? '<span class="pill crit">sem git</span>'
        : unsaved ? `<span class="pill warn">${r.ahead} por enviar${r.dirty ? ' · ' + r.dirty + ' alt.' : ''}</span>`
        : '<span class="pill ok">sincronizado</span>';
      return `<div class="card" style="margin-bottom:8px"><div class="row between"><span style="font-weight:640">${esc(r.name)}</span>${pill}</div>
        ${r.last ? `<div class="dim" style="font-size:12.5px;margin-top:6px">${esc(r.last.when)} · <span class="mono">${esc(r.last.hash)}</span> ${esc(r.last.msg)}</div>` : '<div class="dim" style="font-size:12.5px;margin-top:6px">sem commits</div>'}</div>`;
    }).join('');
  } catch (e) { el.innerHTML = `<div class="card"><div class="dim">${esc(e.message)}</div></div>`; }
}
const kv = (k, v) => `<div class="row between" style="padding:7px 0;border-top:1px solid var(--line)"><span class="dim" style="font-size:13px">${k}</span><span class="mono" style="font-size:12.5px;text-align:right;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v)}</span></div>`;
let procSort = 'cpu';
async function renderProcs(sort) {
  procSort = sort;
  $('#procCpu').className = 'btn' + (sort === 'cpu' ? ' primary' : ''); $('#procCpu').style.flex = '1';
  $('#procMem').className = 'btn' + (sort === 'mem' ? ' primary' : ''); $('#procMem').style.flex = '1';
  const d = await api(`/processes?sort=${sort}&limit=18`);
  $('#procList').innerHTML = d.processes.map(p => `<button class="row between" style="padding:8px 0;border-top:1px solid var(--line);width:100%;background:none;border-left:0;border-right:0;border-bottom:0;color:inherit;text-align:left" onclick='openProc(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
    <div class="grow" style="min-width:0"><div class="name" style="font-size:13.5px">${esc(p.name)}</div>
      <div class="meta">${esc(p.user)} · pid ${p.pid}</div></div>
    <span class="mono" style="font-size:13px;color:${sort === 'cpu' ? colorFor(p.cpu) : 'var(--info)'}">${sort === 'cpu' ? p.cpu + '%' : p.mem + '%'}</span>
    <span class="chev">›</span></button>`).join('');
}
window.openProc = function (p) {
  openSheet(`<h2>${esc(p.name)}</h2>
    <div class="dim mono" style="font-size:12px;margin-bottom:10px">pid ${p.pid} · ${esc(p.user)}</div>
    <div class="grid grid-2" style="margin-bottom:12px">
      <div class="card" style="padding:11px"><div class="kpi-label">CPU</div><div class="kpi-value" style="font-size:19px;color:${colorFor(p.cpu)}">${p.cpu}<span class="unit">%</span></div></div>
      <div class="card" style="padding:11px"><div class="kpi-label">RAM</div><div class="kpi-value" style="font-size:19px;color:var(--info)">${p.mem}<span class="unit">%</span></div></div></div>
    <div class="logbox" style="margin-bottom:14px;max-height:120px">${esc(p.cmd)}</div>
    <div class="btn-row">
      <button class="btn danger" style="flex:1" onclick="killProc(${p.pid},'term',this)">⏹ Terminar (SIGTERM)</button>
      <button class="btn danger" style="flex:1" onclick="killProc(${p.pid},'kill',this)">💀 Forçar (SIGKILL)</button>
    </div>
    <div class="dim" style="font-size:11.5px;margin-top:10px;text-align:center">SIGTERM pede para fechar; SIGKILL mata à força.</div>`);
};
window.killProc = async function (pid, sig, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  try { const r = await api(`/processes/${pid}/kill?sig=${sig}`, { method: 'POST' }); toast(`${r.name || 'pid ' + pid} terminado`, 'ok'); closeSheet(); setTimeout(() => renderProcs(procSort), 700); }
  catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = old; }
};

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
async function renderClaude() {
  const d = await api('/claude/projects');
  claudeProjects = d.projects;
  if (!d.available) {
    $('#claudeProjects').innerHTML = `<div class="install" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.1)">⚠️ Execução no host indisponível (precisa de privileged + pid:host).</div>`;
  }
  drawClaude();
  if (d.available) claudeRefreshStatus();
}
let claudeProjects = [];
function drawClaude() {
  $('#claudeProjects').innerHTML = claudeProjects.map(p => {
    const st = p.status || 'unknown';
    const pill = st === 'online' ? '<span class="pill ok">online</span>'
      : st === 'offline' ? '<span class="pill">offline</span>'
      : '<span class="pill warn">…</span>';
    return `<div class="item" style="flex-direction:column;align-items:stretch;gap:11px">
      <div class="row" style="gap:12px">
        <span class="dot ${st === 'online' ? 'ok' : st === 'offline' ? 'exited' : 'warn'}"></span>
        <div class="grow"><div class="name">claude-${esc(p.name)}</div><div class="meta mono">${esc(p.path)}</div></div>
        ${pill}
      </div>
      <div class="btn-row">
        <button class="btn primary" style="flex:1.2" onclick="claudeAct('${p.name}','start',this)">▶ Start</button>
        <button class="btn" style="flex:1.2" onclick="claudeAct('${p.name}','restart',this)">↻ Restart</button>
        <button class="btn danger" style="flex:1" onclick="claudeAct('${p.name}','stop',this)">⏹ Stop</button>
        <button class="btn" style="flex:1" onclick="claudeRC('${p.name}',this)" aria-label="Remote control de claude-${esc(p.name)}">🔗 RC</button>
      </div></div>`;
  }).join('');
}
window.claudeAct = async function (project, verb, btn) {
  const row = btn.closest('.item'); [...row.querySelectorAll('button')].forEach(b => b.disabled = true);
  const old = btn.textContent; btn.textContent = '…';
  try {
    const r = await api(`/claude/${verb}/${project}`, { method: 'POST' });
    toast(r.message || `${verb} ok`, r.ok ? (r.noop ? '' : 'ok') : 'err');
    await claudeStatusOne(project);
  } catch (e) { toast(e.message, 'err'); }
  [...row.querySelectorAll('button')].forEach(b => b.disabled = false); btn.textContent = old;
};
async function claudeRefreshStatus() {
  try {
    const d = await api('/claude/status');
    claudeProjects = claudeProjects.map(p => ({ ...p, status: d.statuses[p.name] || 'unknown' }));
    drawClaude();
  } catch {}
}
async function claudeStatusOne(project) {
  try {
    const d = await api(`/claude/status/${project}`);
    claudeProjects = claudeProjects.map(p => p.name === project ? { ...p, status: d.status } : p);
    drawClaude();
  } catch {}
}
// ── Claude Remote Control — deep-link para assumir a sessão na app ──────────
window.claudeRC = async function (project, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  try {
    const d = await api(`/claude/rc/${project}`);
    openSheet(`<h2>🔗 Remote Control</h2>
      <div class="muted" style="font-size:13px;margin:6px 0 14px">Assumir a sessão <b class="mono">claude-${esc(project)}</b> na app do Claude:</div>
      <a class="btn primary block" href="${esc(d.url)}" target="_blank" rel="noopener">↗ Abrir na app do Claude</a>
      <button class="btn block" style="margin-top:10px" onclick="copyRC(this)" data-url="${esc(d.url)}">📋 Copiar link</button>
      <div class="logbox" style="margin-top:12px;font-size:11.5px">${esc(d.url)}</div>`);
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = old;
};
window.copyRC = function (btn) {
  navigator.clipboard.writeText(btn.dataset.url)
    .then(() => toast('Link copiado', 'ok'))
    .catch(() => toast('Não consegui copiar', 'err'));
};

async function claudeListSessions(btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  try {
    const d = await api('/claude/sessions');
    $('#claudeListOut').innerHTML = `<div class="logbox" style="margin-bottom:14px">${esc(d.output || '(vazio)')}</div>`;
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = old;
}

async function renderApps() {
  const d = await api('/apps');
  $('#appList').innerHTML = d.apps.map(a => {
    const open = a.web && a.url;
    const tag = open ? 'a' : 'div';
    const attrs = open ? `href="${esc(a.url)}" target="_blank" rel="noopener"` : '';
    const sub = a.desc ? esc(a.desc) : ':' + a.port + (a.path ? ' · ' + esc(a.path) : a.container ? ' · ' + esc(a.container) : a.process ? ' · ' + esc(a.process) : '');
    return `<${tag} class="item" ${attrs}>
      <span class="ico">${a.icon}</span>
      <div class="grow"><div class="name">${esc(a.name)}</div><div class="meta">${sub}</div></div>
      <span class="pill" style="font-size:10px">:${a.port}</span>
      <span class="dot ${a.state === 'running' ? 'running' : a.state === 'listen' ? 'listen' : 'exited'}"></span>
      <span class="chev">${open ? '↗' : ''}</span></${tag}>`;
  }).join('') || emptyState('🔌', 'Sem apps', 'Nenhuma porta detetada.');
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
function openSheet(html) { stopLiveLogs(); $('#sheet').innerHTML = `<div class="handle"></div>` + html; $('#sheet').classList.add('open'); $('#scrim').classList.add('open'); }
function closeSheet() { stopLiveLogs(); $('#sheet').classList.remove('open'); $('#scrim').classList.remove('open'); }
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

// ── Infra: segmented control (Docker · Apps · Mapa) ──────────────────────────
let infraSeg = localStorage.getItem('mc_infra_seg') || 'docker';
function setSeg(s) { infraSeg = s; localStorage.setItem('mc_infra_seg', s); }
function applyInfraSeg() {
  $$('#infraSeg button').forEach(b => {
    const on = b.dataset.seg === infraSeg;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  });
  $('#mapView').classList.toggle('open', current === 'infra' && infraSeg === 'map');
  $('#infraDocker').hidden = infraSeg !== 'docker';
  $('#infraApps').hidden = infraSeg !== 'apps';
}
async function renderInfra(opts = {}) {
  applyInfraSeg();
  if (infraSeg === 'map') {
    // só re-renderiza ao entrar (fresh) — o polling não pode fazer reset ao pan/zoom
    if (opts.fresh || !$('#mapvp')) requestAnimationFrame(renderMapView);
    return;
  }
  if (infraSeg === 'docker') await renderDocker(); else await renderApps();
}
// ── Automação: segmented control (Comandos · Claude · AL) ────────────────────
let autoSeg = localStorage.getItem('mc_auto_seg') || 'cmd';
function setAutoSeg(s) { autoSeg = s; localStorage.setItem('mc_auto_seg', s); }
function applyAutoSeg() {
  $$('#autoSeg button').forEach(b => {
    const on = b.dataset.seg === autoSeg;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  });
  $('#autoCmd').hidden = autoSeg !== 'cmd';
  $('#autoClaude').hidden = autoSeg !== 'claude';
  $('#autoAL').hidden = autoSeg !== 'al';
}
async function renderAuto() {
  applyAutoSeg();
  if (autoSeg === 'cmd') await renderCommands();
  else if (autoSeg === 'claude') await renderClaude();
  else await renderAL();
}

// ══ PROJETOS AL (Azure DevOps) ═══════════════════════════════════════════════
let _alRepos = [], _alWICur = null;
let alProject = localStorage.getItem('mc_al_project') || '';
const alQ = () => alProject ? `?project=${encodeURIComponent(alProject)}` : '';
function drawAlProjSel(projects, active) {
  $('#alProjSel').innerHTML = projects.length > 1
    ? `<select id="alProjPick" class="logbox" style="width:100%;font-size:14px;padding:11px;margin-bottom:12px" aria-label="Projeto Azure DevOps">
        ${projects.map(p => `<option value="${esc(p)}" ${p === active ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>` : '';
  const pick = $('#alProjPick');
  if (pick) pick.addEventListener('change', () => {
    alProject = pick.value; localStorage.setItem('mc_al_project', alProject);
    $('#alRepos').innerHTML = '<div class="skeleton" style="height:60px"></div>';
    $('#alWorkitems').innerHTML = '';
    renderAL();
  });
}
async function renderAL() {
  // 1) projetos visíveis ao PAT → seletor; 2) repos + bugs do projeto ativo
  const pj = await api('/al/projects');
  if (!pj.available) {
    $('#alHint').innerHTML = `<div class="install" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.1)">⚠️ ${esc(pj.error || 'Azure DevOps não configurado.')}</div>`;
    $('#alProjSel').innerHTML = ''; $('#alRepos').innerHTML = ''; $('#alWorkitems').innerHTML = '';
    return;
  }
  if (!pj.projects.includes(alProject)) alProject = pj.default || pj.projects[0] || '';
  drawAlProjSel(pj.projects, alProject);
  const d = await api('/al/repos' + alQ());
  const el = $('#alRepos');
  if (!d.available) {
    $('#alHint').innerHTML = `<div class="install" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.1)">⚠️ ${esc(d.error)}</div>`;
    el.innerHTML = ''; $('#alWorkitems').innerHTML = '';
    return;
  }
  $('#alHint').innerHTML = (pj.cred_source && pj.cred_source !== '.env')
    ? `<div class="dim" style="font-size:12px;margin:0 2px 10px">🔑 credenciais DevOps: <span class="mono">${esc(pj.cred_source)}</span></div>` : '';
  _alRepos = d.repos;
  el.innerHTML = d.repos.map(r => {
    const L = r.local;
    const pill = !L ? '<span class="pill">não clonado</span>'
      : L.dirty ? `<span class="pill warn">${L.dirty} alt. locais</span>`
      : L.ahead ? `<span class="pill warn">${L.ahead} por enviar</span>`
      : '<span class="pill ok">sincronizado</span>';
    const meta = L ? `${esc(L.branch || '?')} · ${esc(r.project)}` : `branch ${esc(r.default_branch)}`;
    return `<div class="item" style="flex-direction:column;align-items:stretch;gap:11px">
      <div class="row" style="gap:12px"><span class="ico">🧩</span>
        <div class="grow"><div class="name">${esc(r.name)}</div><div class="meta mono">${meta}</div></div>
        ${pill}</div>
      <div class="btn-row">
        <button class="btn" style="flex:1" onclick="alSync('${esc(r.name)}',this)">⇅ Sync</button>
        <button class="btn primary" style="flex:1" onclick="alSession('${esc(r.name)}')" ${L ? '' : 'disabled'}>▶ Sessão</button>
        <button class="btn" style="flex:1" onclick="alPR('${esc(r.name)}',this)" ${L ? '' : 'disabled'}>⇱ PR</button>
      </div></div>`;
  }).join('') || emptyState('🧩', 'Sem repos', 'Nenhum repositório no projeto DevOps.');
  renderALWorkitems();
  markSync();
}
async function renderALWorkitems() {
  const el = $('#alWorkitems');
  try {
    const d = await api('/al/workitems' + alQ());
    if (!d.available) { el.innerHTML = emptyState('🐛', 'Work items indisponíveis', esc(d.error || '')); return; }
    el.innerHTML = d.items.map(w => `<button class="item" onclick='openWorkitem(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
      <span class="ico">🐛</span>
      <div class="grow"><div class="name" style="font-size:13.5px">#${w.id} ${esc(w.title)}</div>
        <div class="meta">${esc(w.state)}${w.assigned ? ' · ' + esc(w.assigned) : ''}</div></div>
      <span class="chev">›</span></button>`).join('')
      || emptyState('✅', 'Sem bugs abertos', 'Nada pendente no DevOps.');
  } catch (e) { el.innerHTML = emptyState('⚠️', 'Work items indisponíveis', esc(e.message)); }
}
window.alSync = async function (name, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'a sincronizar…';
  try { const r = await api(`/al/sync/${encodeURIComponent(name)}${alQ()}`, { method: 'POST' }); toast(r.message || 'Sincronizado', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = old;
  renderAL();
};
window.alSession = function (name, briefing = '', wiId = null) {
  _alWICur = wiId;
  openSheet(`<h2>▶ Sessão sobre ${esc(name)}</h2>
    <div class="muted" style="font-size:13px;margin:6px 0 10px">Descreve o erro ou a tarefa — vai para o <b class="mono">TASK.md</b> do clone e a sessão Claude começa por aí.</div>
    <textarea id="alBriefing" class="logbox" style="width:100%;min-height:130px;font-size:14px;font-family:inherit" placeholder="Ex.: Ao lançar a fatura de venda X aparece o erro Y no posting…">${esc(briefing)}</textarea>
    <button class="btn primary block" style="margin-top:12px" onclick="alStart('${esc(name)}',this)">Iniciar sessão claude-al-${esc(name)}</button>`);
  $('#alBriefing').focus();
};
window.alStart = async function (name, btn) {
  const briefing = $('#alBriefing').value.trim();
  if (!briefing) { toast('Escreve o briefing primeiro', 'err'); return; }
  btn.disabled = true; btn.textContent = 'a iniciar…';
  try {
    const r = await api(`/al/session/${encodeURIComponent(name)}/start${alQ()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefing, workitem_id: _alWICur }),
    });
    toast(r.message || 'Sessão iniciada', 'ok'); closeSheet(); _alWICur = null;
    setAutoSeg('claude'); load('auto');
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Iniciar sessão'; }
};
window.alPR = async function (name, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'a criar PR…';
  try {
    const r = await api(`/al/pr/${encodeURIComponent(name)}${alQ()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    openSheet(`<h2>⇱ Pull Request criado</h2>
      <div class="muted" style="font-size:13px;margin:6px 0 14px">PR #${r.id} no Azure DevOps — revê e faz merge no browser ou no VS Code.</div>
      <a class="btn primary block" href="${esc(r.url)}" target="_blank" rel="noopener">↗ Abrir PR no DevOps</a>`);
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = old;
};
window.openWorkitem = function (w) {
  const repoOpts = _alRepos.filter(r => r.local).map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  const desc = (w.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  openSheet(`<h2>🐛 #${w.id} ${esc(w.title)}</h2>
    <div class="row" style="gap:8px;margin:6px 0 12px"><span class="pill warn">${esc(w.state)}</span>
      ${w.assigned ? `<span class="dim" style="font-size:12px">${esc(w.assigned)}</span>` : ''}</div>
    ${desc ? `<div class="logbox" style="max-height:26vh;margin-bottom:12px">${esc(desc.slice(0, 1800))}</div>` : ''}
    <a class="btn block" href="${esc(w.url)}" target="_blank" rel="noopener" style="margin-bottom:10px">↗ Abrir no DevOps</a>
    ${repoOpts ? `<div class="dim" style="font-size:12.5px;margin:8px 0 6px">Iniciar sessão Claude no repo:</div>
      <select id="alWIRepo" class="logbox" style="width:100%;font-size:14px;padding:11px">${repoOpts}</select>
      <button class="btn primary block" style="margin-top:10px" onclick='alFromWI(${JSON.stringify(w).replace(/'/g, "&#39;")})'>▶ Sessão com este contexto</button>`
      : `<div class="dim" style="font-size:12.5px">Faz Sync de um repo primeiro para poderes iniciar uma sessão.</div>`}`);
};
window.alFromWI = function (w) {
  const repo = $('#alWIRepo').value;
  const desc = (w.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  alSession(repo, `Work item #${w.id}: ${w.title}${desc ? '\n\n' + desc.slice(0, 1200) : ''}`, w.id);
};

// ── Router + polling ─────────────────────────────────────────────────────────
const RENDER = { home: renderHome, infra: renderInfra, system: renderSystem, auto: renderAuto, alerts: renderAlerts };
const POLL_MS = { home: 4000, infra: 8000, alerts: 12000 };
let current = 'home', pollT = null;

const VIEW_ERR = {
  home: () => '#heroHealth',
  infra: () => infraSeg === 'apps' ? '#appList' : '#containerList',
  system: () => '#hostCard',
  auto: () => autoSeg === 'al' ? '#alRepos' : autoSeg === 'claude' ? '#claudeProjects' : '#cmdList',
  alerts: () => '#alertConfig',
};
async function load(view, opts) {
  try { await RENDER[view](opts || {}); setStatus(true); }
  catch (e) {
    setStatus(false);
    // guarda de erro visível: nunca deixar a vista em skeleton eterno
    const sel = VIEW_ERR[view] && VIEW_ERR[view]();
    const el = sel && $(sel);
    if (el && view === current && !el.querySelector('.item, .card, .gauge, .hero')) {
      el.innerHTML = emptyState('⚠️', 'Sem ligação à API', esc(e.message));
    }
    if (view === current) console.warn(view, e.message);
  }
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
  $$('.tab').forEach(t => {
    const on = t.dataset.view === view;
    t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on));
  });
  $('#mapView').classList.toggle('open', view === 'infra' && infraSeg === 'map');
  window.scrollTo({ top: 0 });
  load(view, { fresh: true });
  schedule();
}
$$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
$$('#infraSeg button').forEach(b => b.addEventListener('click', () => { setSeg(b.dataset.seg); load('infra', { fresh: true }); schedule(); }));
$$('#autoSeg button').forEach(b => b.addEventListener('click', () => { setAutoSeg(b.dataset.seg); load('auto', { fresh: true }); }));
$('#procCpu').addEventListener('click', () => renderProcs('cpu'));
$('#procMem').addEventListener('click', () => renderProcs('mem'));
$('#rebootBtn').addEventListener('click', confirmReboot);
$('#claudeRefresh').addEventListener('click', claudeRefreshStatus);
$('#claudeList').addEventListener('click', (e) => claudeListSessions(e.currentTarget));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !(current === 'infra' && infraSeg === 'map')) load(current);
});

// ── Pull-to-refresh (leve, só quando o scroll está no topo) ──────────────────
(function pullToRefresh() {
  const el = $('#ptr');
  let sy = 0, pulling = false, dist = 0;
  document.addEventListener('touchstart', (e) => {
    const mapOpen = current === 'infra' && infraSeg === 'map';
    if (window.scrollY === 0 && !mapOpen && !$('#sheet').classList.contains('open')) {
      sy = e.touches[0].clientY; pulling = true; dist = 0;
    }
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    dist = e.touches[0].clientY - sy;
    if (dist > 12) {
      el.style.opacity = Math.min(1, dist / 90);
      el.style.transform = `translateX(-50%) translateY(${Math.min(58, dist / 2.2)}px) rotate(${Math.min(270, dist * 2)}deg)`;
    }
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    const fire = dist > 76;
    el.style.opacity = 0; el.style.transform = 'translateX(-50%)';
    if (fire) { haptic(12); await load(current, { fresh: true }); toast('Atualizado', 'ok'); }
  });
})();

// ── Command palette — busca global (containers, apps, comandos, sessões) ─────
const _norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
let palIndex = [];
async function openPalette() {
  $('#palette').hidden = false;
  const inp = $('#palInput'); inp.value = ''; inp.focus();
  palIndex = [
    { t: 'Home', k: 'vista', icon: '🏠', run: () => go('home') },
    { t: 'Docker', k: 'vista', icon: '🐳', run: () => { setSeg('docker'); go('infra'); } },
    { t: 'Apps', k: 'vista', icon: '🔌', run: () => { setSeg('apps'); go('infra'); } },
    { t: 'Mapa do servidor', k: 'vista', icon: '🪐', run: () => { setSeg('map'); go('infra'); } },
    { t: 'Sistema', k: 'vista', icon: '🖥️', run: () => go('system') },
    { t: 'Automação', k: 'vista', icon: '⚡', run: () => go('auto') },
    { t: 'Alertas', k: 'vista', icon: '🔔', run: () => go('alerts') },
  ];
  drawPal('');
  const [cs, ap, cm, cl, alr, alw] = await Promise.all([
    _aux.containers ? Promise.resolve(_aux.containers) : api('/containers').catch(() => null),
    _aux.apps ? Promise.resolve(_aux.apps) : api('/apps').catch(() => null),
    api('/commands').catch(() => null),
    api('/claude/projects').catch(() => null),
    api('/al/repos').catch(() => null),
    api('/al/workitems').catch(() => null),
  ]);
  palIndex.push(
    ...((cs && cs.containers) || []).map(ct => ({
      t: ct.name, k: 'container · ' + ct.state, icon: ct.state === 'running' ? '🟢' : '🔴',
      run: () => { setSeg('docker'); go('infra'); openContainer(ct); },
    })),
    ...((ap && ap.apps) || []).map(a => ({
      t: a.name, k: 'app · :' + a.port, icon: a.icon || '🔌',
      run: () => { if (a.web && a.url) window.open(a.url, '_blank', 'noopener'); else { setSeg('apps'); go('infra'); } },
    })),
    ...((cm && cm.commands) || []).map(c => ({
      t: c.label, k: 'comando', icon: c.danger ? '⚠️' : '⚡', run: () => go('auto'),
    })),
    ...((cl && cl.projects) || []).map(p => ({
      t: 'claude-' + p.name, k: 'sessão', icon: '✳️', run: () => { setAutoSeg('claude'); go('auto'); },
    })),
    ...((alr && alr.available && alr.repos) || []).map(r => ({
      t: r.name, k: 'repo AL', icon: '🧩', run: () => { setAutoSeg('al'); go('auto'); },
    })),
    ...((alw && alw.available && alw.items) || []).map(w => ({
      t: `#${w.id} ${w.title}`, k: 'bug DevOps', icon: '🐛',
      run: () => { setAutoSeg('al'); go('auto'); openWorkitem(w); },
    })),
  );
  if (!$('#palette').hidden) drawPal(inp.value);
}
function drawPal(q) {
  const nq = _norm(q);
  const hits = palIndex.filter(it => !nq || _norm(it.t).includes(nq)).slice(0, 12);
  $('#palList').innerHTML = hits.map(it => `<button class="pal-item" data-i="${palIndex.indexOf(it)}" role="option">
      <span aria-hidden="true">${it.icon}</span><span class="grow">${esc(it.t)}</span><span class="dim" style="font-size:12px">${esc(it.k)}</span>
    </button>`).join('') || `<div class="empty" style="padding:16px">sem resultados</div>`;
  $$('.pal-item').forEach(b => b.addEventListener('click', () => { closePalette(); palIndex[+b.dataset.i].run(); }));
}
function closePalette() { $('#palette').hidden = true; }
$('#palBtn').addEventListener('click', openPalette);
$('#palInput').addEventListener('input', (e) => drawPal(e.target.value));
$('#palInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const f = $('.pal-item'); if (f) f.click(); }
});
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePalette(); closeSheet(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openPalette(); }
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
let SERVER = 'MikeServer';
(async function init() {
  try { const h = await api('/host'); SERVER = h.server_name; $('#hostSub').textContent = h.os; } catch {}
  go('home');
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
    <button class="x" id="installX" aria-label="Dispensar sugestão de instalação">✕</button></div>`;
  $('#installBtn').onclick = async () => { deferredPrompt.prompt(); deferredPrompt = null; $('#installBanner').innerHTML = ''; };
  $('#installX').onclick = () => { localStorage.setItem('mc_install_dismissed', '1'); $('#installBanner').innerHTML = ''; };
});

// ══ MAPA ORBITAL (átomo) ═════════════════════════════════════════════════════
// Ícones SVG (viewBox 24×24, traço) — sem emojis.
const ICONS = {
  server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M7.5 7.5h0M7.5 16.5h0"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.6 3.1 3 7 3s7-1.4 7-3V6"/><path d="M5 12c0 1.6 3.1 3 7 3s7-1.4 7-3"/>',
  cache: '<path d="M13 3 5 13h5l-1 8 8-11h-5z"/>',
  bolt: '<path d="M13 3 5 13h5l-1 8 8-11h-5z"/>',
  storage: '<path d="M5 7h14l-1.3 12.5a1 1 0 0 1-1 .9H7.3a1 1 0 0 1-1-.9z"/><path d="M4 7h16"/>',
  proxy: '<rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 16.5h0M10 16.5h0"/><path d="M8 7l-1 3M16 7l1 3M12 6v4"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 3.5 3.5 0 0 0 7 18z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/>',
  flask: '<path d="M9 3h6M10 3v6l-4.5 8a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 9V3"/>',
  news: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h7M7 13h10M7 16h6"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7 15l3-4 3 2 4-6"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 11l2.5-3 2 2.5L14 7l3 4"/><path d="M9 20h6M12 16v4"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5l4.5 4.5"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M4 18l5-4 4 3 3-2 5 4"/>',
  flow: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 6h7.6M18 8.2v7.6M8 7.4l8 9.2"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>',
  media: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  generic: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 12h0"/>',
};
ICONS.puzzle = ICONS.grid; ICONS.panel = ICONS.grid;
const nodeIcon = (k) => ICONS[k] || ICONS.generic;

const mapState = { scale: 1, tx: 0, ty: 0 };
let _mapVP = null;
const shortName = (s) => { s = String(s || ''); return s.length > 15 ? s.slice(0, 14) + '…' : s; };

async function renderMapView() {
  $('#mapSub').textContent = 'a carregar…';
  try { renderMap(await api('/map')); }
  catch (e) { $('#mapSub').textContent = 'erro: ' + e.message; }
}

function layoutNodes(nodes) {
  const caps = [7, 13, 20, 28];
  const positioned = []; const ringRadii = [];
  let rem = nodes.length, ring = 0, n = 0;
  while (rem > 0) {
    const count = Math.min(caps[ring] ?? 32, rem);
    const radius = 175 + ring * 145;
    ringRadii.push(radius);
    const offset = ring * 0.5;
    for (let i = 0; i < count; i++) {
      const ang = offset + (i / count) * Math.PI * 2;
      positioned.push({ ...nodes[n++], x: Math.cos(ang) * radius, y: Math.sin(ang) * radius });
    }
    rem -= count; ring++;
  }
  return { positioned, ringRadii };
}

function applyMapTransform() {
  const svg = $('#mapSvg');
  const W = svg.clientWidth || innerWidth, H = svg.clientHeight || innerHeight;
  if (_mapVP) _mapVP.setAttribute('transform',
    `translate(${(W / 2 + mapState.tx).toFixed(1)} ${(H / 2 + mapState.ty).toFixed(1)}) scale(${mapState.scale.toFixed(3)})`);
}

function renderMap(d) {
  const svg = $('#mapSvg');
  const W = svg.clientWidth || innerWidth, H = svg.clientHeight || innerHeight;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const { positioned, ringRadii } = layoutNodes(d.nodes);

  const stars = Array.from({ length: 70 }, () => {
    const x = ((Math.random() * 2 - 1) * 1400).toFixed(0), y = ((Math.random() * 2 - 1) * 1400).toFixed(0);
    const r = (Math.random() * 1.6 + .4).toFixed(1), dl = (Math.random() * 4).toFixed(1);
    return `<circle class="star" cx="${x}" cy="${y}" r="${r}" style="animation-delay:${dl}s"></circle>`;
  }).join('');
  const orbits = ringRadii.map(r => `<circle class="orbit" cx="0" cy="0" r="${r}"></circle>`).join('');
  const links = positioned.map(nd =>
    `<line class="link ${nd.status}" x1="${nd.x.toFixed(1)}" y1="${nd.y.toFixed(1)}" x2="0" y2="0"></line>`).join('');
  const nodes = positioned.map(nd => `
    <g class="node ${nd.status}" data-url="${esc(nd.url)}" data-name="${esc(nd.name)}" data-port="${nd.port}" data-status="${nd.status}" data-web="${nd.web ? 1 : 0}" transform="translate(${nd.x.toFixed(1)} ${nd.y.toFixed(1)})">
      <circle class="halo ${nd.status}" r="26"></circle>
      <circle class="ndot" r="16"></circle>
      <g class="nico" transform="translate(-9 -9) scale(.75)">${nodeIcon(nd.svg)}</g>
      <text class="lbl" text-anchor="middle" y="38" font-size="11">${esc(shortName(nd.name))}</text>
      <text class="lbl" text-anchor="middle" y="51" font-size="9.5" style="fill:var(--dim)">:${nd.port}</text>
    </g>`).join('');
  const c = d.center;
  const core = `<g class="core ${c.health}">
      <circle class="core-halo" r="62"></circle>
      <circle class="core-dot" r="42"></circle>
      <g class="core-ico" transform="translate(-18 -18) scale(1.5)">${ICONS.server}</g>
      <text class="core-lbl" text-anchor="middle" y="64" font-size="13">${esc(c.name)}</text>
    </g>`;

  svg.innerHTML = `<g id="mapvp">${stars}${orbits}${links}${core}${nodes}</g>`;
  _mapVP = $('#mapvp');
  mapState.scale = 1; mapState.tx = 0; mapState.ty = 0;
  applyMapTransform();
  $('#mapTitle').textContent = c.name;
  $('#mapSub').textContent = `${d.up}/${d.total} serviços ativos · CPU ${c.cpu}% · RAM ${c.mem}%`;
}

function tapNode(g) {
  const url = g.getAttribute('data-url'), name = g.getAttribute('data-name');
  const port = g.getAttribute('data-port'), st = g.getAttribute('data-status');
  const web = g.getAttribute('data-web') === '1';
  let action;
  if (st !== 'up') action = `<button class="btn primary block" onclick="setSeg('docker');go('infra');closeSheet()">Ir a Infra → Docker para reiniciar</button>`;
  else if (web && url) action = `<a class="btn primary block" href="${esc(url)}" target="_blank" rel="noopener">↗ Abrir app</a>`;
  else action = `<div class="dim" style="font-size:13px">Serviço interno (não é uma página web).</div>`;
  openSheet(`<h2>${esc(name)}</h2>
    <div class="row" style="gap:9px;margin:6px 0 16px"><span class="dot ${st === 'up' ? 'ok' : 'crit'}"></span>
      <span class="muted">${st === 'up' ? 'a correr' : 'em baixo'} · porta ${esc(port)}</span></div>
    ${action}`);
}

(function mapGestures() {
  const S = $('#mapSvg');
  const pts = new Map();
  let lastDist = 0, moved = 0, downT = 0, downTarget = null;
  const dd = () => { const a = [...pts.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
  const mid = () => { const a = [...pts.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; };
  function zoomBy(factor, focal) {
    const rect = S.getBoundingClientRect(), W = rect.width, H = rect.height;
    const fx = focal ? focal.x - rect.left : W / 2, fy = focal ? focal.y - rect.top : H / 2;
    const s2 = Math.max(0.35, Math.min(4, mapState.scale * factor));
    const wx = (fx - W / 2 - mapState.tx) / mapState.scale, wy = (fy - H / 2 - mapState.ty) / mapState.scale;
    mapState.tx = fx - W / 2 - s2 * wx; mapState.ty = fy - H / 2 - s2 * wy; mapState.scale = s2;
    applyMapTransform();
  }
  window._mapZoom = (f) => zoomBy(f, null);
  S.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { S.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 1) { moved = 0; downT = Date.now(); downTarget = e.target.closest('.node'); }
    if (pts.size === 2) lastDist = dd();
  });
  S.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y; moved += Math.abs(dx) + Math.abs(dy);
      mapState.tx += dx; mapState.ty += dy; applyMapTransform();
    } else if (pts.size === 2) { const nd = dd(); if (lastDist > 0) zoomBy(nd / lastDist, mid()); lastDist = nd; }
  });
  function end(e) {
    const tap = pts.size === 1 && moved < 10 && (Date.now() - downT) < 350 && downTarget;
    pts.delete(e.pointerId); if (pts.size < 2) lastDist = 0;
    if (tap) tapNode(downTarget);
  }
  S.addEventListener('pointerup', end);
  S.addEventListener('pointercancel', end);
  S.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 0.89, { x: e.clientX, y: e.clientY }); }, { passive: false });
})();

$('#mapZoomIn').addEventListener('click', () => window._mapZoom(1.25));
$('#mapZoomOut').addEventListener('click', () => window._mapZoom(0.8));
$('#mapReset').addEventListener('click', () => { mapState.scale = 1; mapState.tx = 0; mapState.ty = 0; applyMapTransform(); });
let _rsz; window.addEventListener('resize', () => { clearTimeout(_rsz); _rsz = setTimeout(() => { if (current === 'infra' && infraSeg === 'map') renderMapView(); }, 250); });

// ── Service worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
