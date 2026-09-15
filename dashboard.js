/**
 * The desk, served at GET / by index.js.
 *
 * Same-origin by necessity: the service sets no CORS headers, so a page hosted
 * anywhere else could not read these responses. The viewer types the service
 * token once and the browser keeps it in localStorage; it is never sent
 * anywhere but back here.
 *
 * Four tabs: the day's three posts with their real status and the buttons to
 * change them, a composer that draws the cards in the browser, the figures from
 * Meta, and the service's own health.
 *
 * The card design in the page script is a copy of daily_pause_card.py. That
 * duplication is deliberate — the morning task renders with headless Chromium
 * and the composer renders here — but it means a change to one is a change to
 * both, or the cards drift apart.
 *
 * The page is one template literal, so: no backticks, no dollar-brace, and
 * every backslash is doubled at build time.
 *
 * DO NOT EDIT THE STRING BELOW. Edit dashboard.page.html and run
 * `node src/build-dashboard.mjs`.
 */
import { PAGELLA_WOFF2_B64 } from './font.js';

const PAGE = `<!doctype html>
<html lang="en-GB"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Daily Pause — desk</title>
<style>
  :root{
    --ground:#FBFAF8; --raised:#FFFFFF; --sunk:#F4F1EC;
    --ink:#1F2124; --muted:#6E6A64; --faint:#96918A;
    --rule:#E6E1D9; --accent:#8A7B66;
    --good:#3F7A50; --warn:#9A6034; --bad:#9C3B32;
    --display:"Pagella Card","TeX Gyre Pagella",Palatino,"Palatino Linotype","Book Antiqua",Georgia,serif;
    --util:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){:root{
    --ground:#191B1E; --raised:#212428; --sunk:#16181B;
    --ink:#E8E4DE; --muted:#98928A; --faint:#746F68;
    --rule:#2E3237; --accent:#A8967E;
    --good:#7FAE88; --warn:#C79462; --bad:#D08078;
  }}
  @font-face{
    font-family:"Pagella Card"; font-style:normal; font-weight:400; font-display:block;
    src:url(data:font/woff2;base64,__FONT__) format("woff2");
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--util);
       font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding-inline:20px;padding-block:0 90px}
  h1{font-family:var(--display);font-weight:400;font-size:clamp(25px,4vw,33px);margin:0;line-height:1.15}
  h2{font-family:var(--display);font-weight:400;font-size:20px;margin:0}
  h3{font-family:var(--util);font-size:13px;font-weight:600;margin:0;
     letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
  a{color:var(--accent)}
  p{margin:0 0 10px}

  header{padding-block:38px 16px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
  header .sub{color:var(--muted);font-size:14px}
  header .spacer{flex:1}

  /* ------------------------------------------------------------- controls */
  button{font:inherit;font-size:14px;padding:7px 13px;border-radius:4px;cursor:pointer;
         border:1px solid var(--rule);background:var(--raised);color:var(--ink)}
  button:hover:not(:disabled){border-color:var(--accent)}
  button:disabled{opacity:.45;cursor:default}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.danger{color:var(--bad)}
  button.small{font-size:12.5px;padding:5px 10px}
  input,textarea,select{font:inherit;font-size:15px;width:100%;padding:9px 11px;
        border-radius:4px;border:1px solid var(--rule);background:var(--raised);color:var(--ink)}
  textarea{resize:vertical;line-height:1.5}
  label{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;
        color:var(--faint);font-weight:600;margin-bottom:5px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .check{display:flex;gap:7px;align-items:center;font-size:14px;color:var(--muted);
         text-transform:none;letter-spacing:0;font-weight:400;margin:0}
  .check input{width:auto}

  /* ---------------------------------------------------------------- tabs */
  nav.tabs{display:flex;gap:2px;border-bottom:1px solid var(--rule);margin-bottom:26px;
           flex-wrap:wrap}
  nav.tabs button{border:none;background:none;border-radius:0;padding:10px 14px;
           color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
  nav.tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--accent)}

  /* -------------------------------------------------------------- blocks */
  .banner{border-radius:4px;padding:14px 16px;margin-bottom:22px;border:1px solid var(--rule);
          background:var(--raised);font-size:14.5px}
  .banner.ok{border-color:var(--good)}
  .banner.bad{border-color:var(--bad)}
  .banner.warn{border-color:var(--warn)}
  .banner strong{display:block;margin-bottom:4px}
  .banner ul{margin:6px 0 0;padding-left:18px}

  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;
        margin-bottom:26px}
  .tile{background:var(--raised);border:1px solid var(--rule);border-radius:4px;padding:14px 15px}
  .tile .k{font-size:11.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint);
           font-weight:600}
  .tile .v{font-family:var(--display);font-size:25px;line-height:1.2;margin-top:5px}
  .tile .n{font-size:13px;color:var(--muted);margin-top:3px}
  .v.good{color:var(--good)} .v.warn{color:var(--warn)} .v.bad{color:var(--bad)}

  section{margin-bottom:32px}
  .sechead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
           margin-bottom:12px;flex-wrap:wrap}
  .sechead .when{font-size:13px;color:var(--faint)}

  .card{background:var(--raised);border:1px solid var(--rule);border-radius:4px;
        padding:16px;margin-bottom:14px}
  .card.held{border-left:3px solid var(--warn)}
  .card.gone{border-left:3px solid var(--good)}

  .slotline{display:flex;gap:14px;align-items:flex-start;margin-bottom:12px}
  .slotline img{width:96px;height:96px;object-fit:cover;border-radius:3px;flex:none;
                background:var(--sunk);border:1px solid var(--rule)}
  .slotline .meta{min-width:0;flex:1}
  .slotline .title{font-family:var(--display);font-size:19px;line-height:1.25}
  .slotline .due{font-size:13px;color:var(--muted);margin-top:2px}

  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .chip{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:600;
        padding:3px 8px;border-radius:999px;border:1px solid var(--rule);color:var(--muted)}
  .chip.good{color:var(--good);border-color:var(--good)}
  .chip.warn{color:var(--warn);border-color:var(--warn)}
  .chip.bad{color:var(--bad);border-color:var(--bad)}

  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;
           padding-top:12px;border-top:1px solid var(--rule)}

  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
  th{font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
     font-weight:600;white-space:nowrap}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:4px;background:var(--raised)}
  .dim{color:var(--faint)}
  .quiet{color:var(--muted);font-size:14px}
  .mono{font-family:var(--mono);font-size:12.5px}

  pre.log{background:var(--sunk);border:1px solid var(--rule);border-radius:4px;padding:12px 14px;
      font-family:var(--mono);font-size:12.5px;line-height:1.65;overflow-x:auto;margin:0;
      white-space:pre-wrap;word-break:break-word}

  /* ---------------------------------------------------- command centre */

  /* Every figure on this tab carries what kind of thing it is. A measured
     follower count and a projected one in the same typeface is a lie told by
     layout, so the kind is part of the component rather than a footnote. */
  .kind{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;
        color:var(--faint);border:1px solid var(--rule);border-radius:2px;
        padding:1px 5px;margin-left:7px;vertical-align:2px;white-space:nowrap}
  .kind.est{color:var(--warn);border-color:var(--warn)}
  .kind.calc{color:var(--accent);border-color:var(--accent)}

  .headline{background:var(--raised);border:1px solid var(--rule);border-radius:4px;
            padding:20px 22px;margin-bottom:22px}
  .headline .q{font-family:var(--display);font-size:clamp(20px,3vw,26px);line-height:1.3;
               margin:0 0 6px}
  .headline .a{color:var(--muted);font-size:14.5px;margin:0}

  .delta{font-size:13px;font-weight:600;white-space:nowrap}
  .delta.up{color:var(--good)} .delta.down{color:var(--bad)} .delta.flat{color:var(--faint)}

  .nodata{color:var(--faint);font-style:italic}

  .plat{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
  .plat .card{margin:0}
  .plat .name{font-family:var(--display);font-size:18px}
  .plat .big{font-family:var(--display);font-size:30px;line-height:1.1;margin:8px 0 2px}
  .plat .rows{margin-top:10px;padding-top:10px;border-top:1px solid var(--rule);font-size:13.5px}
  .plat .rows div{display:flex;justify-content:space-between;gap:10px;padding:2px 0}
  .plat .rows span:last-child{font-variant-numeric:tabular-nums}

  .bar{height:6px;background:var(--sunk);border-radius:3px;overflow:hidden;margin-top:8px}
  .bar i{display:block;height:100%;background:var(--accent)}

  .spark{display:block;width:100%;height:64px}

  /* ----------------------------------------------------------- composer */
  .compose{display:grid;grid-template-columns:300px 1fr;gap:20px;align-items:start;
           background:var(--raised);border:1px solid var(--rule);border-radius:4px;
           padding:16px;margin-bottom:16px}
  .preview{position:relative;width:280px;height:280px;flex:none;
           border:1px solid var(--rule);border-radius:3px;overflow:hidden;background:var(--sunk)}
  .preview iframe{position:absolute;top:0;left:0;width:1080px;height:1080px;border:0;
                  transform:scale(0.2592);transform-origin:top left}
  .fields > * + *{margin-top:12px}
  .count{font-size:12px;color:var(--faint);margin-top:4px}
  .count.over{color:var(--bad)}
  @media (max-width:760px){
    .compose{grid-template-columns:1fr}
    .preview{width:100%;aspect-ratio:1;height:auto}
  }

  /* ---------------------------------------------------------- gate/toast */
  .gate{max-width:420px;margin:16vh auto;padding:26px;background:var(--raised);
        border:1px solid var(--rule);border-radius:5px}
  .gate h1{margin-bottom:6px}
  .gate p{color:var(--muted);font-size:14.5px}
  #toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:50;
         background:var(--ink);color:var(--ground);padding:10px 16px;border-radius:4px;
         font-size:14.5px;max-width:90vw;box-shadow:0 6px 20px rgba(0,0,0,.18);display:none}
  #toast.bad{background:var(--bad);color:#fff}
  .busy{opacity:.5;pointer-events:none}
  .hidden{display:none !important}
</style>
</head>
<body>

<div id="gate" class="gate hidden">
  <h1>The Daily Pause</h1>
  <p>This is the service desk. It needs the service token — the same one the morning task uses.</p>
  <div style="margin-top:16px">
    <label for="tok">Service token</label>
    <input id="tok" type="password" autocomplete="off" spellcheck="false">
  </div>
  <div class="row" style="margin-top:14px">
    <button class="primary" id="gatego">Open</button>
    <span class="quiet" id="gatemsg"></span>
  </div>
</div>

<div id="app" class="wrap hidden">
  <header>
    <h1>The Daily Pause</h1>
    <span class="sub" id="clock"></span>
    <span class="spacer"></span>
    <button class="small" id="refresh">Refresh</button>
    <button class="small" id="signout">Sign out</button>
  </header>

  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="today" aria-selected="true">Today</button>
    <button role="tab" data-tab="command" aria-selected="false">Command centre</button>
    <button role="tab" data-tab="compose" aria-selected="false">Write a day</button>
    <button role="tab" data-tab="stats" aria-selected="false">Stats</button>
    <button role="tab" data-tab="log" aria-selected="false">Service</button>
  </nav>

  <div id="health"></div>
  <div id="panel-today" class="panel"></div>
  <div id="panel-command" class="panel hidden"></div>
  <div id="panel-compose" class="panel hidden"></div>
  <div id="panel-stats" class="panel hidden"></div>
  <div id="panel-log" class="panel hidden"></div>
</div>

<div id="toast"></div>

<script>
/* =========================================================== card design ==
   This mirrors daily_pause_card.py exactly — palette, type scale, spacing and
   the smart-quote pass. The morning task renders with headless Chromium and
   the composer renders in this browser; if the two drift the cards drift, so
   any change here has to be made there too.
========================================================================== */
var FONT_B64 = '__FONT__';

var SLOTS = {
  '0800': { label: 'The Daily Question',    mode: 'day' },
  '1300': { label: 'The Middle of the Day', mode: 'day' },
  '2100': { label: 'The Quiet Hour',        mode: 'night' }
};
var SLOT_ORDER = ['0800', '1300', '2100'];
var SLOT_TIME  = { '0800': '08:00', '1300': '13:00', '2100': '21:00' };

var PALETTE = {
  day:   { ground: '#F3EEE6', text: '#2E2A26', frame: '#DED5C7' },
  night: { ground: '#23262B', text: '#EDE7DC', frame: '#3A3E45' }
};
var ACCENT = '#8A7B66';

var TYPE_SCALE = [
  [42, 96, 1.22], [70, 84, 1.24], [100, 72, 1.26],
  [140, 62, 1.30], [190, 54, 1.34], [999, 46, 1.38]
];

function typeFor(text) {
  var n = text.length;
  for (var i = 0; i < TYPE_SCALE.length; i++) {
    if (n <= TYPE_SCALE[i][0]) return { size: TYPE_SCALE[i][1], lh: TYPE_SCALE[i][2] };
  }
  return { size: 46, lh: 1.38 };
}

function smarten(t) {
  t = t.replace(/\\.\\.\\./g, '…');
  t = t.replace(/(^|[\\s(\\[—–])"/g, '$1“').replace(/"/g, '”');
  t = t.replace(/(^|[\\s(\\[])'/g, '$1‘').replace(/'/g, '’');
  t = t.replace(/\\s+-\\s+/g, ' — ');
  t = t.replace(/--/g, '—');
  return t;
}

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The card as two pieces: a style block and a body. Kept apart because the
 * composer's preview wants a whole HTML document while the exporter needs an
 * XML-clean fragment to put inside an SVG — a stray <meta> in there is enough
 * to make the browser refuse to draw it, silently.
 */
function cardStyle(slot, text) {
  var spec = SLOTS[slot] || SLOTS['0800'];
  var pal = PALETTE[spec.mode];
  var t = typeFor(smarten(String(text || '').trim()));

  return '<style>' +
    '@font-face{font-family:"Pagella";font-style:normal;font-weight:400;font-display:block;' +
      'src:url(data:font/woff2;base64,' + FONT_B64 + ') format("woff2")}' +
    '.dp-card *{margin:0;padding:0;box-sizing:border-box}' +
    '.dp-card{width:1080px;height:1080px;position:relative;overflow:hidden;' +
      'background:' + pal.ground + ';color:' + pal.text + ';' +
      'font-family:"Pagella","TeX Gyre Pagella",Georgia,serif;' +
      '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}' +
    '.dp-card .frame{position:absolute;inset:56px;border:1px solid ' + pal.frame + '}' +
    '.dp-card .stage{position:absolute;inset:0;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;padding:150px 140px}' +
    '.dp-card .label{font-size:19px;letter-spacing:.30em;text-transform:uppercase;opacity:.48;' +
      'margin-bottom:56px;text-indent:.30em}' +
    '.dp-card .line{font-size:' + t.size + 'px;line-height:' + t.lh + ';text-align:center;' +
      'max-width:800px;text-wrap:balance}' +
    '.dp-card .rule{width:64px;height:1px;background:' + ACCENT + ';margin-top:56px}' +
    '.dp-card .ref{font-size:20px;letter-spacing:.20em;text-transform:uppercase;opacity:.55;' +
      'margin-top:34px;text-indent:.20em}' +
    '.dp-card .wordmark{position:absolute;left:104px;bottom:92px;font-size:18px;' +
      'letter-spacing:.34em;text-transform:uppercase;opacity:.42;text-indent:.34em}' +
    '</style>';
}

function cardBody(slot, text, reference) {
  var spec = SLOTS[slot] || SLOTS['0800'];
  var body = smarten(String(text || '').trim());
  var ref = reference ? smarten(String(reference).trim()) : '';

  return '<div class="dp-card">' +
    '<div class="frame"></div>' +
    '<div class="stage">' +
      '<div class="label">' + esc(spec.label) + '</div>' +
      '<div class="line">' + esc(body).replace(/\\n/g, '<br/>') + '</div>' +
      '<div class="rule"></div>' +
      (ref ? '<div class="ref">' + esc(ref) + '</div>' : '') +
    '</div>' +
    '<div class="wordmark">The Daily Pause</div>' +
  '</div>';
}

/** A whole document, for the preview iframe. */
function cardDoc(slot, text, reference) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;width:1080px;height:1080px;overflow:hidden}</style>' +
    cardStyle(slot, text) + '</head><body>' + cardBody(slot, text, reference) +
    '</body></html>';
}

/**
 * Rasterise a card to a JPEG data URL at 2160x2160, the same as the morning
 * task's device_scale_factor of 2. Everything the SVG needs is inline, so the
 * canvas is never tainted and toDataURL works.
 */
function renderCardJpeg(slot, text, reference) {
  return new Promise(function (resolve, reject) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">' +
      '<foreignObject x="0" y="0" width="1080" height="1080">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' +
      cardStyle(slot, text) + cardBody(slot, text, reference) +
      '</div></foreignObject></svg>';

    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = 2160; c.height = 2160;
      var ctx = c.getContext('2d');
      ctx.fillStyle = PALETTE[(SLOTS[slot] || SLOTS['0800']).mode].ground;
      ctx.fillRect(0, 0, 2160, 2160);
      ctx.drawImage(img, 0, 0, 2160, 2160);
      try { resolve(c.toDataURL('image/jpeg', 0.92)); }
      catch (e) { reject(new Error('The browser would not export the card: ' + e.message)); }
    };
    img.onerror = function () { reject(new Error('The card would not draw')); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/* ================================================================ plumbing */

var TOKEN_KEY = 'dp.service.token';
var state = { token: '', status: null, day: null, date: null, stats: null, tab: 'today',
              composeDate: null, composeDraft: null };

function $(id) { return document.getElementById(id); }
function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }

function toast(msg, bad) {
  var t = $('toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(function () { t.style.display = 'none'; }, bad ? 6500 : 3200);
}

function api(path, opts) {
  opts = opts || {};
  var init = { method: opts.method || 'GET', headers: { authorization: 'Bearer ' + state.token } };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return fetch(path, init).then(function (r) {
    return r.text().then(function (txt) {
      var json = null;
      try { json = txt ? JSON.parse(txt) : null; } catch (e) { /* not json */ }
      if (!r.ok) {
        var msg = (json && json.error) || txt.slice(0, 200) || ('HTTP ' + r.status);
        var err = new Error(msg); err.status = r.status; err.body = json;
        throw err;
      }
      return json;
    });
  });
}

function fmtTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit',
    day: '2-digit', month: 'short' });
}
function fmtDate(ymd) {
  if (!ymd) return '';
  var d = new Date(ymd + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
function num(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('en-GB');
}
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(ymdStr, n) {
  var d = new Date(ymdStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}

var CHIP_TONE = {
  scheduled: 'good', published: 'good', queued: '', pending: '',
  held: 'warn', cancelled: 'warn', too_late: 'bad', failed: 'bad',
  failed_to_publish: 'bad', failed_final: 'bad', missed: 'bad', publishing: ''
};
function chip(label, status) {
  var tone = CHIP_TONE[status] !== undefined ? CHIP_TONE[status] : '';
  return '<span class="chip ' + tone + '">' + esc(label) + ' · ' +
         esc(String(status || 'none').replace(/_/g, ' ')) + '</span>';
}

/* =================================================================== gate */

function openGate(msg) {
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('gatemsg').textContent = msg || '';
  $('tok').focus();
}

function tryToken(tok) {
  state.token = tok;
  return api('/api/status').then(function (s) {
    localStorage.setItem(TOKEN_KEY, tok);
    state.status = s;
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    return s;
  });
}

/* ================================================================ loading */

function loadStatus() {
  return api('/api/status').then(function (s) { state.status = s; return s; });
}

function loadDay(date) {
  state.date = date;
  return api('/api/days/' + date).then(function (d) { state.day = d; return d; })
    .catch(function (e) {
      if (e.status === 404) { state.day = null; return null; }
      throw e;
    });
}

function loadStats(refresh) {
  return api('/api/insights?days=30' + (refresh ? '&refresh=1' : ''))
    .then(function (s) { state.stats = s; return s; });
}

/* ================================================================== views */

/** A one-line verdict on the day in view: what went out, what did not. */
function dayTally() {
  if (!state.day) return null;
  var out = { live: 0, waiting: 0, held: 0, broken: [] };
  state.day.posts.forEach(function (p) {
    var fb = p.facebook || {};
    if (p.hold) { out.held++; return; }
    if (fb.status === 'published') out.live++;
    else if (['failed', 'failed_to_publish', 'too_late', 'missed'].indexOf(fb.status) !== -1) {
      out.broken.push(p.slot);
    } else out.waiting++;
    var ig = p.instagram;
    if (ig && ['failed', 'failed_final', 'missed'].indexOf(ig.status) !== -1) {
      out.broken.push(p.slot + ' (Instagram)');
    }
  });
  return out;
}

function renderHealth() {
  var s = state.status;
  if (!s) { $('health').innerHTML = ''; return; }
  var problems = (s.problems || []).slice();
  var t = dayTally();
  if (t && t.broken.length) {
    problems.unshift('Did not go out: ' + t.broken.join(', ') +
      ' — open it below and put it up now, or let it go');
  }
  var cls = problems.length ? 'bad' : 'ok';
  var html = '<div class="banner ' + cls + '">';
  if (problems.length) {
    html += '<strong>' + problems.length + ' thing' + (problems.length > 1 ? 's need' : ' needs') +
            ' attention</strong><ul>';
    for (var i = 0; i < problems.length; i++) html += '<li>' + esc(problems[i]) + '</li>';
    html += '</ul>';
  } else {
    html += '<strong>Everything is in order.</strong>' +
            '<span class="quiet">' +
            (t ? t.live + ' of ' + (t.live + t.waiting + t.held + t.broken.length) +
                 ' out' + (t.held ? ', ' + t.held + ' held' : '') + ' · ' : '') +
            'Scheduling to ' + esc(s.timezone) +
            (s.dryRun ? ' · dry run, nothing reaches Meta' : '') +
            ' · Instagram trails Facebook by ' + s.igDelayMinutes + ' min</span>';
  }
  html += '</div>';
  $('health').innerHTML = html;
  $('clock').textContent = 'today is ' + fmtDate(s.today);
}

/* ------------------------------------------------------------ today view */

function postCard(post, date) {
  var fb = post.facebook || {};
  var ig = post.instagram;
  var cls = post.hold ? 'card held'
          : (fb.status === 'published' || (ig && ig.status === 'published')) ? 'card gone' : 'card';

  var chips = chip('Facebook', fb.status);
  chips += ig ? chip('Instagram', ig.status) : '<span class="chip">Instagram · off</span>';
  if (post.hold) chips += '<span class="chip warn">held</span>';

  var links = [];
  if (ig && ig.permalink) links.push('<a href="' + esc(ig.permalink) + '" target="_blank" rel="noopener">see it on Instagram</a>');
  if (fb.postId) links.push('<a href="https://www.facebook.com/' + esc(fb.postId) +
                            '" target="_blank" rel="noopener">see it on Facebook</a>');

  var errs = [];
  if (fb.error) errs.push('Facebook: ' + fb.error);
  if (ig && ig.error) errs.push('Instagram: ' + ig.error);

  var canEdit = fb.status !== 'published' && !(ig && ig.status === 'published');
  var fbBroken = ['failed', 'failed_to_publish', 'too_late', 'missed'].indexOf(fb.status) !== -1;
  if (fb.status === 'failed_to_publish') {
    errs.unshift('Meta did not publish this at its slot. Put it up now, or let it go.');
  }

  return '<div class="' + cls + '" data-slot="' + post.slot + '">' +
    '<div class="slotline">' +
      '<img src="/cards/' + esc(date) + '-' + esc(post.slot) + '.jpg" alt="" loading="lazy">' +
      '<div class="meta">' +
        '<div class="title">' + esc((SLOTS[post.slot] || {}).label || post.slot) + '</div>' +
        '<div class="due">' + esc(SLOT_TIME[post.slot] || '') + ' on Facebook' +
          (ig ? ' · ' + fmtTime(ig.dueAt) + ' on Instagram' : '') +
          (post.topic ? ' · ' + esc(post.topic) : '') + '</div>' +
        '<div class="chips">' + chips + '</div>' +
        (links.length ? '<div class="quiet" style="margin-top:8px">' + links.join(' · ') + '</div>' : '') +
        (errs.length ? '<div class="quiet" style="margin-top:8px;color:var(--bad)">' +
                        esc(errs.join(' · ')) + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<label for="cap-' + post.slot + '">Caption</label>' +
    '<textarea id="cap-' + post.slot + '" rows="3" ' + (canEdit ? '' : 'disabled') + '>' +
      esc(post.caption) + '</textarea>' +
    '<div class="actions">' +
      (canEdit ? '<button class="small" data-act="caption" data-slot="' + post.slot + '">Save caption</button>' : '') +
      (canEdit ? '<button class="small" data-act="' + (post.hold ? 'release' : 'hold') + '" data-slot="' +
                 post.slot + '">' + (post.hold ? 'Release' : 'Hold') + '</button>' : '') +
      (ig && ig.status !== 'published' && ig.status !== 'cancelled'
        ? '<button class="small" data-act="publish-now" data-slot="' + post.slot +
          '">Put on Instagram now</button>' : '') +
      (ig && ig.status !== 'published'
        ? '<button class="small danger" data-act="cancel" data-slot="' + post.slot +
          '">Cancel Instagram</button>' : '') +
      (fbBroken
        ? '<button class="small primary" data-act="facebook-now" data-slot="' + post.slot +
          '">Put on Facebook now</button>' : '') +
      (canEdit && (fb.status === 'failed' || fb.status === 'pending' || fb.status === 'too_late')
        ? '<button class="small" data-act="reschedule" data-slot="' + post.slot +
          '">Reschedule Facebook</button>' : '') +
      (fb.postId && fb.status === 'scheduled'
        ? '<button class="small" data-act="verify" data-slot="' + post.slot +
          '">Check with Meta</button>' : '') +
    '</div>' +
  '</div>';
}

function renderToday() {
  var p = $('panel-today');
  var date = state.date;
  var nav = '<section><div class="sechead">' +
    '<h2>' + esc(fmtDate(date)) + '</h2>' +
    '<span class="row">' +
      '<button class="small" data-nav="-1">← previous</button>' +
      '<input type="date" id="daypick" value="' + esc(date) + '" style="width:auto">' +
      '<button class="small" data-nav="1">next →</button>' +
    '</span></div>';

  if (!state.day) {
    nav += '<div class="banner warn"><strong>Nothing written for this day.</strong>' +
      '<span class="quiet">The morning task writes each day around 06:00. ' +
      'You can write it yourself on the <em>Write a day</em> tab.</span></div>';
  } else {
    var posts = state.day.posts.slice().sort(function (a, b) { return a.slot < b.slot ? -1 : 1; });
    for (var i = 0; i < posts.length; i++) nav += postCard(posts[i], date);
    nav += '<p class="quiet">Last changed ' + fmtTime(state.day.updatedAt) + '.</p>';
  }
  nav += '</section>';
  p.innerHTML = nav;

  $('daypick').addEventListener('change', function () { goDay(this.value); });
  p.querySelectorAll('[data-nav]').forEach(function (b) {
    b.addEventListener('click', function () { goDay(addDays(state.date, Number(b.dataset.nav))); });
  });
  p.querySelectorAll('[data-act]').forEach(function (b) {
    b.addEventListener('click', function () { doAction(b.dataset.act, b.dataset.slot, b); });
  });
}

function goDay(date) {
  loadDay(date).then(renderToday).catch(function (e) { toast(e.message, true); });
}

function doAction(act, slot, btn) {
  var date = state.date;
  var body;
  if (act === 'caption') {
    body = { caption: $('cap-' + slot).value };
  }
  if (act === 'cancel' && !confirm('Cancel the Instagram post for ' + slot + '?')) return;
  if (act === 'publish-now' && !confirm('Put the ' + slot + ' card on Instagram now? ' +
      'Instagram posts cannot be unsent.')) return;
  if (act === 'facebook-now' && !confirm('Put the ' + slot + ' card on Facebook now, ' +
      'rather than at its slot?')) return;

  btn.disabled = true;
  var panel = $('panel-today'); panel.classList.add('busy');
  api('/api/days/' + date + '/' + slot + '/' + act, { method: 'POST', body: body })
    .then(function (r) {
      toast(act === 'caption' ? 'Caption saved · ' + (r.facebook || '')
           : act === 'publish-now' ? 'On Instagram.'
           : act === 'facebook-now' ? 'On Facebook.'
           : act === 'verify' ? (r.state && r.state.published ? 'Meta confirms it is live.'
               : r.state && r.state.scheduled ? 'Meta still has it queued.'
               : 'Meta has not published it.')
           : 'Done.');
      if (r && r.warnings && r.warnings.length) toast(r.warnings.join(' · '), true);
      return loadDay(date);
    })
    .then(renderToday)
    .catch(function (e) { toast(e.message, true); btn.disabled = false; })
    .then(function () { panel.classList.remove('busy'); });
}

/* --------------------------------------------------------- composer view */

function blankDraft() {
  return {
    '0800': { text: '', reference: '', caption: '', instagram: true, hold: false },
    '1300': { text: '', reference: '', caption: '', instagram: true, hold: false },
    '2100': { text: '', reference: '', caption: '', instagram: true, hold: false }
  };
}

function renderCompose() {
  var p = $('panel-compose');
  if (!state.composeDate) state.composeDate = addDays(state.status.today, 1);
  if (!state.composeDraft) state.composeDraft = blankDraft();

  var html = '<section><div class="sechead">' +
    '<h2>Write a day</h2>' +
    '<span class="row">' +
      '<input type="date" id="cdate" value="' + esc(state.composeDate) + '" style="width:auto">' +
      '<button class="small" id="cload">Load what is there</button>' +
      '<button class="small" id="cclear">Clear</button>' +
    '</span></div>' +
    '<p class="quiet">Three cards, one day. The words on the card are the big type; ' +
    'the caption is what sits underneath the picture on Facebook and Instagram. ' +
    'The preview is the real thing at a quarter size.</p>' +
    '<div id="cwarn"></div>';

  for (var i = 0; i < SLOT_ORDER.length; i++) {
    var slot = SLOT_ORDER[i];
    var d = state.composeDraft[slot];
    html += '<div class="compose" data-slot="' + slot + '">' +
      '<div>' +
        '<h3>' + esc(SLOTS[slot].label) + ' · ' + SLOT_TIME[slot] + '</h3>' +
        '<div class="preview" style="margin-top:10px"><iframe id="pv-' + slot +
          '" sandbox="allow-same-origin" title="preview"></iframe></div>' +
      '</div>' +
      '<div class="fields">' +
        '<div><label for="t-' + slot + '">Words on the card</label>' +
          '<textarea id="t-' + slot + '" rows="3" data-f="text" data-slot="' + slot + '">' +
          esc(d.text) + '</textarea>' +
          '<div class="count" id="cnt-' + slot + '"></div></div>' +
        '<div><label for="r-' + slot + '">Reference (optional)</label>' +
          '<input id="r-' + slot + '" data-f="reference" data-slot="' + slot +
          '" value="' + esc(d.reference) + '" placeholder="Psalm 34:18"></div>' +
        '<div><label for="c-' + slot + '">Caption</label>' +
          '<textarea id="c-' + slot + '" rows="4" data-f="caption" data-slot="' + slot + '">' +
          esc(d.caption) + '</textarea></div>' +
        '<div class="row">' +
          '<label class="check"><input type="checkbox" data-f="instagram" data-slot="' + slot +
            '"' + (d.instagram ? ' checked' : '') + '> Instagram too</label>' +
          '<label class="check"><input type="checkbox" data-f="hold" data-slot="' + slot +
            '"' + (d.hold ? ' checked' : '') + '> Hold this one back</label>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  html += '<div class="row" style="margin-top:18px">' +
    '<button class="primary" id="csend">Send the day to the queue</button>' +
    '<span class="quiet" id="cstate"></span></div>' +
    '<p class="quiet">Facebook is scheduled with Meta straight away, so you can still ' +
    'change or delete it in Business Suite. Instagram is held here and published at its slot.</p>' +
    '</section>';

  p.innerHTML = html;

  $('cdate').addEventListener('change', function () { state.composeDate = this.value; checkCompose(); });
  $('cload').addEventListener('click', composeLoad);
  $('cclear').addEventListener('click', function () {
    state.composeDraft = blankDraft(); renderCompose();
  });
  $('csend').addEventListener('click', composeSend);

  p.querySelectorAll('[data-f]').forEach(function (el) {
    var ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, function () {
      var d = state.composeDraft[el.dataset.slot];
      d[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.f === 'text' || el.dataset.f === 'reference') refreshPreview(el.dataset.slot);
    });
  });

  for (var j = 0; j < SLOT_ORDER.length; j++) refreshPreview(SLOT_ORDER[j]);
  checkCompose();
}

function refreshPreview(slot) {
  var d = state.composeDraft[slot];
  var frame = $('pv-' + slot);
  if (frame) frame.srcdoc = cardDoc(slot, d.text || ' ', d.reference);
  var cnt = $('cnt-' + slot);
  if (cnt) {
    var n = (d.text || '').length;
    cnt.textContent = n + ' characters · ' + typeFor(d.text || '').size + 'px type';
    cnt.className = n > 190 ? 'count over' : 'count';
  }
}

function checkCompose() {
  var date = state.composeDate;
  var box = $('cwarn');
  if (!box) return;
  // Ask which days exist before asking for one. Probing a date that is not
  // there works, but it puts a red 404 in the console for something that is
  // the ordinary case.
  api('/api/days').then(function (list) {
    if ((list.days || []).indexOf(date) === -1) { box.innerHTML = ''; return null; }
    return api('/api/days/' + date);
  }).then(function (day) {
    if (!day) return;
    var live = day.posts.filter(function (p) {
      return (p.facebook && p.facebook.status === 'scheduled') ||
             (p.instagram && p.instagram.status === 'published');
    });
    box.innerHTML = '<div class="banner ' + (live.length ? 'warn' : '') + '"><strong>' +
      esc(fmtDate(date)) + ' already has a day written.</strong><span class="quiet">' +
      (live.length
        ? 'Sending again will cancel the scheduled Facebook posts and replace them. ' +
          'Anything already on Instagram cannot be unsent.'
        : 'Nothing has gone out yet, so sending again simply replaces it.') +
      '</span></div>';
  }).catch(function () { box.innerHTML = ''; });
}

function composeLoad() {
  api('/api/days/' + state.composeDate).then(function (day) {
    var draft = blankDraft();
    day.posts.forEach(function (p) {
      if (!draft[p.slot]) return;
      draft[p.slot] = {
        text: p.cardText || '',
        reference: p.cardReference || '',
        caption: p.caption || '',
        instagram: !!p.instagram,
        hold: !!p.hold
      };
    });
    state.composeDraft = draft;
    renderCompose();
    var missing = day.posts.some(function (p) { return !p.cardText; });
    toast(missing ? 'Loaded. The card wording was not kept for that day, so those boxes are empty.'
                  : 'Loaded.');
  }).catch(function (e) {
    toast(e.status === 404 ? 'Nothing written for that day yet.' : e.message, e.status !== 404);
  });
}

function composeSend() {
  var date = state.composeDate;
  var draft = state.composeDraft;
  var slots = SLOT_ORDER.filter(function (s) { return (draft[s].text || '').trim(); });

  if (!slots.length) { toast('Nothing to send — the cards are empty.', true); return; }
  var noCaption = slots.filter(function (s) { return !(draft[s].caption || '').trim(); });
  if (noCaption.length) {
    toast('These still need a caption: ' + noCaption.join(', '), true); return;
  }
  if (!confirm('Send ' + slots.length + ' post' + (slots.length > 1 ? 's' : '') +
               ' for ' + fmtDate(date) + '?')) return;

  var btn = $('csend'); btn.disabled = true;
  $('cstate').textContent = 'drawing the cards…';

  Promise.all(slots.map(function (s) {
    return renderCardJpeg(s, draft[s].text, draft[s].reference).then(function (dataUrl) {
      return {
        slot: s,
        text: draft[s].text,
        reference: draft[s].reference || null,
        caption: draft[s].caption,
        hold: draft[s].hold,
        instagram: draft[s].instagram,
        imageBase64: dataUrl
      };
    });
  })).then(function (posts) {
    $('cstate').textContent = 'sending…';
    return api('/api/days', { method: 'POST', body: { date: date, posts: posts, replace: true } });
  }).then(function (r) {
    $('cstate').textContent = '';
    btn.disabled = false;
    var warn = (r.warnings || []);
    toast(warn.length ? 'Sent, with notes: ' + warn.join(' · ') : 'Sent. Facebook is scheduled.',
          warn.length > 0);
    state.date = date;
    return refreshAll().then(function () { showTab('today'); });
  }).catch(function (e) {
    $('cstate').textContent = '';
    btn.disabled = false;
    toast(e.message, true);
  });
}

/* ------------------------------------------------------------ stats view */

function sparkline(series, colour, w, hgt) {
  if (!series || series.length < 2) return '';
  var max = 0;
  for (var i = 0; i < series.length; i++) max = Math.max(max, series[i].value || 0);
  if (!max) return '';
  var step = w / (series.length - 1);
  var pts = series.map(function (d, i) {
    return (i * step).toFixed(1) + ',' + (hgt - (d.value / max) * (hgt - 4) - 2).toFixed(1);
  }).join(' ');
  return '<polyline fill="none" stroke="' + colour + '" stroke-width="2" ' +
         'stroke-linejoin="round" stroke-linecap="round" points="' + pts + '"/>';
}

function trendChart(trend) {
  var fb = trend.facebook, ig = trend.instagram;
  if ((!fb || !fb.length) && (!ig || !ig.length)) return '';
  var w = 900, hgt = 150;
  var max = 0;
  [fb, ig].forEach(function (s) {
    (s || []).forEach(function (d) { max = Math.max(max, d.value || 0); });
  });
  if (!max) return '';
  var labels = (fb && fb.length ? fb : ig) || [];
  var first = labels[0] ? labels[0].date : '';
  var last = labels[labels.length - 1] ? labels[labels.length - 1].date : '';

  return '<div class="card"><h3>People reached each day</h3>' +
    '<svg viewBox="0 0 ' + w + ' ' + (hgt + 6) + '" width="100%" height="170" ' +
      'preserveAspectRatio="none" role="img" aria-label="Daily reach over the last 30 days">' +
      '<line x1="0" y1="' + hgt + '" x2="' + w + '" y2="' + hgt +
        '" stroke="currentColor" opacity=".18"/>' +
      sparkline(fb, '#8A7B66', w, hgt) +
      sparkline(ig, '#3F7A50', w, hgt) +
    '</svg>' +
    '<div class="row quiet" style="justify-content:space-between">' +
      '<span>' + esc(first) + '</span>' +
      '<span><span style="color:#8A7B66">▬</span> Facebook &nbsp; ' +
        '<span style="color:#3F7A50">▬</span> Instagram &nbsp; peak ' + num(max) + '</span>' +
      '<span>' + esc(last) + '</span>' +
    '</div></div>';
}

function renderStats() {
  var p = $('panel-stats');
  var s = state.stats;
  if (!s) { p.innerHTML = '<p class="quiet">Loading…</p>'; return; }

  var html = '<section><div class="sechead"><h2>Stats</h2>' +
    '<span class="row"><span class="when">' +
      (s.cachedAt ? 'as at ' + fmtTime(s.cachedAt) : '') +
      (s.stale ? ' · could not refresh: ' + esc(s.refreshError || '') : '') +
    '</span><button class="small" id="statsref">Refresh now</button></span></div>';

  if (s.dryRun) {
    html += '<div class="banner warn"><strong>Dry run.</strong><span class="quiet">' +
      'No figures, because nothing is reaching Meta.</span></div>';
  }

  var missing = (s.scopes && s.scopes.missing) || [];
  if (missing.length) {
    html += '<div class="banner warn"><strong>Reach and saves are not available.</strong>' +
      '<span class="quiet">The Page token does not carry ' + esc(missing.join(' or ')) +
      '. Likes, comments, shares and follower counts below are unaffected. ' +
      'To add them, regenerate the token in Graph Explorer with those permissions ticked ' +
      'and set FB_PAGE_TOKEN in Railway again.</span></div>';
  }

  var a = s.audience || {};
  html += '<div class="grid">' +
    '<div class="tile"><div class="k">Facebook followers</div><div class="v">' +
      num(a.facebook && a.facebook.followers) + '</div>' +
      '<div class="n">' + esc((a.facebook && a.facebook.name) || '') + '</div></div>' +
    '<div class="tile"><div class="k">Instagram followers</div><div class="v">' +
      num(a.instagram && a.instagram.followers) + '</div>' +
      '<div class="n">' + esc(a.instagram && a.instagram.username ?
        '@' + a.instagram.username : '') + '</div></div>' +
    '<div class="tile"><div class="k">Posts on Instagram</div><div class="v">' +
      num(a.instagram && a.instagram.posts) + '</div><div class="n">all time</div></div>' +
    '</div>';

  html += trendChart(s.trend || {});

  var rows = (s.posts || []).filter(function (r) {
    return r.facebookPostId || r.instagramMediaId;
  });
  if (!rows.length) {
    html += '<p class="quiet">No posts have gone out yet, so there is nothing to count.</p>';
  } else {
    html += '<div class="scroll"><table><thead><tr>' +
      '<th>Day</th><th>Slot</th><th>Card</th>' +
      '<th class="num">FB reach</th><th class="num">FB likes</th><th class="num">FB comments</th>' +
      '<th class="num">FB shares</th>' +
      '<th class="num">IG reach</th><th class="num">IG likes</th><th class="num">IG comments</th>' +
      '<th class="num">IG saves</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var f = r.facebook || {}, g = r.instagram || {};
      var words = (r.caption || '').split('\\n')[0];
      if (words.length > 46) words = words.slice(0, 46) + '…';
      html += '<tr>' +
        '<td>' + esc(r.date) + '</td>' +
        '<td>' + esc(SLOT_TIME[r.slot] || r.slot) + '</td>' +
        '<td class="dim">' + esc(words) + '</td>' +
        '<td class="num">' + num(f.reach) + '</td><td class="num">' + num(f.likes) + '</td>' +
        '<td class="num">' + num(f.comments) + '</td><td class="num">' + num(f.shares) + '</td>' +
        '<td class="num">' + num(g.reach) + '</td><td class="num">' + num(g.likes) + '</td>' +
        '<td class="num">' + num(g.comments) + '</td><td class="num">' + num(g.saves) + '</td>' +
      '</tr>';
    }
    html += '</tbody></table></div>';
    html += '<p class="quiet" style="margin-top:10px">Figures come from Meta and lag the post ' +
      'by an hour or two. A dash means Meta had nothing to give for that one.</p>';
  }

  html += '</section>';
  p.innerHTML = html;
  $('statsref').addEventListener('click', function () {
    this.disabled = true;
    p.classList.add('busy');
    loadStats(true).then(renderStats).catch(function (e) { toast(e.message, true); })
      .then(function () { p.classList.remove('busy'); });
  });
}

/* -------------------------------------------------------------- log view */

function renderLog() {
  var s = state.status || {};
  var t = s.token || {};
  var html = '<section><h2 style="margin-bottom:12px">Service</h2><div class="grid">' +
    '<div class="tile"><div class="k">Page token</div><div class="v ' +
      (t.neverExpires ? 'good' : t.error ? 'bad' : 'warn') + '">' +
      (t.error ? 'error' : t.neverExpires ? 'permanent' : t.type ? String(t.type).toLowerCase() : 'unknown') +
      '</div><div class="n">' + esc(t.error || (t.pageMatches ? 'matches the page' : 'page not confirmed')) +
      '</div></div>' +
    '<div class="tile"><div class="k">Data access expires</div><div class="v">' +
      (t.dataAccessExpiresAt ? esc(String(t.dataAccessExpiresAt).slice(0, 10)) : 'unknown') +
      '</div><div class="n">Meta’s 90-day clock, separate from the token</div></div>' +
    '<div class="tile"><div class="k">Instagram</div><div class="v ' +
      (s.instagram && s.instagram.matches ? 'good' : 'warn') + '">' +
      (s.instagram && s.instagram.matches ? 'linked' : 'check') + '</div>' +
      '<div class="n mono">' + esc((s.instagram && s.instagram.linkedAccountId) || '—') +
      '</div></div>' +
    '<div class="tile"><div class="k">Days on record</div><div class="v">' +
      ((s.days || []).length) + '</div><div class="n">' +
      esc((s.days || []).slice(-3).join(', ')) + '</div></div>' +
    '<div class="tile"><div class="k">Messages</div><div class="v ' +
      (s.messaging && s.messaging.configured ? 'good' : 'warn') + '">' +
      (s.messaging && s.messaging.configured ? 'on' : 'off') + '</div>' +
      '<div class="n">' + (s.messaging && s.messaging.configured
        ? 'BeepMate · ' + esc(s.messaging.to || '') +
          (s.messaging.onSuccess ? ' · every post and every failure'
                                 : ' · failures only')
        : 'BEEPMATE_KEY and BEEPMATE_ID are not set') + '</div></div>' +
    '</div>';

  if (s.messaging && s.messaging.configured) {
    html += '<div class="row" style="margin-bottom:18px">' +
      '<button class="small" id="msgtest">Send me a test message</button>' +
      '<span class="quiet" id="msgstate"></span></div>';
  }

  var log = s.recent || [];
  html += '<h3 style="margin-bottom:8px">Scheduler</h3>';
  html += log.length
    ? '<pre class="log">' + esc(log.map(function (l) {
        return (l.at || '') + '  ' + (l.message || JSON.stringify(l));
      }).join('\\n')) + '</pre>'
    : '<p class="quiet">The scheduler has not had anything to say since the last restart.</p>';
  html += '</section>';
  $('panel-log').innerHTML = html;

  var tb = $('msgtest');
  if (tb) tb.addEventListener('click', function () {
    tb.disabled = true;
    $('msgstate').textContent = 'sending…';
    api('/api/notify/test', { method: 'POST' }).then(function () {
      $('msgstate').textContent = 'Sent — check your phone.';
    }).catch(function (e) {
      $('msgstate').textContent = e.message;
    }).then(function () { tb.disabled = false; });
  });
}


/* ========================================================= command centre */

/*
 * The four questions, in order, at the top of the page: are we growing, what
 * is causing it, what is not working, what should we do next. Everything below
 * them is the evidence.
 *
 * The hard rule here is that a number nobody measured is never drawn. A
 * platform that does not report watch time shows a dash and the word
 * unreported; it does not show a zero, because a zero is a measurement and
 * would make that platform look like the worst performer rather than one that
 * does not answer the question.
 */

/* Platforms are proper nouns and capitalise() gets two of the six wrong. */
var PLATFORM_NAME = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok',
                      youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads' };
function platName(p) { return PLATFORM_NAME[p] || p; }

function nf(n) {
  if (n === null || n === undefined) return null;
  return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 });
}

function num(n, dash) {
  var v = nf(n);
  return v === null ? '<span class="nodata">' + (dash || 'not reported') + '</span>' : esc(v);
}

function signed(n) {
  if (n === null || n === undefined) return '<span class="nodata">—</span>';
  var cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  var sign = n > 0 ? '↑ ' : n < 0 ? '↓ ' : '';
  return '<span class="delta ' + cls + '">' + sign + nf(Math.abs(n)) + '</span>';
}

function pct(n) {
  if (n === null || n === undefined) return '';
  return ' <span class="quiet">' + (n > 0 ? '+' : '') + nf(n) + '%</span>';
}

function kind(k) {
  var cls = k === 'estimate' ? ' est' : k === 'calculated' ? ' calc' : '';
  return '<span class="kind' + cls + '">' + esc(k) + '</span>';
}

function loadCommand() {
  return api('/api/command').then(function (d) { state.command = d; return d; });
}

function growthAnswer(c) {
  var g = c.growth['30'] && c.growth['30'].available ? c.growth['30']
        : c.growth['7'] && c.growth['7'].available ? c.growth['7'] : null;
  if (!g) {
    return { q: 'Not yet — there is not enough history to say.',
             a: 'Growth needs two snapshots inside a window. The nightly collector ' +
                'has run ' + (c.overview.coverage ? c.overview.coverage.days : 0) +
                ' time(s). Ask again in a few days.' };
  }
  var word = g.net > 0 ? 'Yes.' : g.net < 0 ? 'No — the audience is shrinking.' : 'No — it is flat.';
  var a = nf(g.net) + ' followers over ' + g.spanDays + ' day(s), across ' +
          g.comparablePlatforms.length + ' platform(s) with data at both ends.';
  if (!g.complete) {
    a += ' This is the whole history so far, not a full ' + g.window + ' days.';
  }
  return { q: word, a: a };
}

function renderCommand() {
  var p = $('panel-command');
  var c = state.command;
  if (!c) { p.innerHTML = '<p class="quiet">Reading…</p>'; return; }

  var html = '';

  /* --- are we growing ---------------------------------------------------- */
  var ans = growthAnswer(c);
  html += '<div class="headline"><p class="q">' + esc(ans.q) + '</p>' +
          '<p class="a">' + esc(ans.a) + '</p></div>';

  var ov = c.overview;
  if (!ov.available) {
    html += '<div class="banner warn"><strong>No snapshots yet.</strong>' +
            '<span class="quiet">' + esc(ov.reason) + '</span></div>';
    p.innerHTML = html;
    return;
  }

  /* --- the top line ------------------------------------------------------ */
  var wc = ov.followers.windowsComplete;
  html += '<section><div class="sechead"><h2>Overview</h2>' +
          '<span class="when">as at ' + esc(ov.asOf) + ' · ' +
          ov.coverage.days + ' day(s) of history</span></div><div class="grid">';

  html += '<div class="tile"><div class="k">Total followers</div>' +
          '<div class="v">' + num(ov.followers.total) + '</div>' +
          '<div class="n">' + (ov.totals.followers.missing.length
            ? esc(ov.totals.followers.from.length) + ' of 6 platforms counted'
            : 'all six platforms') + '</div></div>';

  html += '<div class="tile"><div class="k">Gained this week</div>' +
          '<div class="v">' + signed(ov.followers.week) + '</div>' +
          '<div class="n">' + (wc.week ? 'full 7 days' : 'partial window') + '</div></div>';

  html += '<div class="tile"><div class="k">Gained this month</div>' +
          '<div class="v">' + signed(ov.followers.month) +
          pct(ov.followers.monthPercent) + '</div>' +
          '<div class="n">' + (wc.month ? 'full 30 days' : 'partial window') + '</div></div>';

  html += '<div class="tile"><div class="k">Posts this week</div>' +
          '<div class="v">' + esc(ov.posts.week) + '</div>' +
          '<div class="n">' + esc(ov.posts.today) + ' today</div></div>';

  html += '<div class="tile"><div class="k">Total reach</div>' +
          '<div class="v">' + num(ov.totals.reach.value) + '</div>' +
          '<div class="n">' + (ov.totals.reach.from.length
            ? esc(ov.totals.reach.from.join(', ')) : 'no platform reported reach') +
          '</div></div>';

  html += '<div class="tile"><div class="k">Biggest platform</div>' +
          '<div class="v">' +
          (ov.biggestPlatform ? esc(platName(ov.biggestPlatform.platform)) : '<span class="nodata">—</span>') +
          '</div><div class="n">' +
          (ov.biggestPlatform ? nf(ov.biggestPlatform.value) + ' followers' : '') +
          '</div></div>';

  html += '<div class="tile"><div class="k">Fastest growing</div>' +
          '<div class="v">' +
          (ov.fastestGrowing ? esc(platName(ov.fastestGrowing.platform)) : '<span class="nodata">not yet</span>') +
          '</div><div class="n">' +
          (ov.fastestGrowing ? signed(ov.fastestGrowing.value) + ' in the window' :
           'needs a full window on two platforms') + '</div></div>';

  html += '</div></section>';

  /* --- platform scorecards ---------------------------------------------- */
  html += '<section><div class="sechead"><h2>Platforms</h2>' +
          '<span class="when">status is our own judgement, not a platform metric</span>' +
          '</div><div class="plat">';

  c.scorecards.forEach(function (s) {
    var chip = s.status === 'GROWING' ? 'good'
             : s.status === 'DECLINING' ? 'bad'
             : s.status === 'FLAT' ? 'warn' : '';
    html += '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">' +
      '<span class="name">' + esc(platName(s.platform)) + '</span>' +
      '<span class="chip ' + chip + '">' + esc(s.status) + '</span></div>' +
      '<div class="big">' + num(s.followers, 'no data') + '</div>' +
      '<div class="quiet">' + esc(s.because) + '</div>' +
      (s.stale
        ? '<div class="quiet" style="color:var(--warn);margin-top:4px">Last collected ' +
          esc(s.asOf) + ' — ' + esc(s.ageDays) + ' days ago, not today</div>'
        : '');

    if (s.connected) {
      html += '<div class="rows">' +
        '<div><span>30-day change</span><span>' + signed(s.gained) + '</span></div>' +
        '<div><span>Reach</span><span>' + num(s.reach, 'unreported') + '</span></div>' +
        '<div><span>Engagement</span><span>' + num(s.engagement, 'unreported') + '</span></div>' +
        '<div><span>Video views</span><span>' + num(s.videoViews, 'unreported') + '</span></div>' +
        '</div>';

      if (s.milestone) {
        var m = s.milestone;
        var doneFrac = m.target ? Math.max(0, Math.min(1, (m.target - m.remaining) / m.target)) : 0;
        html += '<div class="rows"><div><span>Next milestone</span><span>' +
          nf(m.target - m.remaining) + ' / ' + nf(m.target) + '</span></div></div>' +
          '<div class="bar"><i style="width:' + (doneFrac * 100).toFixed(1) + '%"></i></div>' +
          '<div class="quiet" style="margin-top:6px">' + nf(m.remaining) + ' to go' +
          (m.estimatedDays !== null
            ? ' · about ' + nf(m.estimatedDays) + ' days at the current rate ' + kind('estimate')
            : ' · no date while growth is flat') +
          '</div>';
      }
    }
    html += '</div>';
  });
  html += '</div></section>';

  /* --- forecast ---------------------------------------------------------- */
  var f = c.forecast;
  html += '<section><div class="sechead"><h2>Forecast ' + kind('estimate') + '</h2></div>';
  if (!f.available) {
    html += '<div class="banner warn"><strong>More data required.</strong>' +
            '<span class="quiet">' + esc(f.reason) +
            (f.have !== undefined ? ' Currently holding ' + esc(f.have) + ' of ' +
             esc(f.need) + ' days.' : '') + '</span></div>';
  } else {
    html += '<p class="quiet">' + esc(f.method) + ', on ' + esc(f.basedOnDays) +
            ' days. These are projections, not measurements.</p><div class="grid">';
    [30, 90, 180].forEach(function (h) {
      var v = f.horizons[h];
      html += '<div class="tile"><div class="k">In ' + h + ' days</div>' +
              '<div class="v">' + nf(v.expected) + '</div>' +
              '<div class="n">likely ' + nf(v.low) + ' – ' + nf(v.high) + '</div></div>';
    });
    html += '</div>';
  }
  html += '</section>';

  /* --- what the analysis is still waiting for ---------------------------- */
  var h = c.dataHealth;
  html += '<section><div class="sechead"><h2>What is not ready yet</h2>' +
          '<span class="when">each needs a minimum of history before it will speak</span>' +
          '</div><div class="scroll"><table><thead><tr>' +
          '<th>Analysis</th><th class="num">Days held</th><th class="num">Needed</th>' +
          '<th>State</th></tr></thead><tbody>';
  var labels = { growth: 'Are we growing', comparison: 'Platform comparison',
                 timing: 'Best posting times', themes: 'Theme performance',
                 forecast: 'Growth forecast', experiment: 'Experiments' };
  Object.keys(h.readiness).forEach(function (k) {
    var r = h.readiness[k];
    html += '<tr><td>' + esc(labels[k] || k) + '</td>' +
            '<td class="num">' + esc(r.have) + '</td>' +
            '<td class="num">' + esc(r.need) + '</td>' +
            '<td>' + (r.ok ? '<span class="chip good">READY</span>'
                           : '<span class="chip">' + esc(r.short) + ' more days</span>') +
            '</td></tr>';
  });
  html += '</tbody></table></div></section>';

  /* --- data health ------------------------------------------------------- */
  html += '<section><div class="sechead"><h2>Data health</h2>' +
          '<span class="when">a stale figure is never shown as current</span>' +
          '</div><div class="scroll"><table><thead><tr>' +
          '<th>Platform</th><th>State</th><th>Source</th><th>Last collected</th>' +
          '<th>Note</th></tr></thead><tbody>';
  h.sources.forEach(function (sc) {
    var chip = sc.state === 'CONNECTED' ? 'good'
             : sc.state === 'STALE' ? 'warn'
             : sc.state === 'WARNING' ? 'bad' : '';
    html += '<tr><td>' + esc(platName(sc.platform)) + '</td>' +
            '<td><span class="chip ' + chip + '">' + esc(sc.state) + '</span></td>' +
            '<td class="quiet">' + (sc.source ? esc(sc.source) : '—') + '</td>' +
            '<td class="quiet">' + (sc.lastSnapshot ? esc(sc.lastSnapshot) : 'never') + '</td>' +
            '<td class="quiet">' + (sc.note ? esc(sc.note) : '') + '</td></tr>';
  });
  html += '</tbody></table></div>' +
          '<p class="quiet" style="margin-top:10px">Facebook and Instagram are read from ' +
          'the Meta Graph API by this service. Pinterest, TikTok, Threads and YouTube come ' +
          'through Metricool, gathered by the nightly collector. Post counts come from this ' +
          'service\\'s own publishing records.</p></section>';

  p.innerHTML = html;
}

/* =================================================================== tabs */

function showTab(name) {
  state.tab = name;
  ['today', 'command', 'compose', 'stats', 'log'].forEach(function (t) {
    $('panel-' + t).classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('nav.tabs button').forEach(function (b) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
  if (name === 'command') {
    renderCommand();
    if (!state.command) {
      loadCommand().then(renderCommand).catch(function (e) {
        $('panel-command').innerHTML = '<div class="banner bad"><strong>Could not read the ' +
          'command centre.</strong><span class="quiet">' + esc(e.message) + '</span></div>';
      });
    }
  }
  if (name === 'compose') renderCompose();
  if (name === 'stats' && !state.stats) {
    renderStats();
    loadStats(false).then(renderStats).catch(function (e) {
      $('panel-stats').innerHTML = '<div class="banner bad"><strong>Could not read the stats.' +
        '</strong><span class="quiet">' + esc(e.message) + '</span></div>';
    });
  }
  if (name === 'log') {
    renderLog();
    loadStatus().then(renderLog).catch(function () { /* the banner already says */ });
  }
}

function refreshAll() {
  return loadStatus()
    .then(function (s) { if (!state.date) state.date = s.today; return loadDay(state.date); })
    .then(function () { renderHealth(); renderToday(); if (state.tab === 'log') renderLog(); })
    .catch(function (e) { toast(e.message, true); });
}

/* =================================================================== boot */

document.querySelectorAll('nav.tabs button').forEach(function (b) {
  b.addEventListener('click', function () { showTab(b.dataset.tab); });
});
$('refresh').addEventListener('click', function () {
  this.disabled = true;
  var self = this;
  refreshAll().then(function () { self.disabled = false; });
});
$('signout').addEventListener('click', function () {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});
$('gatego').addEventListener('click', function () {
  var v = $('tok').value.trim();
  if (!v) return;
  $('gatemsg').textContent = 'checking…';
  tryToken(v).then(function () { $('gatemsg').textContent = ''; return refreshAll(); })
    .catch(function (e) {
      $('gatemsg').textContent = e.status === 401 ? 'That token was not accepted.' : e.message;
    });
});
$('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('gatego').click(); });

var saved = localStorage.getItem(TOKEN_KEY);
if (saved) {
  tryToken(saved).then(refreshAll).catch(function () {
    localStorage.removeItem(TOKEN_KEY);
    openGate('That saved token no longer works.');
  });
} else {
  openGate();
}

setInterval(function () { if (state.tab === 'today') refreshAll(); }, 120000);
</script>
</body></html>
`;

export const DASHBOARD_HTML = PAGE.split('__FONT__').join(PAGELLA_WOFF2_B64);
