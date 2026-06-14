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
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Toast ────────────────────────────────────────────────────────────────────
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', 2600);
}

// ── Gauge SVG (size ajustável p/ 3-up) ───────────────────────────────────────
function gauge({ value, label, sub, color, max = 100, suffix = '%', size = 104 }) {
  const sw = Math.max(6, Math.round(size * 0.085));
  const R = (size - sw) / 2 - 2;
  const c = size / 2, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, (value ?? 0) / max));
  const off = C * (1 - pct);
  const display = value == null ? '—' : (Number.isInteger(value) ? value : value.toFixed(1));
  const vf = Math.round(size * 0.25);
  return `<div class="card gauge-card">
    <div class="gauge">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="ring-bg" cx="${c}" cy="${c}" r="${R}" fill="none" stroke-width="${sw}"></circle>
        <circle class="ring-fg" cx="${c}" cy="${c}" r="${R}" fill="none" stroke-width="${sw}"
          stroke="${color}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
      </svg>
      <div class="center"><div class="v" style="font-size:${vf}px">${display}<span style="font-size:${Math.round(vf * 0.5)}px;color:var(--dim)">${value == null ? '' : suffix}</span></div><div class="l">${label}</div></div>
    </div>
    ${sub ? `<div class="meta">${sub}</div>` : ''}
  </div>`;
}

// ── Carga traduzida (load vs nº de cores) ────────────────────────────────────
function loadHealth(load, cores) {
  const r = load / (cores || 1);
  if (r < 0.7) return ['folgado', 'var(--ok)'];
  if (r < 1.0) return ['ocupado', 'var(--warn)'];
  return ['sobrecarga', 'var(--crit)'];
}


// ══ VISÃO ════════════════════════════════════════════════════════════════════
const _aux = { t: 0, containers: null, alerts: null, apps: null };
const _gb = (b) => (b / 1e9).toFixed(b >= 1e10 ? 0 : 1);
const fact = (l, v) => `<div><div class="kpi-label">${l}</div><div style="font-weight:650;font-size:14px;margin-top:3px">${v}</div></div>`;

async function renderOverview() {
  const d = await api('/overview');
  const cpu = d.cpu.percent, mem = d.memory.percent, disk = d.disk.percent;

  $('#gauges').innerHTML =
    gauge({ value: cpu, label: 'CPU', sub: `${d.cpu.cores} cores`, color: colorFor(cpu), size: 84 }) +
    gauge({ value: mem, label: 'RAM', sub: `${_gb(d.memory.used)}/${_gb(d.memory.total)}G`, color: colorFor(mem), size: 84 }) +
    gauge({ value: disk, label: 'Disco', sub: `${_gb(d.disk.free)}G livres`, color: colorFor(disk), size: 84 });

  // dados auxiliares (containers/alertas/apps) — puxados com menos frequência (leve no N97)
  if (Date.now() - _aux.t > 11000) {
    _aux.t = Date.now();
    Promise.all([api('/containers').catch(() => null), api('/alerts').catch(() => null), api('/apps').catch(() => null)])
      .then(([c, a, ap]) => { _aux.containers = c; _aux.alerts = a; _aux.apps = ap; if (current === 'overview') drawHome(d); });
  }
  drawHome(d);
  markSync();
}

function drawHome(d) {
  // ── Precisa de atenção (mini-briefing) ──
  const hist = (_aux.alerts && _aux.alerts.history) ? _aux.alerts.history.slice(0, 4) : [];
  $('#attention').innerHTML = `<div class="view-title" style="margin:0 2px 8px">Precisa de atenção</div>` +
    (hist.length
      ? `<div class="list">` + hist.map(a => `<div class="item">
          <span class="dot ${a.level === 'critical' ? 'crit' : a.level === 'warning' ? 'warn' : 'ok'}"></span>
          <div class="grow"><div class="name" style="font-size:13.5px">${esc(a.title)}</div>
            <div class="meta">${esc((a.body || '').replace(/<[^>]+>/g, ''))}</div></div>
          <span class="dim" style="font-size:11px">${fmtAgo(a.ts)}</span></div>`).join('') + `</div>`
      : `<div class="card"><div class="row" style="gap:10px"><span class="dot ok"></span><span class="muted">Tudo calmo — nada a precisar de ti.</span></div></div>`);

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

// ══ DOCKER ═══════════════════════════════════════════════════════════════════
async function renderDocker() {
  const d = await api('/containers');
  const el = $('#containerList');
  if (!d.available) { el.innerHTML = emptyState('🐳', 'Docker indisponível', esc(d.error || 'docker.sock não acessível.')); return; }
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
    <div class="dim" style="font-size:13px;margin-bottom:12px">${esc(ct.image)} · ${esc(ct.status)}</div>
    <div id="ctHelper"><div class="skeleton" style="height:90px;border-radius:14px"></div></div>
    <div id="ctStats" class="grid grid-2" style="margin:14px 0"></div>
    <div class="btn-row">${acts.map(([a, l, k]) =>
      `<button class="btn ${k}" style="flex:1" onclick="containerAction('${ct.id}','${a}',this)">${l}</button>`).join('')}</div>
    <button class="btn block" style="margin-top:10px" onclick="loadLogs('${ct.id}',this)">📜 Ver logs</button>
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
  renderTailscale(); renderBackups(); renderProcs(procSort);
}
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
  $('#appList').innerHTML = d.apps.map(a => `<a class="item" href="${esc(a.url)}" target="_blank" rel="noopener">
    <span class="ico">${a.icon}</span>
    <div class="grow"><div class="name">${esc(a.name)}</div>
      <div class="meta">${a.desc ? esc(a.desc) : ':' + a.port + (a.path ? ' · ' + esc(a.path) : a.container ? ' · ' + esc(a.container) : a.process ? ' · ' + esc(a.process) : '')}</div></div>
    <span class="pill" style="font-size:10px">:${a.port}</span>
    <span class="dot ${a.state === 'running' ? 'running' : a.state === 'listen' ? 'listen' : 'exited'}"></span>
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
const RENDER = { overview: renderOverview, docker: renderDocker, system: renderSystem, commands: renderCommands, claude: renderClaude, apps: renderApps, alerts: renderAlerts };
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
$('#goApps').addEventListener('click', () => go('apps'));
$('#claudeRefresh').addEventListener('click', claudeRefreshStatus);
$('#claudeList').addEventListener('click', (e) => claudeListSessions(e.currentTarget));
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
