/* 真實新聞資料：讀取 data/news.json（由 GitHub Actions 執行 scripts/fetch-news.mjs 產生），
   覆蓋頁面上原本的示範資料。需放在 index_firebase.html 最後的 <script> 之後載入。 */
(() => {
  'use strict';

  // 預設讀同網域的檔案。若網站放在別處（例如 Firebase Hosting 且不想每次重新部署），可改成：
  // 'https://raw.githubusercontent.com/<帳號>/<repo>/main/data/news.json'（repo 需為公開）
  const NEWS_URL = './data/news.json';
  const REFRESH_MS = 10 * 60 * 1000;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeHref = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (e) { return ''; } };
  const SENT = ['positive', 'negative', 'neutral'];
  const ALERT_TYPES = ['danger', 'warning', 'info'];
  const ALERT_ICONS = ['fa-triangle-exclamation', 'fa-clock', 'fa-chart-line'];

  const fmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = (d) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '--:--';
    const p = parts(d), t = parts(new Date());
    const hm = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
    return p.month === t.month && p.day === t.day ? hm : `${p.month}/${p.day} ${hm}`;
  }

  let meta = '載入中…';
  let emptyMsg = '載入中…';
  let loadState = 'loading'; // loading | ok | error

  /* ---------- 覆蓋原本的渲染函式 ---------- */
  renderNews = function () {
    const c = document.getElementById('newsFeed');
    if (!c) return;
    const list = state.newsFilter === 'all' ? news : news.filter((i) => i.sentiment === state.newsFilter);
    const head = `<div class="text-[10px] text-slate-400 mb-3 px-1">${esc(meta)}</div>`;
    if (!list.length) {
      c.innerHTML = head + `<div class="p-6 text-center text-sm text-slate-400">${esc(news.length ? '沒有符合條件的新聞' : emptyMsg)}</div>`;
      return;
    }
    c.innerHTML = head + list.map((n) => {
      const cls = n.sentiment === 'positive' ? 'sent-positive' : n.sentiment === 'negative' ? 'sent-negative' : 'sent-neutral';
      const label = n.sentiment === 'positive' ? '正面' : n.sentiment === 'negative' ? '負面' : '中性';
      const href = safeHref(n.link);
      const open = href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : '<div';
      const close = href ? '</a>' : '</div>';
      return `${open} class="flex gap-3 p-3 mb-2 rounded-lg border border-slate-100 bg-white hover:bg-slate-50 cursor-pointer transition group no-underline">`
        + `<div class="text-[10px] font-bold text-slate-400 whitespace-nowrap">${esc(n.time)}</div>`
        + `<div class="flex-1 min-w-0"><div class="text-xs font-semibold text-slate-700 truncate">${esc(n.source)}</div>`
        + `<div class="text-sm font-medium text-slate-900 leading-snug mt-0.5" title="${esc(n.title)}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(n.title)}</div>`
        + `<div class="flex items-center gap-2 mt-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold border ${cls}">${label}</span>`
        + `<span class="text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">${esc(n.topic)}</span></div></div>${close}`;
    }).join('');
  };

  renderTopics = function () {
    const c = document.getElementById('topicList');
    if (!c) return;
    if (!topics.length) { c.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">${esc(emptyMsg)}</div>`; return; }
    c.innerHTML = topics.map((t) => {
      const tc = t.trend === 'up' ? 'trend-up' : t.trend === 'down' ? 'trend-down' : 'trend-flat';
      const ti = t.trend === 'up' ? '↑' : t.trend === 'down' ? '↓' : '→';
      const bar = t.sentiment > 0 ? 'bg-indigo-500' : t.sentiment < 0 ? 'bg-rose-500' : 'bg-slate-400';
      return `<div class="p-3 rounded-xl border border-slate-100 bg-white mb-3"><div class="flex justify-between items-start mb-1"><span class="font-bold text-slate-800 text-sm">${esc(t.name)}</span><span class="text-xs font-bold ${tc}">${ti}</span></div>`
        + `<div class="w-full bg-slate-100 h-1.5 rounded-full mb-2 overflow-hidden"><div class="h-full ${bar}" style="width: ${Math.max(0, Math.min(100, Number(t.heat) || 0))}%"></div></div>`
        + `<div class="flex justify-between text-xs text-slate-500"><span>新聞 ${Number(t.count) || 0} 則</span><span>情感 ${((Number(t.sentiment) || 0) * 100).toFixed(0)}</span></div></div>`;
    }).join('');
  };

  renderAlerts = function () {
    const c = document.getElementById('alertList');
    if (!c) return;
    if (!alerts.length) { c.innerHTML = `<div class="p-3 text-center text-xs text-slate-400">${esc(loadState === 'ok' ? '目前沒有偵測到異常訊號' : loadState === 'error' ? '無法取得預警資料' : '載入中…')}</div>`; return; }
    c.innerHTML = alerts.map((a) => {
      const color = a.type === 'danger' ? 'border-rose-500 bg-rose-50' : a.type === 'warning' ? 'border-amber-500 bg-amber-50' : 'border-blue-500 bg-blue-50';
      const ic = a.type === 'danger' ? 'text-rose-600' : a.type === 'warning' ? 'text-amber-600' : 'text-blue-600';
      return `<div class="p-3 rounded-lg border ${color}"><div class="flex items-start gap-2 mb-1"><div class="${ic} text-xs mt-0.5"><i class="fa-solid ${a.icon}"></i></div>`
        + `<div class="flex-1"><div class="text-xs font-bold text-slate-800">${esc(a.title)}</div><div class="text-[10px] text-slate-500 mt-0.5">${esc(a.desc)}</div></div></div></div>`;
    }).join('');
  };

  /* ---------- 市場情緒溫度卡片（原本是寫死的 HTML，這裡整張重畫） ---------- */
  function renderMarketCard(m) {
    const card = document.querySelector('section.grid > div.lg\\:col-span-4');
    if (!card) return;
    const ok = m && m.score !== null && m.score !== undefined;
    const score = ok ? Number(m.score) : null;
    const emoji = !ok ? '⏳' : score >= 75 ? '☀️' : score >= 60 ? '🌤️' : score >= 40 ? '⛅' : score >= 25 ? '🌧️' : '⛈️';
    const hasDelta = ok && m.delta !== null && m.delta !== undefined;
    const dCls = !hasDelta ? 'trend-flat' : m.delta > 0 ? 'trend-up' : m.delta < 0 ? 'trend-down' : 'trend-flat';
    const dTxt = hasDelta ? (m.delta > 0 ? '+' : '') + m.delta : '—';
    const note = ok ? `依近 24 小時 ${Number(m.total) || 0} 則新聞標題估算${(m.total || 0) < 20 ? '（樣本偏少，僅供參考）' : ''}` : '';
    const pct = (v) => (ok ? `${Number(v) || 0}%` : '—');
    card.innerHTML = `
      <div class="flex items-start justify-between mb-4">
        <div>
          <p class="text-sm text-slate-500 font-medium">市場情緒溫度</p>
          <h2 class="text-4xl font-bold text-slate-900">${ok ? score : '—'} <span class="text-xl font-normal text-slate-500">/ 100</span></h2>
        </div>
        <div class="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-600 text-2xl font-bold">${emoji}</div>
      </div>
      <div class="flex items-end gap-2 mb-1">
        <span class="text-2xl font-bold ${dCls}">${dTxt}</span>
        <span class="text-xs text-slate-400 self-end">vs. 前 24 小時</span>
      </div>
      <p class="text-[10px] text-slate-400 mb-4">${esc(note)}</p>
      <div class="grid grid-cols-3 gap-4 text-center border-t border-slate-100 pt-4">
        <div><div class="text-xs text-slate-400 uppercase tracking-wider">多頭</div><div class="text-lg font-bold text-slate-900">${pct(m && m.bull)}</div></div>
        <div><div class="text-xs text-slate-400 uppercase tracking-wider">空頭</div><div class="text-lg font-bold text-slate-900">${pct(m && m.bear)}</div></div>
        <div><div class="text-xs text-slate-400 uppercase tracking-wider">觀望</div><div class="text-lg font-bold text-slate-900">${pct(m && m.neutral)}</div></div>
      </div>
      <div class="mt-4 h-1 w-full bg-slate-200 rounded-full overflow-hidden"><div class="h-full bg-indigo-500" style="width: ${ok ? Math.max(0, Math.min(100, score)) : 0}%"></div></div>`;
  }

  function fixTexts() {
    const heat = document.getElementById('topicList');
    const heatNote = heat && heat.parentElement.lastElementChild;
    if (heatNote && heatNote !== heat) heatNote.textContent = '熱度 = 近 24 小時新聞量（相對最高的主題）';
    const al = document.getElementById('alertList');
    const alNote = al && al.parentElement.querySelector('p.text-xs');
    if (alNote) alNote.textContent = '依規則自動偵測（新聞量暴增、情感急轉、整體偏向），僅供參考。';
    const foot = document.querySelector('footer p');
    if (foot) foot.textContent = '⚠️ 股價與新聞來自公開來源，新聞情緒由關鍵字詞典自動判斷，可能有誤，不構成任何投資建議。';
  }

  function repaint() { renderMarketCard(window.__newsMarket || null); renderTopics(); renderNews(); renderAlerts(); }

  async function loadNews() {
    try {
      const res = await fetch(NEWS_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (!d || !Array.isArray(d.news) || !Array.isArray(d.topics)) throw new Error('資料格式不符');
      news.length = 0;
      news.push(...d.news.map((n) => ({
        time: fmtTime(n.time), source: String(n.source || ''), title: String(n.title || ''), link: String(n.link || ''),
        sentiment: SENT.includes(n.sentiment) ? n.sentiment : 'neutral', topic: String(n.topic || ''),
      })));
      topics.length = 0;
      topics.push(...d.topics);
      alerts.length = 0;
      alerts.push(...(Array.isArray(d.alerts) ? d.alerts : []).map((a) => ({
        type: ALERT_TYPES.includes(a.type) ? a.type : 'info',
        icon: ALERT_ICONS.includes(a.icon) ? a.icon : 'fa-chart-line',
        title: String(a.title || ''), desc: String(a.desc || ''),
      })));
      window.__newsMarket = d.market || null;
      const ageH = d.updatedAt ? (Date.now() - new Date(d.updatedAt).getTime()) / 3600000 : 0;
      meta = `資料更新於 ${fmtTime(d.updatedAt)} · 共 ${news.length} 則 · 情緒由關鍵字詞典自動判斷，僅供參考`
        + (ageH > 12 ? ` · ⚠️ 已 ${Math.floor(ageH)} 小時未更新` : '');
      emptyMsg = '目前沒有資料';
      loadState = 'ok';
    } catch (e) {
      console.error('讀取新聞資料失敗', e);
      // 失敗時若沒有舊資料就清空，不要繼續顯示示範用的假新聞
      if (!window.__newsMarket) { news.length = 0; topics.length = 0; alerts.length = 0; }
      meta = '';
      loadState = 'error';
      emptyMsg = `新聞資料讀取失敗（${e.message || '網路錯誤'}），請確認 GitHub Actions 已執行並產生 data/news.json`;
    }
    repaint();
  }

  // 先清掉示範資料，避免畫面閃過假新聞
  news.length = 0; topics.length = 0; alerts.length = 0;
  fixTexts();
  repaint();
  loadNews();
  setInterval(() => { if (!document.hidden) loadNews(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNews(); });
})();
