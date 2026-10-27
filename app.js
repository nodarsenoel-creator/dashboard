'use strict';
/* Dashboard financiero standalone — réplica del artifact dashboard-financiero.
   Lee data.json (generado a diario por un cron) y renderiza los 3 horizontes. */

const $ = (s) => document.querySelector(s);

const TABS = {
  short:  { label: 'Corto', score: 'shortScore',  cov: 'shortCoverage' },
  medium: { label: 'Medio', score: 'mediumScore', cov: 'mediumCoverage' },
  long:   { label: 'Largo', score: 'longScore',   cov: 'longCoverage' },
  mine:   { label: 'Mías', score: 'longScore',   cov: 'longCoverage' },
  calc:   { label: 'Calc', score: null, cov: null },
};

const state = {
  tab: 'long',
  query: '',
  sector: 'all',
  sigfilter: 'all',
  top10: false,
  open: new Set(),
  f: { maxPE: 30, maxFwdPE: 25, maxPS: 7, maxPEG: 2, minROE: 15, minMargin: 10, divOnly: false },
};

let STOCKS = [];
let BENCH = {};
let NEWS = [];
let OPP = [];
let OPTS = [];
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
    backgroundColor: 'rgba(6, 10, 22, 1)',
    gridColor: 'rgba(56, 189, 248, 0.07)',
    // Estudios con valores por defecto: RSI(14), EMA(9) y Bollinger(20,2).
    // El usuario puede cambiar el largo del EMA a 200 en el propio gráfico.
    studies: ['STD;RSI', 'STD;EMA', 'STD;Bollinger_Bands'],
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

/* ---------- ETF personal: regla de permanencia ---------- */
function checkCriteria(s) {
  const f = state.f, bad = [], nodata = [];
  const chk = (ok, has, label) => { if (!has) nodata.push(label); else if (!ok) bad.push(label); };
  chk(s.pe < f.maxPE, s.pe != null, 'PER ' + num(s.pe) + ' (pide <' + f.maxPE + ')');
  chk(s.forwardPe < f.maxFwdPE, s.forwardPe != null, 'PER fut ' + num(s.forwardPe) + ' (pide <' + f.maxFwdPE + ')');
  chk(s.priceToSales < f.maxPS, s.priceToSales != null, 'P/V ' + num(s.priceToSales) + ' (pide <' + f.maxPS + ')');
  chk(s.peg < f.maxPEG, s.peg != null, 'PEG ' + num(s.peg) + ' (pide <' + f.maxPEG + ')');
  chk(s.roe >= f.minROE, s.roe != null, 'ROE ' + num(s.roe, 1) + '% (pide ≥' + f.minROE + '%)');
  chk(s.netMargin >= f.minMargin, s.netMargin != null, 'margen ' + num(s.netMargin, 1) + '% (pide ≥' + f.minMargin + '%)');
  if (f.divOnly) chk(s.dividendYield > 0, s.dividendYield != null, 'sin dividendo');
  return { bad, nodata };
}
function failReasons(s) { return checkCriteria(s).bad; }
/* ---------- regla mediano plazo: meta +50% / stop −20% ---------- */
function tpSlHTML(b, cur) {
  if (b.horizon !== 'mediano' || !(b.price > 0)) return '';
  const tp = b.price * 1.5, sl = b.price * 0.8;
  let st = '';
  if (cur != null && isFinite(cur)) {
    if (cur >= tp) st = ' · <strong class="up">¡meta alcanzada! 🎉</strong>';
    else if (cur <= sl) st = ' · <strong class="down">stop tocado 🛑</strong>';
    else st = ' · <span class="mut">va ' + pct((cur - b.price) / b.price * 100) + '</span>';
  }
  return '<div class="buy-prob">🎯 Meta +50%: <strong>' + money(tp) + '</strong>' +
    ' · Stop −20%: <strong>' + money(sl) + '</strong>' + st + '</div>';
}
function etfBadgeHTML(s) {
  if (!s || s.price == null) return '';
  const c = checkCriteria(s);
  if (c.bad.length)
    return '<div class="buy-prob">🔴 <strong>No cumple</strong> los criterios del ETF → candidata a vender. Falla: ' + esc(c.bad.join(' · ')) + '</div>';
  if (c.nodata.length)
    return '<div class="buy-prob">🟡 <strong>Cumple</strong> en lo medido; sin dato para: ' + esc(c.nodata.join(' · ')) + '</div>';
  return '<div class="buy-prob">🟢 <strong>Cumple</strong> los criterios del ETF</div>';
}
function etfCandidates() {
  const held = {};
  BUYS.forEach((b) => { held[b.symbol] = true; });
  return STOCKS.filter((s) => !held[s.symbol] && passesLong(s))
    .sort((a, b) => (b.longScore ?? -1) - (a.longScore ?? -1)).slice(0, 5);
}

function visibleStocks() {
  const q = state.query.trim().toLowerCase();
  const arr = STOCKS.filter((s) => {
    if (state.tab === 'long' && !passesLong(s)) return false;
    if (state.sector !== 'all' && s.sector !== state.sector) return false;
    if (state.sigfilter && state.sigfilter !== 'all' && !(s.sig && s.sig[state.sigfilter])) return false;
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

/* ---------- señales del día (medallitas) ---------- */
function sigBadges(s) {
  const g = s.sig;
  if (!g) return '';
  let h = '';
  if (g.boll) h += '<span class="sigb boll">🟢 Bollinger</span>';
  if (g.bollw) h += '<span class="sigb bollw">📗 Bollinger sem</span>';
  if (g.rp) h += '<span class="sigb rpiso">🔵 REBOTE piso</span>';
  if (g.rt) h += '<span class="sigb rtecho">🔴 REBOTE techo</span>';
  return h ? '<div class="sigrow">' + h + '</div>' : '';
}
function sigDetailHTML(s) {
  const g = s.sig;
  if (!g || !(g.boll || g.bollw || g.rp || g.rt)) return '';
  let h = '<h4>Señales</h4><div class="sigdetail">';
  if (g.boll)
    h += '<p>🟢 <b>Bollinger recuperando (diaria):</b> ayer cerró bajo la banda inferior y hoy volvió adentro — el gatillo del susto. Backtest 2007–2026: PF 1.4 en acciones, 1.6 en calls/spreads.</p>';
  if (g.bollw)
    h += '<p>📗 <b>Bollinger recuperando (semanal):</b> la semana pasada cerró bajo la banda inferior y esta volvió adentro. Backtest 2007–2026: PF 2.7 en acciones, 3.0 en calls/spreads — la señal más fuerte del sistema.</p>';
  if (g.rp) {
    let flip = '';
    if (s.gexmap && s.gexmap.flip != null)
      flip = ' Flip en $' + s.gexmap.flip + ': ' +
        (s.price < s.gexmap.flip ? 'bajo el flip ✓' : 'sobre el flip ⚠');
    h += '<p>🔵 <b>REBOTE piso:</b> primer día con RSI&lt;30, cerca del mínimo de 10 días y sobre la EMA200.' + flip + '</p>';
  }
  if (g.rt) {
    let flip = '';
    if (s.gexmap && s.gexmap.flip != null)
      flip = ' Flip en $' + s.gexmap.flip + ': ' +
        (s.price < s.gexmap.flip ? 'bajo el flip ✓' : 'sobre el flip ⚠');
    h += '<p>🔴 <b>REBOTE techo:</b> primer día con RSI&gt;70, cerca del máximo de 10 días y bajo la EMA200.' + flip + '</p>';
  }
  return h + '</div>';
}

/* ---------- heat map gamma (precalculado en el cron) ---------- */
function fmtGex(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  return Math.round(v / 1e3) + 'K';
}
function gexHTML(s) {
  const g = s.gexmap;
  if (!g || !g.strikes || g.strikes.length < 3) {
    return '<h4>Heat Map Gamma</h4>' +
      '<p class="meta-line">Precalculado solo para el watchlist (top 40 + tus tickers).</p>';
  }
  const mx = Math.max.apply(null, g.gex.map((v) => Math.abs(v)).concat([1]));
  const order = g.strikes.map((_, i) => i).sort((a, b) => g.strikes[b] - g.strikes[a]);
  let rows = '';
  order.forEach((i) => {
    const st = g.strikes[i], v = g.gex[i];
    const w = (Math.abs(v) / mx * 100).toFixed(1);
    const isSpot = Math.abs(st - g.spot) < g.spot * 0.003;
    const isFlip = g.flip != null && st === g.flip;
    rows += '<div class="gxrow' + (isSpot ? ' gxspot' : '') + '">' +
      '<span class="gxk' + (isFlip ? ' gxflip' : '') + '">' + st + '</span>' +
      '<div class="gxtrack"><div class="' + (v >= 0 ? 'gxpos' : 'gxneg') +
      '" style="width:' + w + '%"></div></div>' +
      '<span class="gxv">' + fmtGex(v) + '</span></div>';
  });
  const lvl = (lbl, v) => '<span>' + lbl + ': <b>' + (v == null ? '—' : v) + '</b></span>';
  return '<h4>Heat Map Gamma <span class="hsub">retraso ~15 min</span></h4>' +
    '<div class="gxmap">' + rows + '</div>' +
    '<p class="meta-line">' + lvl('Flip', g.flip) + ' · ' + lvl('Muro call', g.cw) +
    ' · ' + lvl('Muro put', g.pw) +
    ' · <span class="up">■</span> positiva <span class="down">■</span> negativa</p>';
}

/* ---------- trampa de valor: parece barata pero los beneficios caen ----------
   Regla: PER futuro > PER actual (el consenso espera menos beneficios),
   o PEG negativo (crecimiento esperado negativo). */
function isValueTrap(s) {
  if (!(s.pe > 0)) return false;
  if (s.forwardPe > 0 && s.forwardPe > s.pe * 1.05) return true;
  if (s.peg != null && isFinite(s.peg) && s.peg < 0) return true;
  return false;
}
const TRAP_TIP = 'Posible trampa de valor: parece barata pero el consenso espera que los beneficios caigan.';
function trapBannerHTML(s) {
  return isValueTrap(s)
    ? '<div class="trap-banner">⚠️ ' + TRAP_TIP + '</div>'
    : '';
}

/* ---------- cinta de mercado ---------- */
function renderTape(tape) {
  const track = document.getElementById('tapeTrack');
  if (!track) return;
  if (!tape.length) { track.innerHTML = ''; return; }
  const item = (t) => {
    const up = t.chgPct >= 0;
    return '<span class="titem"><b>' + esc(t.label) + '</b> ' + fmtNum(t.price) +
      ' <span class="' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') +
      Math.abs(t.chgPct).toFixed(2) + '%</span></span>';
  };
  const half = tape.map(item).join('<span class="tsep">•</span>');
  track.innerHTML = half + '<span class="tsep">•</span>' + half + '<span class="tsep">•</span>';
}
function fmtNum(v) {
  return v >= 1000 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 100) / 100).toString();
}

/* ---------- probabilidades de alcanzar objetivos ---------- */
const PROB_TARGETS = { max10d: 'Máx 10d', p5: '+5%', p10: '+10%' };
const PROB_DESCR = { max10d: 'máximo de los últimos 10 días', p5: '5% sobre el precio actual', p10: '10% sobre el precio actual' };
function probTargetLine(s, key) {
  const t = s.prob[key];
  const done = t.level <= s.price;
  const ivLine = (s.prob.iv != null)
    ? ' · IV ' + num(s.prob.iv * 100, 1) + '%' + (s.prob.ivExp ? ' (' + esc(s.prob.ivExp) + ')' : '')
    : '';
  return '🎯 Objetivo: <b>' + money(t.level) + '</b> <span class="mut">(' +
    PROB_DESCR[key] + (done ? ' — ya está en ese precio' : '') + ')' + ivLine + '</span>';
}
function probCell(v, done) {
  return done ? 'ya está ahí' : probPct(v);
}
function probPct(v) { return (v == null || !isFinite(v)) ? '—' : Math.round(v * 100) + '%'; }
function probCls(p) {
  return (p == null || !isFinite(p)) ? '' : (p >= 0.65 ? 'up' : (p >= 0.4 ? 'mid' : 'down'));
}
function probSectionHTML(s) {
  const pr = s.prob;
  if (!pr || !pr.max10d) return '<h4>Probabilidades</h4><p class="meta-line">Sin datos suficientes.</p>';
  // si ya está en el máximo de 10d, ese objetivo no pinta nada: arrancar en +5%
  const defKey = (pr.max10d.level <= s.price && pr.p5) ? 'p5' : 'max10d';
  const t = pr[defKey];
  const done = t.level <= s.price;
  return '<h4>Probabilidades <span class="hsub">de tocar el objetivo en 30 días</span></h4>' +
    '<div class="probs" data-sym="' + esc(s.symbol) + '">' +
    '<div class="prob-targets">' +
    '<button class="chip sm' + (defKey === 'max10d' ? ' on' : '') + '" data-pt="max10d">Máx 10d</button>' +
    '<button class="chip sm' + (defKey === 'p5' ? ' on' : '') + '" data-pt="p5">+5%</button>' +
    '<button class="chip sm' + (defKey === 'p10' ? ' on' : '') + '" data-pt="p10">+10%</button>' +
    '</div>' +
    '<dl class="kv">' +
    '<div><dt>Estadística (histórica)</dt><dd class="pv ' + (done ? 'up' : probCls(t.p)) + '" data-pv="p">' + probCell(t.p, done) + '</dd></div>' +
    '<div><dt>Mercado (opciones)</dt><dd class="pv ' + (done ? 'up' : probCls(t.pm)) + '" data-pv="pm">' + probCell(t.pm, done) + '</dd></div>' +
    '</dl>' +
    '<p class="target-line" data-pline>' + probTargetLine(s, defKey) + '</p>' +
    '</div>';
}
function refreshProbLine(wrap, s, key) {
  const t = s.prob[key];
  if (!t) return;
  const done = t.level <= s.price;
  wrap.querySelectorAll('[data-pt]').forEach((b) => b.classList.toggle('on', b.dataset.pt === key));
  [['p', t.p], ['pm', t.pm]].forEach(([name, v]) => {
    const dd = wrap.querySelector('[data-pv="' + name + '"]');
    dd.textContent = probCell(v, done);
    dd.className = 'pv ' + (done ? 'up' : probCls(v));
  });
  wrap.querySelector('[data-pline]').innerHTML = probTargetLine(s, key);
}

function detailHTML(s) {
  const distEma = (s.price != null && s.ema200 != null && s.ema200 !== 0)
    ? ((s.price - s.ema200) / s.ema200) * 100 : null;
  return '<div class="detail">' +
    gexHTML(s) +
    trapBannerHTML(s) +
    sigDetailHTML(s) +
    newsStockHTML(s) +
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
    probSectionHTML(s) +
    '<h4>Gráfico</h4><div class="tv-chart" role="img" aria-label="Gráfico de ' + esc(s.symbol) + '"></div>' +
    '<p class="meta-line">' + esc(s.company) + ' · ' + esc(s.sector) + ' · ' + esc(s.exchange) +
    ' · cobertura: ' + num(s[TABS[state.tab].cov], 0) + '%</p>' +
    '</div>';
}

/* ---------- noticias ---------- */
const TONE_DOT = { pos: '🟢', neg: '🔴', neu: '⚪' };
function toneDot(t) { return TONE_DOT[t] || '⚪'; }
function renderNews() {
  const sec = $('#newsSec');
  if (!sec) return;
  if (!NEWS.length) { sec.hidden = true; return; }
  sec.hidden = false;
  $('#newsCount').textContent = NEWS.length + ' titulares';
  $('#newsList').innerHTML = NEWS.map((n) =>
    '<div class="nitem"><div class="ntop"><span class="ndot">' + toneDot(n.tone) + '</span>' +
    '<a class="ntitle" href="' + esc(n.u) + '" target="_blank" rel="noopener">' + esc(n.t) + '</a></div>' +
    '<div class="nmeta"><span>' + esc(n.src) + '</span>' +
    (n.tickers || []).map((t) => '<button class="nchip" data-sym="' + esc(t) + '">' + esc(t) + '</button>').join('') +
    '</div></div>').join('');
}
function newsStockHTML(s) {
  const hits = NEWS.filter((n) => (n.tickers || []).indexOf(s.symbol) !== -1);
  if (!hits.length) return '';
  return '<div class="snews"><h4>📰 Noticias que la mencionan</h4>' +
    hits.map((n) =>
      '<div class="nitem"><div class="ntop"><span class="ndot">' + toneDot(n.tone) + '</span>' +
      '<a class="ntitle" href="' + esc(n.u) + '" target="_blank" rel="noopener">' + esc(n.t) + '</a></div>' +
      '<div class="nmeta"><span>' + esc(n.src) + '</span></div></div>').join('') + '</div>';
}
function bindNews() {
  const t = $('#newsToggle');
  if (t) t.addEventListener('click', () => {
    const l = $('#newsList'), open = l.hidden;
    l.hidden = !open;
    t.setAttribute('aria-expanded', String(open));
    t.querySelector('.chev').textContent = open ? '▾' : '▸';
  });
  const nl = $('#newsList');
  if (nl) nl.addEventListener('click', (e) => {
    const b = e.target.closest('.nchip');
    if (!b) return;
    state.query = b.dataset.sym;
    const si = $('#search'); if (si) si.value = state.query;
    render();
    const lst = $('#list'); if (lst) lst.scrollIntoView();
  });
}

/* ---------- oportunidades del día ---------- */
function renderOpp() {
  const sec = $('#oppSec');
  if (!sec) return;
  if (!OPP.length) { sec.hidden = true; return; }
  sec.hidden = false;
  $('#oppCount').textContent = OPP.length + ' en la lista';
  $('#oppList').innerHTML = OPP.map((o) =>
    '<div class="nitem"><div class="ntop">' +
    '<button class="nchip" data-sym="' + esc(o.symbol) + '">' + esc(o.symbol) + '</button>' +
    '<span class="ntitle" style="text-decoration:none">' + esc(o.company || '') + '</span>' +
    (o.esNueva ? '<span>🆕</span>' : '') +
    '<span class="tag tag-dca">Para DCA</span>' +
    '</div>' +
    '<div class="nmeta"><span>' + money(o.price) + '</span>' +
    '<span class="' + cls(o.changePct) + '">día ' + pct(o.changePct) + '</span>' +
    '<span class="' + cls(o.perfWeek) + '">sem ' + pct(o.perfWeek) + '</span>' +
    '<span class="' + cls(o.perfMonth) + '">mes ' + pct(o.perfMonth) + '</span>' +
    '<span>RSI ' + num(o.rsi, 0) + '</span></div>' +
    '<div class="nmeta"><span>PER ' + num(o.pe, 1) + ' · ROE ' + num(o.roe, 0) + '% · margen ' + num(o.netMargin, 0) + '% · div ' + num(o.dividendYield, 2) + '%</span></div>' +
    '<div class="nmeta"><span>Castigo: ' + esc((o.motivos || []).join(' · ')) + '</span></div>' +
    '</div>').join('');
}
function bindOpp() {
  const t = $('#oppToggle');
  if (t) t.addEventListener('click', () => {
    const l = $('#oppList'), open = l.hidden;
    l.hidden = !open;
    t.setAttribute('aria-expanded', String(open));
    t.querySelector('.chev').textContent = open ? '▾' : '▸';
  });
  const ol = $('#oppList');
  if (ol) ol.addEventListener('click', (e) => {
    const b = e.target.closest('.nchip');
    if (!b) return;
    state.query = b.dataset.sym;
    const si = $('#search'); if (si) si.value = state.query;
    render();
    const lst = $('#list'); if (lst) lst.scrollIntoView();
  });
}

/* ---------- oportunidades en opciones ---------- */
function renderOpts() {
  const sec = $('#oppOptSec');
  if (!sec) return;
  if (!OPTS.length) { sec.hidden = true; return; }
  sec.hidden = false;
  $('#oppOptCount').textContent = OPTS.length + ' setups completos';
  const estTxt = (o) => {
    const lado = o.lado === 'call' ? 'call' : 'put';
    if (o.estructura === 'spread') return 'Spread ' + lado + ' ' + num(o.kLong, 0) + '/' + num(o.kShort, 0);
    return (o.lado === 'call' ? 'Call sola ' : 'Put sola ') + num(o.kLong, 0);
  };
  $('#oppOptList').innerHTML = OPTS.map((o) =>
    '<div class="nitem"><div class="ntop">' +
    '<span>' + (o.sentido === 'alcista' ? '🟢' : '🔴') + '</span>' +
    '<button class="nchip" data-sym="' + esc(o.symbol) + '">' + esc(o.symbol) + '</button>' +
    '<span class="ntitle" style="text-decoration:none">' + esc(o.company || '') + '</span>' +
    (o.esNueva ? '<span>🆕</span>' : '') +
    '<span class="tag tag-papel">Solo papel</span>' +
    '</div>' +
    '<div class="nmeta"><span><b>' + estTxt(o) + '</b> · vence ' + esc(o.expiry) + ' (' + o.dte + 'd) · delta ' + num(o.delta, 2) + '</span></div>' +
    '<div class="nmeta"><span>Débito ' + money(o.debit) + ' · BE ' + money(o.be) +
    (o.target ? ' · target ' + money(o.target) : ' · tendencia abierta') +
    (o.maxProfit ? ' · máx gana ' + money(o.maxProfit) : '') +
    ' · máx pierde ' + money(o.maxLoss) + '</span></div>' +
    '<div class="nmeta"><span>Spot ' + money(o.price) + ' · IV ' + num(o.ivPct, 0) + '% vs HV ' + num(o.hvPct, 0) + '% (×' + num(o.ivHv, 2) + ') · RSI ' + num(o.rsi, 0) + ' · sem ' + pct(o.perfWeek) + '</span></div>' +
    '</div>').join('');
}
function bindOpts() {
  const t = $('#oppOptToggle');
  if (t) t.addEventListener('click', () => {
    const l = $('#oppOptList'), open = l.hidden;
    l.hidden = !open;
    t.setAttribute('aria-expanded', String(open));
    t.querySelector('.chev').textContent = open ? '▾' : '▸';
  });
  const ol = $('#oppOptList');
  if (ol) ol.addEventListener('click', (e) => {
    const b = e.target.closest('.nchip');
    if (!b) return;
    state.query = b.dataset.sym;
    const si = $('#search'); if (si) si.value = state.query;
    render();
    const lst = $('#list'); if (lst) lst.scrollIntoView();
  });
}

/* ---------- Calc: probabilidad por trade (port de prob_calc.py) ---------- */
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return s * y;
}
const ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function bs_call(S, K, T, r, q, sig) {
  if (T <= 0 || sig <= 0) return Math.max(S - K, 0);
  const sT = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sig * sig) * T) / sT;
  const d2 = d1 - sT;
  return S * Math.exp(-q * T) * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2);
}
function bs_put(S, K, T, r, q, sig) {
  return bs_call(S, K, T, r, q, sig) - S * Math.exp(-q * T) + K * Math.exp(-r * T);
}
function cspread_val(S, K1, K2, T, r, q, sig) {
  return bs_call(S, K1, T, r, q, sig) - bs_call(S, K2, T, r, q, sig);
}
function pspread_val(S, K1, K2, T, r, q, sig) {
  return bs_put(S, K2, T, r, q, sig) - bs_put(S, K1, T, r, q, sig);
}
function imp_vol(pricer, S, K1, K2, T, r, q, price) {
  let lo = 0.01, hi = 3.0;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (pricer(S, K1, K2, T, r, q, mid) < price) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
function barrier_up(pricer, S, K1, K2, T, r, q, sig, target) {
  const width = K2 - K1;
  let lo = S, hi = K2;
  while (pricer(hi, K1, K2, T, r, q, sig) < target) {
    hi += width;
    if (hi > S + 5 * width) return null;
  }
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (pricer(mid, K1, K2, T, r, q, sig) < target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
function barrier_down(pricer, S, K1, K2, T, r, q, sig, target) {
  const width = K2 - K1;
  let lo = K1, hi = S;
  while (pricer(lo, K1, K2, T, r, q, sig) < target) {
    lo -= width;
    if (lo < S - 5 * width) return null;
  }
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (pricer(mid, K1, K2, T, r, q, sig) < target) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}
function p_touch_up(S, H, T, r, q, sig) {
  if (H <= S) return 1.0;
  if (T <= 0) return 0.0;
  const nu = r - q - 0.5 * sig * sig;
  const x = Math.log(H / S), sT = sig * Math.sqrt(T);
  const p = ncdf(-(x - nu * T) / sT) + Math.exp(2 * nu * x / (sig * sig)) * ncdf(-(x + nu * T) / sT);
  return Math.min(Math.max(p, 0), 0.999);
}
function p_touch_down(S, H, T, r, q, sig) {
  if (H >= S) return 1.0;
  if (T <= 0) return 0.0;
  const nu = r - q - 0.5 * sig * sig;
  const y = Math.log(S / H), sT = sig * Math.sqrt(T);
  const p = ncdf(-(y + nu * T) / sT) + Math.exp(-2 * nu * y / (sig * sig)) * ncdf(-(y - nu * T) / sT);
  return Math.min(Math.max(p, 0), 0.999);
}

function calcStock(sym) {
  return stockBySym(sym) || BENCH[sym] || null;
}
let calcMode = 'spread';
function renderCalc() {
  renderCount();
  const box = $('#list');
  box.innerHTML =
    '<h3 class="sec-title">🧮 Calculadora por trade <span class="mut" style="font-size:12px">🧪 papel</span></h3>' +
    '<div class="chip-row">' +
    '<button class="chip sm" data-cm="spread">Spread</button>' +
    '<button class="chip sm" data-cm="csp">CSP (put vendido)</button>' +
    '<button class="chip sm" data-cm="cov">Covered call</button></div>' +
    '<div id="calcBody"></div>';
  box.querySelectorAll('[data-cm]').forEach((b) => {
    b.classList.toggle('on', b.dataset.cm === calcMode);
    b.addEventListener('click', () => { calcMode = b.dataset.cm; renderCalc(); });
  });
  const body = $('#calcBody');
  if (calcMode === 'csp') renderCspCalc(body);
  else if (calcMode === 'cov') renderCovCalc(body);
  else renderSpreadCalc(body);
}
function renderSpreadCalc(box) {
  box.innerHTML =
    '<p class="rule-note">¿Qué chance tiene tu spread de tocar el target antes del vencimiento? ' +
    'La IV se deduce de tu débito real. Fórmula validada contra simulación.</p>' +
    '<form id="calcForm" class="calc-form">' +
    '<label>Símbolo<input id="c_sym" list="csymlist" autocomplete="off" placeholder="Ej: SPY"><datalist id="csymlist"><option value="SPY">SPDR S&P 500 ETF</option><option value="QQQ">Invesco QQQ Trust</option>' + SYMLIST_HTML + '</datalist></label>' +
    '<div id="c_info" class="mut"></div>' +
    '<div class="calc-grid">' +
    '<label>Tipo<select id="c_type"><option value="call">Call debit</option><option value="put">Put debit</option></select></label>' +
    '<label>Días al vencimiento<input id="c_dte" type="number" min="1" value="20" inputmode="numeric"></label>' +
    '<label>Strike largo<input id="c_k1" type="number" step="any" inputmode="decimal" placeholder="Ej: 780"></label>' +
    '<label>Strike corto<input id="c_k2" type="number" step="any" inputmode="decimal" placeholder="Ej: 783"></label>' +
    '<label>Débito pagado<input id="c_debit" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Ej: 0.85"></label>' +
    '<label>Target del spread<input id="c_target" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Ej: 1.30"></label>' +
    '</div>' +
    '<p class="form-err" id="c_err" hidden></p>' +
    '<button type="submit" class="btn">Calcular</button>' +
    '</form><div id="calcOut"></div>';

  const info = () => {
    const st = calcStock(($('#c_sym').value || '').trim().toUpperCase());
    $('#c_info').textContent = st && st.price != null
      ? 'Precio: ' + money(st.price) + (st.prob && st.prob.hv ? ' · HV 60d: ' + pct(st.prob.hv * 100) : ' · sin HV')
      : '';
  };
  $('#c_sym').addEventListener('input', info);

  $('#calcForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#c_err');
    const fail = (m) => { err.textContent = m; err.hidden = false; $('#calcOut').innerHTML = ''; };
    err.hidden = true;
    const sym = ($('#c_sym').value || '').trim().toUpperCase();
    const st = calcStock(sym);
    if (!st) return fail('Símbolo no encontrado en la lista.');
    const S = st.price, hv = st.prob && st.prob.hv;
    if (!(S > 0)) return fail('Sin precio para ' + sym + '.');
    if (!(hv > 0)) return fail('Sin volatilidad histórica para ' + sym + '.');
    const isCall = $('#c_type').value === 'call';
    const K1 = parseFloat($('#c_k1').value), K2 = parseFloat($('#c_k2').value);
    const debit = parseFloat($('#c_debit').value), target = parseFloat($('#c_target').value);
    const dte = parseInt($('#c_dte').value, 10);
    if (!(K1 > 0 && K2 > K1)) return fail('Strikes inválidos: el corto debe ser mayor que el largo.');
    if (!(debit > 0)) return fail('El débito debe ser mayor que 0.');
    if (!(target > debit)) return fail('El target debe ser mayor que el débito (si no, ya estarías ahí).');
    const width = K2 - K1;
    if (!(target < width)) return fail('El target no puede pasar el ancho del spread ($' + width.toFixed(2) + ').');
    if (!(dte >= 1)) return fail('El vencimiento debe ser al menos 1 día.');
    const r = 0.045;
    const q = st.dividendYield != null ? st.dividendYield / 100 : 0.01;
    const T = dte / 365;
    const pricer = isCall ? cspread_val : pspread_val;
    const iv = imp_vol(pricer, S, K1, K2, T, r, q, debit);
    const H = isCall
      ? barrier_up(pricer, S, K1, K2, T, r, q, iv, target)
      : barrier_down(pricer, S, K1, K2, T, r, q, iv, target);
    if (H == null) return fail('No se encontró barrera para ese target con esa IV.');
    const touch = isCall ? p_touch_up : p_touch_down;
    const pHv = touch(S, H, T, r, q, hv);
    const pIv = touch(S, H, T, r, q, iv);
    const dir = isCall ? 'suba a' : 'baje a';
    $('#calcOut').innerHTML =
      '<div class="calc-out">' +
      '<div><dt>IV implícita de tu débito</dt><dd>' + pct(iv * 100) + '</dd></div>' +
      '<div><dt>Barrera</dt><dd>el spread vale ' + money(target) + ' si ' + sym + ' ' + dir + ' ' + money(H) + '</dd></div>' +
      '<div><dt>P(tocar target) estadística</dt><dd><strong class="' + probCls(pHv) + '">' + probPct(pHv) + '</strong> <span class="mut">con HV 60d</span></dd></div>' +
      '<div><dt>P(tocar target) mercado</dt><dd><strong class="' + probCls(pIv) + '">' + probPct(pIv) + '</strong> <span class="mut">con IV de tu débito</span></dd></div>' +
      '</div><p class="news-note">Probabilidades del modelo, no garantías. El débito ya es tu pérdida máxima.</p>';
  });
}

/* ---------- Calc: CSP (put vendido) ---------- */
function d2of(S, K, T, r, q, sig) {
  const sT = sig * Math.sqrt(T);
  return (Math.log(S / K) + (r - q - 0.5 * sig * sig) * T) / sT;
}
function wallNote(st, key, label) {
  const w = st && st.gexmap && st.gexmap[key];
  return w ? ' <span class="mut">(' + label + ' ' + money(w) + ')</span>' : '';
}
function renderCspCalc(box) {
  box.innerHTML =
    '<p class="rule-note">Vendes un put bajo el soporte: si cae ahí, compras la acción con descuento; ' +
    'si no, te quedas la prima. En vivo necesitas <strong>strike × 100</strong> de colateral por contrato.</p>' +
    '<form id="cspForm" class="calc-form">' +
    '<label>Símbolo<input id="p_sym" list="psymlist" autocomplete="off" placeholder="Ej: VZ"><datalist id="psymlist"><option value="SPY">SPDR S&P 500 ETF</option><option value="QQQ">Invesco QQQ Trust</option>' + SYMLIST_HTML + '</datalist></label>' +
    '<div id="p_info" class="mut"></div>' +
    '<div class="calc-grid">' +
    '<label>Strike del put<input id="p_k" type="number" step="any" inputmode="decimal" placeholder="Ej: 44"></label>' +
    '<label>Días al vencimiento<input id="p_dte" type="number" min="1" value="30" inputmode="numeric"></label>' +
    '</div>' +
    '<p class="form-err" id="p_err" hidden></p>' +
    '<button type="submit" class="btn">Calcular</button>' +
    '</form><div id="cspOut"></div>';

  const syncInfo = () => {
    const st = calcStock(($('#p_sym').value || '').trim().toUpperCase());
    const kEl = $('#p_k');
    let note = '';
    if (st && st.price != null) {
      note = 'Precio: ' + money(st.price) + (st.prob && st.prob.hv ? ' · HV 60d: ' + pct(st.prob.hv * 100) : '');
      const pw = st.gexmap && st.gexmap.pw;
      if (pw && !kEl.value) { kEl.value = pw; note += ' · strike sugerido: muro put'; }
      else if (pw) note += wallNote(st, 'pw', 'muro put');
    }
    $('#p_info').innerHTML = note;
  };
  $('#p_sym').addEventListener('input', syncInfo);

  $('#cspForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#p_err');
    const fail = (m) => { err.textContent = m; err.hidden = false; $('#cspOut').innerHTML = ''; };
    err.hidden = true;
    const sym = ($('#p_sym').value || '').trim().toUpperCase();
    const st = calcStock(sym);
    if (!st) return fail('Símbolo no encontrado en la lista.');
    const S = st.price, hv = st.prob && st.prob.hv;
    if (!(S > 0)) return fail('Sin precio para ' + sym + '.');
    if (!(hv > 0)) return fail('Sin volatilidad histórica para ' + sym + '.');
    const K = parseFloat($('#p_k').value), dte = parseInt($('#p_dte').value, 10);
    if (!(K > 0)) return fail('Pon el strike del put.');
    if (!(dte >= 1)) return fail('El vencimiento debe ser al menos 1 día.');
    const r = 0.045, q = st.dividendYield != null ? st.dividendYield / 100 : 0.01;
    const T = dte / 365;
    const iv = st.prob && st.prob.iv > 0 ? st.prob.iv : null;
    const one = (sig, tag) => {
      const prem = bs_put(S, K, T, r, q, sig);
      const pA = ncdf(-d2of(S, K, T, r, q, sig));
      const ret = prem / (K - prem);
      return '<div><dt>' + tag + '</dt><dd></dd></div>' +
        '<div><dt>Prima estimada</dt><dd>' + money(prem) + ' /acción</dd></div>' +
        '<div><dt>P(asignación)</dt><dd><strong class="' + probCls(pA) + '">' + probPct(pA) + '</strong></dd></div>' +
        '<div><dt>Retorno si no te asignan</dt><dd>' + pct(ret * 100) + ' en ' + dte + 'd <span class="mut">(' + pct(ret * 365 / dte * 100) + ' anualizado)</span></dd></div>' +
        '<div><dt>Breakeven</dt><dd>' + money(K - prem) + '</dd></div>';
    };
    let html = '<div class="calc-out">' + one(hv, 'Con HV 60d (estadística)');
    if (iv) html += one(iv, 'Con IV de mercado');
    html += '<div><dt>Colateral por contrato (en vivo)</dt><dd>' + money(K * 100) + '</dd></div>';
    html += '</div><p class="news-note">Si te asignan, compras 100 acciones a ' + money(K) + ' (' + money(K * 100) + '). Probabilidades del modelo, no garantías.</p>';
    $('#cspOut').innerHTML = html;
  });
}

/* ---------- Calc: Covered call ---------- */
function renderCovCalc(box) {
  box.innerHTML =
    '<p class="rule-note">Vendes un call sobre tus 100 acciones: si sube al strike, te las llevan con ganancia; ' +
    'si no, te quedas la prima. Requiere tener las acciones (en vivo).</p>' +
    '<form id="covForm" class="calc-form">' +
    '<label>Símbolo<input id="v_sym" list="vsymlist" autocomplete="off" placeholder="Ej: KO"><datalist id="vsymlist"><option value="SPY">SPDR S&P 500 ETF</option><option value="QQQ">Invesco QQQ Trust</option>' + SYMLIST_HTML + '</datalist></label>' +
    '<div id="v_info" class="mut"></div>' +
    '<div class="calc-grid">' +
    '<label>Strike del call<input id="v_k" type="number" step="any" inputmode="decimal" placeholder="Ej: 95"></label>' +
    '<label>Días al vencimiento<input id="v_dte" type="number" min="1" value="30" inputmode="numeric"></label>' +
    '</div>' +
    '<p class="form-err" id="v_err" hidden></p>' +
    '<button type="submit" class="btn">Calcular</button>' +
    '</form><div id="covOut"></div>';

  const syncInfo = () => {
    const st = calcStock(($('#v_sym').value || '').trim().toUpperCase());
    const kEl = $('#v_k');
    let note = '';
    if (st && st.price != null) {
      note = 'Precio: ' + money(st.price) + (st.prob && st.prob.hv ? ' · HV 60d: ' + pct(st.prob.hv * 100) : '');
      const cw = st.gexmap && st.gexmap.cw;
      if (cw && !kEl.value) { kEl.value = cw; note += ' · strike sugerido: muro call'; }
      else if (cw) note += wallNote(st, 'cw', 'muro call');
    }
    $('#v_info').innerHTML = note;
  };
  $('#v_sym').addEventListener('input', syncInfo);

  $('#covForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#v_err');
    const fail = (m) => { err.textContent = m; err.hidden = false; $('#covOut').innerHTML = ''; };
    err.hidden = true;
    const sym = ($('#v_sym').value || '').trim().toUpperCase();
    const st = calcStock(sym);
    if (!st) return fail('Símbolo no encontrado en la lista.');
    const S = st.price, hv = st.prob && st.prob.hv;
    if (!(S > 0)) return fail('Sin precio para ' + sym + '.');
    if (!(hv > 0)) return fail('Sin volatilidad histórica para ' + sym + '.');
    const K = parseFloat($('#v_k').value), dte = parseInt($('#v_dte').value, 10);
    if (!(K > 0)) return fail('Pon el strike del call.');
    if (!(dte >= 1)) return fail('El vencimiento debe ser al menos 1 día.');
    const r = 0.045, q = st.dividendYield != null ? st.dividendYield / 100 : 0.01;
    const T = dte / 365;
    const iv = st.prob && st.prob.iv > 0 ? st.prob.iv : null;
    const one = (sig, tag) => {
      const prem = bs_call(S, K, T, r, q, sig);
      const pA = ncdf(d2of(S, K, T, r, q, sig));
      const maxP = (K - S) + prem;
      const ret = maxP / (S - prem);
      return '<div><dt>' + tag + '</dt><dd></dd></div>' +
        '<div><dt>Prima estimada</dt><dd>' + money(prem) + ' /acción</dd></div>' +
        '<div><dt>P(que te lleven las acciones)</dt><dd><strong class="' + probCls(pA) + '">' + probPct(pA) + '</strong></dd></div>' +
        '<div><dt>Ganancia máx.</dt><dd>' + money(maxP) + ' <span class="mut">(' + pct(ret * 100) + ')</span></dd></div>' +
        '<div><dt>Breakeven</dt><dd>' + money(S - prem) + '</dd></div>';
    };
    let html = '<div class="calc-out">' + one(hv, 'Con HV 60d (estadística)');
    if (iv) html += one(iv, 'Con IV de mercado');
    html += '</div><p class="news-note">Cubierto = ya tienes las 100 acciones. Probabilidades del modelo, no garantías.</p>';
    $('#covOut').innerHTML = html;
  });
}

/* ---------- filas de acciones (con estrella de favorita) ---------- */
function stockArticle(s, sk) {
  const sc = s[sk];
  const open = state.open.has(s.symbol) ? ' open' : '';
  const fav = FAVS.indexOf(s.symbol) >= 0;
  return '<article class="stock' + open + '" data-sym="' + esc(s.symbol) + '">' +
    '<div class="rowwrap">' +
    '<button class="row" aria-expanded="' + state.open.has(s.symbol) + '">' +
    '<span class="sym">' + esc(s.symbol) +
    (isValueTrap(s) ? ' <span class="wtrap" title="' + TRAP_TIP + '">⚠️</span>' : '') + '</span>' +
    '<span class="nm">' + esc(s.company) + '</span>' +
    '<span class="px">' + money(s.price) +
    '<small class="' + cls(s.changePct) + '">' + pct(s.changePct) + '</small></span>' +
    '<span class="badge ' + badgeCls(sc) + '">' + (sc == null ? '—' : sc) + '</span>' +
    '</button>' +
    '<button class="fav' + (fav ? ' on' : '') + '" data-fav="' + esc(s.symbol) + '" aria-pressed="' + fav +
    '" aria-label="Marcar ' + esc(s.symbol) + ' como favorita">' + (fav ? '★' : '☆') + '</button>' +
    '</div>' + sigBadges(s) + detailHTML(s) + '</article>';
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
  const pr = st && st.prob && st.prob.max10d;
  const prDone = pr && cur != null && pr.level <= cur;
  const probLine = pr
    ? (prDone
      ? '<div class="buy-prob">Máx 10d ' + money(pr.level) + ': <strong class="up">ya recuperado ✓</strong></div>'
      : '<div class="buy-prob">P(tocar máx 10d ' + money(pr.level) + ' en 30d): ' +
        '<strong class="' + probCls(pr.p) + '">' + probPct(pr.p) + '</strong>' +
        (pr.pm != null ? ' · mercado <strong class="' + probCls(pr.pm) + '">' + probPct(pr.pm) + '</strong>' : '') +
        '</div>')
    : '';
  return '<div class="buy' + (state.open.has(b.symbol) ? ' open' : '') +
    '" data-sym="' + esc(b.symbol) + '">' +
    '<button class="buyrow" aria-expanded="' + state.open.has(b.symbol) +
    '" aria-label="Ver detalle de ' + esc(b.symbol) + '">' +
    '<span class="buy-top"><strong>' + esc(b.symbol) + '</strong>' +
    '<span class="mut">' + esc(String(b.shares)) + ' acc @ ' + money(b.price) +
    (b.date ? ' · ' + esc(b.date) : '') +
    (b.horizon === 'mediano' ? ' · mediano plazo' : '') + '</span></span>' +
    '<span class="buy-bot"><span>Ahora: ' + money(cur) + '</span>' +
    '<span class="' + cls(pl) + '">' + moneyS(pl) + ' (' + pct(plp) + ')</span></span>' +
    '</button>' +
    (isValueTrap(st || {}) ? '<div class="buy-prob">⚠️ ' + TRAP_TIP + '</div>' : '') +
    etfBadgeHTML(st) +
    tpSlHTML(b, cur) +
    probLine +
    '<div class="buy-actions"><button class="link" data-edit="' + i + '">Editar</button>' +
    '<button class="link danger" data-del="' + i + '">Borrar</button></div>' +
    (st ? detailHTML(st) : '') +
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
    '<label>Horizonte<select id="b_horizon"><option value="largo">Largo plazo (sin mirar)</option><option value="mediano">Mediano plazo (meta +50% / stop −20%)</option></select></label>' +
    '<p class="form-err" id="b_err" hidden></p>' +
    '<div class="form-actions"><button type="submit" class="btn sm" id="b_save">Guardar</button>' +
    '<button type="button" class="btn sm ghost" id="b_cancel">Cancelar</button></div>' +
    '</form>';
  html += '<div id="buyList">' + BUYS.map(buyRowHTML).join('') + '</div>';

  const fails = BUYS.filter((b) => { const st = stockBySym(b.symbol); return st && failReasons(st).length > 0; });
  const cands = etfCandidates();
  html += '<h3 class="sec-title">🎯 Candidatos del ETF</h3>' +
    '<p class="rule-note">Regla: cada compra debe cumplir los criterios de calidad de la pestaña Largo. ' +
    'Si deja de cumplir → se vende y se reemplaza por un candidato de abajo. ' +
    (fails.length
      ? 'Hoy tienes <strong>' + fails.length + '</strong> compra(s) que no cumplen: ' + fails.map((b) => esc(b.symbol)).join(', ') + '.'
      : 'Hoy todas tus compras cumplen ✓.') +
    ' Revisa una vez al mes, no cada día.</p>';
  html += cands.length
    ? cands.map((s) => stockArticle(s, 'longScore')).join('')
    : '<div class="empty"><strong>Sin candidatos</strong><p>Ninguna acción pasa los filtros ahora mismo.</p></div>';

  box.innerHTML = html;
  bindRows(box);
  box.querySelectorAll('.buyrow').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.buy');
      const sym = card.dataset.sym;
      if (state.open.has(sym)) {
        state.open.delete(sym); card.classList.remove('open'); unmountTVChart(card);
      } else {
        state.open.add(sym); card.classList.add('open'); mountTVChart(card);
      }
      btn.setAttribute('aria-expanded', state.open.has(sym));
    });
  });
  box.querySelectorAll('.stock.open, .buy.open').forEach(mountTVChart);

  const form = $('#buyForm');
  const showForm = (idx) => {
    editingIdx = idx;
    $('#b_err').hidden = true;
    if (idx >= 0) {
      const b = BUYS[idx];
      $('#b_sym').value = b.symbol; $('#b_shares').value = b.shares;
      $('#b_price').value = b.price; $('#b_date').value = b.date || '';
      $('#b_horizon').value = b.horizon || 'largo';
      $('#b_save').textContent = 'Guardar cambios';
    } else {
      $('#b_sym').value = ''; $('#b_shares').value = '';
      $('#b_price').value = ''; $('#b_date').value = new Date().toISOString().slice(0, 10);
      $('#b_horizon').value = 'largo';
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
    const horizon = $('#b_horizon').value === 'mediano' ? 'mediano' : 'largo';
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!stockBySym(sym)) return fail('Símbolo no encontrado en la lista.');
    if (!(shares > 0)) return fail('La cantidad debe ser mayor que 0.');
    if (!(price >= 0)) return fail('El precio no puede ser negativo.');
    const rec = { symbol: sym, shares: shares, price: price, date: date, horizon: horizon };
    if (editingIdx >= 0) BUYS[editingIdx] = rec; else BUYS.push(rec);
    saveBuys(); render();
  });
}

function render() {
  // panel de filtros solo en Largo; toolbar oculta en Mías
  $('#filterPanel').style.display = state.tab === 'long' ? '' : 'none';
  document.querySelector('.toolbarwrap').style.display = (state.tab === 'mine' || state.tab === 'calc') ? 'none' : '';
  if (state.tab === 'mine') { renderMine(); return; }
  if (state.tab === 'calc') { renderCalc(); return; }
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
  renderTape(data.tape || []);
  NEWS = data.news || [];
  OPP = data.oportunidades || [];
  OPTS = data.opciones || [];
  BENCH = data.benchmarks || {};
  renderNews();
  bindNews();
  renderOpp();
  bindOpp();
  renderOpts();
  bindOpts();
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
  $('#sigfilter').addEventListener('change', (e) => { state.sigfilter = e.target.value; render(); });
  $('#menuBtn').addEventListener('click', () => {
    const d = $('#menuDrop'), open = d.hidden;
    d.hidden = !open;
    $('#menuBtn').setAttribute('aria-expanded', String(open));
  });

  // selector de objetivo en la sección de probabilidades (delegado, una sola vez)
  $('#list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pt]');
    if (!btn) return;
    const wrap = btn.closest('.probs');
    const s = stockBySym(wrap.dataset.sym);
    if (s && s.prob && s.prob[btn.dataset.pt]) refreshProbLine(wrap, s, btn.dataset.pt);
  });

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
