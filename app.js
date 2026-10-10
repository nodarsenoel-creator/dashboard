'use strict';
/* Dashboard financiero standalone — réplica del artifact dashboard-financiero.
   Lee data.json (generado a diario por un cron) y renderiza los 3 horizontes. */

const $ = (s) => document.querySelector(s);

const TABS = {
  short:  { label: 'Corto', score: 'shortScore',  cov: 'shortCoverage' },
  medium: { label: 'Medio', score: 'mediumScore', cov: 'mediumCoverage' },
  long:   { label: 'Largo', score: 'longScore',   cov: 'longCoverage' },
  mine:   { label: 'Mías', score: 'longScore',   cov: 'longCoverage' },
};

const state = {
  tab: 'long',
  query: '',
  sector: 'all',
  top10: false,
  open: new Set(),
  f: { maxPE: 30, maxFwdPE: 25, maxPS: 7, maxPEG: 2, minROE: 15, minMargin: 10, divOnly: false },
};

let STOCKS = [];
let META = {};
let FAVS = [];
let BUYS = [];
let editingIdx = -1;
let SYMLIST_HTML = '';

/* ---------- persistencia local (favoritas y compras) ---------- */
const LS_FAVS = 'dash_favs';
const LS_BUYS = 'dash_buys';
function loadStore() {
  try { FAVS = JSON.parse(localStorage.getItem(LS_FAVS) || '[]'); } catch (e) { FAVS = []; }
  if (!Array.isArray(FAVS)) FAVS = [];
  let raw = null;
  try { raw = localStorage.getItem(LS_BUYS); } catch (e) { raw = null; }
  if (raw == null) {
    // primera visita: pre-carga las compras confirmadas (editables y borrables)
    BUYS = [
      { symbol: 'VZ', shares: 2, price: 46.35, date: '2026-10-08' },
      { symbol: 'T', shares: 1, price: 24.87, date: '2026-10-08' },
    ];
    saveBuys();
  } else {
    try { BUYS = JSON.parse(raw); } catch (e) { BUYS = []; }
    if (!Array.isArray(BUYS)) BUYS = [];
  }
}
function saveFavs() { try { localStorage.setItem(LS_FAVS, JSON.stringify(FAVS)); } catch (e) {} }
function saveBuys() { try { localStorage.setItem(LS_BUYS, JSON.stringify(BUYS)); } catch (e) {} }
function toggleFav(sym, btn) {
  const i = FAVS.indexOf(sym);
  if (i >= 0) FAVS.splice(i, 1); else FAVS.push(sym);
  saveFavs();
  if (state.tab === 'mine') { render(); return; }
  const on = FAVS.indexOf(sym) >= 0;
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★' : '☆';
  btn.setAttribute('aria-pressed', String(on));
}
function stockBySym(sym) { return STOCKS.find((s) => s.symbol === sym); }

/* ---------- formato ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
const pct = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d) + '%';
const money = (v) => (v == null || !isFinite(v)) ? '—'
  : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyS = (v) => (v == null || !isFinite(v)) ? '—'
  : (v < 0 ? '-' : (v > 0 ? '+' : '')) + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bigCap = (v) => {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9)  return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6)  return '$' + (v / 1e6).toFixed(0) + 'M';
  return '$' + Math.round(v);
};
const cls = (v) => (v == null ? '' : (v > 0 ? 'up' : (v < 0 ? 'down' : '')));
const badgeCls = (s) => (s == null ? '' : (s >= 70 ? 'g' : (s >= 50 ? 'y' : '')));

/* ---------- TradingView: gráfico en el detalle ---------- */
const TV_EXCH = { NYSE: 'NYSE', NASDAQ: 'NASDAQ', AMEX: 'AMEX', ARCA: 'AMEX', CBOE: 'CBOE' };
function tvSymbol(s) {
  if (!s || !s.symbol) return '';
  const px = TV_EXCH[String(s.exchange || '').toUpperCase()];
  return px ? px + ':' + s.symbol : s.symbol; // sin prefijo: TradingView lo resuelve
}
function tvConfig(symbol) {
  return {
    autosize: true,
    symbol: symbol,
    interval: 'D',
    timezone: 'America/New_York',
    theme: 'dark',
    style: '1', // velas japonesas
    locale: 'es',
    toolbar_bg: '#0f172a',
    enable_publishing: false,
    allow_symbol_change: false,
    hide_side_toolbar: true,
    // NOTA: el widget no acepta parámetros de estudios por config;
    // RSI y EMA se cargan con sus valores por defecto (EMA largo 9).
    // El usuario puede cambiar el largo del EMA a 200 en el propio gráfico.
    studies: ['STD;RSI', 'STD;EMA'],
    support_host: 'https://www.tradingview.com',
  };
}
function mountTVChart(art) {
  const box = art.querySelector('.tv-chart');
  if (!box || box.dataset.mounted) return;
  const sym = art.dataset.sym;
  const stock = STOCKS.find((x) => x.symbol === sym);
  const symbol = tvSymbol(stock || { symbol: sym });
  if (!symbol) return;
  box.innerHTML =
    '<div class="tradingview-widget-container" style="height:100%;width:100%">' +
    '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>' +
    '</div>';
  const sc = document.createElement('script');
  sc.type = 'text/javascript';
  sc.async = true;
  sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  sc.textContent = JSON.stringify(tvConfig(symbol));
  box.firstChild.appendChild(sc);
  box.dataset.mounted = symbol;
}
function unmountTVChart(art) {
  const box = art.querySelector('.tv-chart');
  if (box) { box.innerHTML = ''; delete box.dataset.mounted; }
}

/* ---------- filtros largo plazo (null = no pasa) ---------- */
function passesLong(s) {
  const f = state.f;
  if (!(s.pe != null && s.pe < f.maxPE)) return false;
  if (!(s.forwardPe != null && s.forwardPe < f.maxFwdPE)) return false;
  if (!(s.priceToSales != null && s.priceToSales < f.maxPS)) return false;
  if (!(s.peg != null && s.peg < f.maxPEG)) return false;
  if (!(s.roe != null && s.roe >= f.minROE)) return false;
  if (!(s.netMargin != null && s.netMargin >= f.minMargin)) return false;
  if (f.divOnly && !(s.dividendYield != null && s.dividendYield > 0)) return false;
  return true;
}

function visibleStocks() {
  const q = state.query.trim().toLowerCase();
  const arr = STOCKS.filter((s) => {
    if (state.tab === 'long' && !passesLong(s)) return false;
    if (state.sector !== 'all' && s.sector !== state.sector) return false;
    if (q && !(String(s.symbol).toLowerCase().includes(q) || String(s.company).toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => (b[TABS[state.tab].score] ?? -1) - (a[TABS[state.tab].score] ?? -1));
  if (state.tab === 'long' && state.top10) return arr.slice(0, 10);
  return arr;
}

function passCount() {
  return STOCKS.filter(passesLong).length;
}

/* ---------- render ---------- */
function renderCount() {
  const el = $('#passCount');
  if (state.tab === 'long') {
    el.textContent = state.top10 ? 'Top 10 por score' : passCount() + ' de ' + STOCKS.length + ' pasan';
  } else el.textContent = '';
}

function kvRow(k, v) {
  return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>';
}

function detailHTML(s) {
  const distEma = (s.price != null && s.ema200 != null && s.ema200 !== 0)
    ? ((s.price - s.ema200) / s.ema200) * 100 : null;
  return '<div class="detail">' +
    '<h4>Fundamental</h4><dl class="kv">' +
    kvRow('PER', num(s.pe)) +
    kvRow('PER futuro', num(s.forwardPe)) +
    kvRow('PEG', num(s.peg)) +
    kvRow('Precio/Ventas', num(s.priceToSales)) +
    kvRow('ROE %', num(s.roe, 1)) +
    kvRow('Margen neto %', num(s.netMargin, 1)) +
    kvRow('Dividendo %', num(s.dividendYield, 2)) +
    kvRow('Deuda/Patrimonio', num(s.debtToEquity)) +
    kvRow('Cap. mercado', bigCap(s.marketCap)) +
    '</dl>' +
    '<h4>Técnico</h4><dl class="kv">' +
    kvRow('Precio', money(s.price)) +
    kvRow('Cambio día', '<span class="' + cls(s.changePct) + '">' + pct(s.changePct) + '</span>') +
    kvRow('RSI(14)', num(s.rsi, 1)) +
    kvRow('EMA200', money(s.ema200)) +
    kvRow('Dist. EMA200', '<span class="' + cls(distEma) + '">' + pct(distEma) + '</span>') +
    kvRow('Semana', '<span class="' + cls(s.perfWeek) + '">' + pct(s.perfWeek) + '</span>') +
    kvRow('Mes', '<span class="' + cls(s.perfMonth) + '">' + pct(s.perfMonth) + '</span>') +
    kvRow('3 meses', '<span class="' + cls(s.perf3m) + '">' + pct(s.perf3m) + '</span>') +
    kvRow('6 meses', '<span class="' + cls(s.perf6m) + '">' + pct(s.perf6m) + '</span>') +
    kvRow('1 año', '<span class="' + cls(s.perfYear) + '">' + pct(s.perfYear) + '</span>') +
    '</dl>' +
    '<h4>Gráfico</h4><div class="tv-chart" role="img" aria-label="Gráfico de ' + esc(s.symbol) + '"></div>' +
    '<p class="meta-line">' + esc(s.company) + ' · ' + esc(s.sector) + ' · ' + esc(s.exchange) +
    ' · cobertura: ' + num(s[TABS[state.tab].cov], 0) + '%</p>' +
    '</div>';
}

/* ---------- filas de acciones (con estrella de favorita) ---------- */
function stockArticle(s, sk) {
  const sc = s[sk];
  const open = state.open.has(s.symbol) ? ' open' : '';
  const fav = FAVS.indexOf(s.symbol) >= 0;
  return '<article class="stock' + open + '" data-sym="' + esc(s.symbol) + '">' +
    '<div class="rowwrap">' +
    '<button class="row" aria-expanded="' + state.open.has(s.symbol) + '">' +
    '<span class="sym">' + esc(s.symbol) + '</span>' +
    '<span class="nm">' + esc(s.company) + '</span>' +
    '<span class="px">' + money(s.price) +
    '<small class="' + cls(s.changePct) + '">' + pct(s.changePct) + '</small></span>' +
    '<span class="badge ' + badgeCls(sc) + '">' + (sc == null ? '—' : sc) + '</span>' +
    '</button>' +
    '<button class="fav' + (fav ? ' on' : '') + '" data-fav="' + esc(s.symbol) + '" aria-pressed="' + fav +
    '" aria-label="Marcar ' + esc(s.symbol) + ' como favorita">' + (fav ? '★' : '☆') + '</button>' +
    '</div>' + detailHTML(s) + '</article>';
}

function bindRows(box) {
  box.querySelectorAll('.row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const art = btn.closest('.stock');
      const sym = art.dataset.sym;
      if (state.open.has(sym)) {
        state.open.delete(sym); art.classList.remove('open'); unmountTVChart(art);
      } else {
        state.open.add(sym); art.classList.add('open'); mountTVChart(art);
      }
      btn.setAttribute('aria-expanded', state.open.has(sym));
    });
  });
  box.querySelectorAll('.fav').forEach((btn) => {
    btn.addEventListener('click', () => toggleFav(btn.dataset.fav, btn));
  });
}

/* ---------- pestaña Mías: favoritas + compras ---------- */
function portfolioHTML() {
  let val = 0, cost = 0;
  BUYS.forEach((b) => {
    const st = stockBySym(b.symbol);
    if (st && st.price != null && isFinite(st.price)) val += b.shares * st.price;
    cost += b.shares * b.price;
  });
  const pl = val - cost;
  const plp = cost > 0 ? (pl / cost) * 100 : null;
  return '<div class="pfcard">' +
    '<div><span>Valor total</span><strong>' + money(val) + '</strong></div>' +
    '<div><span>Ganancia / pérdida</span><strong class="' + cls(pl) + '">' +
    moneyS(pl) + ' (' + pct(plp) + ')</strong></div></div>';
}

function buyRowHTML(b, i) {
  const st = stockBySym(b.symbol);
  const cur = st ? st.price : null;
  const pl = (cur != null && isFinite(cur)) ? (cur - b.price) * b.shares : null;
  const plp = (pl != null && b.price) ? ((cur - b.price) / b.price) * 100 : null;
  return '<div class="buy">' +
    '<div class="buy-top"><strong>' + esc(b.symbol) + '</strong>' +
    '<span class="mut">' + esc(String(b.shares)) + ' acc @ ' + money(b.price) +
    (b.date ? ' · ' + esc(b.date) : '') + '</span></div>' +
    '<div class="buy-bot"><span>Ahora: ' + money(cur) + '</span>' +
    '<span class="' + cls(pl) + '">' + moneyS(pl) + ' (' + pct(plp) + ')</span></div>' +
    '<div class="buy-actions"><button class="link" data-edit="' + i + '">Editar</button>' +
    '<button class="link danger" data-del="' + i + '">Borrar</button></div>' +
    '</div>';
}

function renderMine() {
  renderCount();
  const box = $('#list');
  const favStocks = FAVS.map(stockBySym).filter(Boolean)
    .sort((a, b) => (b.longScore ?? -1) - (a.longScore ?? -1));

  let html = '<h3 class="sec-title">⭐ Favoritas</h3>';
  html += favStocks.length
    ? favStocks.map((s) => stockArticle(s, 'longScore')).join('')
    : '<div class="empty"><strong>Sin favoritas</strong>' +
      '<p>Toca la ⭐ en cualquier acción para seguirla aquí.</p></div>';

  html += '<h3 class="sec-title">💼 Mis compras</h3>';
  html += portfolioHTML();
  html += '<button id="addBuy" class="btn">+ Agregar compra</button>';
  html += '<form id="buyForm" class="buy-form" hidden>' +
    '<label>Símbolo<input id="b_sym" list="symlist" autocomplete="off" placeholder="Ej: KO"></label>' +
    '<datalist id="symlist">' + SYMLIST_HTML + '</datalist>' +
    '<label>Cantidad<input id="b_shares" type="number" min="0" step="any" inputmode="decimal"></label>' +
    '<label>Precio de compra<input id="b_price" type="number" min="0" step="0.01" inputmode="decimal"></label>' +
    '<label>Fecha<input id="b_date" type="date"></label>' +
    '<p class="form-err" id="b_err" hidden></p>' +
    '<div class="form-actions"><button type="submit" class="btn sm" id="b_save">Guardar</button>' +
    '<button type="button" class="btn sm ghost" id="b_cancel">Cancelar</button></div>' +
    '</form>';
  html += '<div id="buyList">' + BUYS.map(buyRowHTML).join('') + '</div>';

  box.innerHTML = html;
  bindRows(box);
  box.querySelectorAll('.stock.open').forEach(mountTVChart);

  const form = $('#buyForm');
  const showForm = (idx) => {
    editingIdx = idx;
    $('#b_err').hidden = true;
    if (idx >= 0) {
      const b = BUYS[idx];
      $('#b_sym').value = b.symbol; $('#b_shares').value = b.shares;
      $('#b_price').value = b.price; $('#b_date').value = b.date || '';
      $('#b_save').textContent = 'Guardar cambios';
    } else {
      $('#b_sym').value = ''; $('#b_shares').value = '';
      $('#b_price').value = ''; $('#b_date').value = new Date().toISOString().slice(0, 10);
      $('#b_save').textContent = 'Guardar';
    }
    form.hidden = false;
    form.scrollIntoView({ block: 'nearest' });
  };
  const hideForm = () => { form.hidden = true; editingIdx = -1; };

  $('#addBuy').addEventListener('click', () => showForm(-1));
  $('#b_cancel').addEventListener('click', hideForm);
  box.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => showForm(parseInt(b.dataset.edit, 10))));
  box.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = parseInt(b.dataset.del, 10);
      if (confirm('¿Borrar la compra de ' + BUYS[i].symbol + '?')) {
        BUYS.splice(i, 1); saveBuys(); render();
      }
    }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#b_err');
    const sym = $('#b_sym').value.trim().toUpperCase();
    const shares = parseFloat($('#b_shares').value);
    const price = parseFloat($('#b_price').value);
    const date = $('#b_date').value;
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!stockBySym(sym)) return fail('Símbolo no encontrado en la lista.');
    if (!(shares > 0)) return fail('La cantidad debe ser mayor que 0.');
    if (!(price >= 0)) return fail('El precio no puede ser negativo.');
    const rec = { symbol: sym, shares: shares, price: price, date: date };
    if (editingIdx >= 0) BUYS[editingIdx] = rec; else BUYS.push(rec);
    saveBuys(); render();
  });
}

function render() {
  // panel de filtros solo en Largo; toolbar oculta en Mías
  $('#filterPanel').style.display = state.tab === 'long' ? '' : 'none';
  document.querySelector('.toolbar').style.display = state.tab === 'mine' ? 'none' : '';
  if (state.tab === 'mine') { renderMine(); return; }
  renderCount();

  const list = visibleStocks();
  const box = $('#list');
  if (!list.length) {
    box.innerHTML = '<div class="empty"><strong>Sin resultados</strong><p>' +
      (state.tab === 'long'
        ? 'Ninguna acción pasa los filtros actuales. Relaja algún umbral — por ejemplo, sube el PER máximo o baja el ROE mínimo — para ampliar la lista.'
        : 'Prueba con otra búsqueda o sector.') +
      '</p></div>';
    return;
  }
  const sk = TABS[state.tab].score;
  box.innerHTML = list.map((s) => stockArticle(s, sk)).join('');
  bindRows(box);
  box.querySelectorAll('.stock.open').forEach(mountTVChart);
}

/* ---------- init ---------- */
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-US', {
      timeZone: 'America/New_York', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (e) { return iso; }
}

function readFilters() {
  const g = (id) => parseFloat($('#' + id).value);
  state.f.maxPE = g('f_maxPE'); state.f.maxFwdPE = g('f_maxFwdPE');
  state.f.maxPS = g('f_maxPS'); state.f.maxPEG = g('f_maxPEG');
  state.f.minROE = g('f_minROE'); state.f.minMargin = g('f_minMargin');
  state.f.divOnly = $('#f_divOnly').checked;
}

function bindFilters() {
  ['f_maxPE', 'f_maxFwdPE', 'f_maxPS', 'f_maxPEG', 'f_minROE', 'f_minMargin', 'f_divOnly']
    .forEach((id) => $('#' + id).addEventListener('input', () => { readFilters(); render(); }));
}

function init(data) {
  STOCKS = data.stocks || [];
  META = data.meta || {};
  loadStore();
  SYMLIST_HTML = STOCKS.map((s) =>
    '<option value="' + esc(s.symbol) + '">' + esc(s.company) + '</option>').join('');
  $('#refreshed').textContent = 'Datos al: ' + fmtDate(META.refreshedAt);

  const sectors = [...new Set(STOCKS.map((s) => s.sector).filter(Boolean))].sort();
  const sel = $('#sector');
  sectors.forEach((sec) => {
    const o = document.createElement('option');
    o.value = sec; o.textContent = sec; sel.appendChild(o);
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => { x.classList.remove('active'); x.removeAttribute('aria-selected'); });
      t.classList.add('active'); t.setAttribute('aria-selected', 'true');
      state.tab = t.dataset.tab;
      render();
    });
  });

  $('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
  sel.addEventListener('change', (e) => { state.sector = e.target.value; render(); });

  bindFilters();
  readFilters();
  $('#top10Chip').addEventListener('click', () => {
    state.top10 = !state.top10;
    const c = $('#top10Chip');
    c.classList.toggle('on', state.top10);
    c.setAttribute('aria-pressed', String(state.top10));
    render();
  });
  render();
}

fetch('data.json', {cache: 'no-store'})
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(init)
  .catch((e) => {
    $('#list').innerHTML = '<div class="empty"><strong>No se pudo cargar data.json</strong>' +
      '<p>Revisa tu conexión e intenta de nuevo.</p></div>';
  });
