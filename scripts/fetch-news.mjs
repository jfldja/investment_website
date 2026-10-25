#!/usr/bin/env node
// 從 Google News RSS 抓取財經新聞標題，以關鍵字詞典做情緒分析，輸出 data/news.json
// 需要 Node 18+，不需安裝任何套件。只儲存標題、來源、連結、時間（不儲存文章全文）。
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { POSITIVE, NEGATIVE, NEGATORS } from './news-dictionary.mjs';

export const OUT_FILE = 'data/news.json';
const REQUEST_GAP_MS = 2500;
const KEEP_NEWS = 60;      // 輸出的新聞筆數
const MIN_FEEDS_OK = 4;    // 至少要有幾個主題抓成功才更新檔案

// 熱門主題：name 顯示在頁面上；query 是 Google News 搜尋語法（OR 表示任一關鍵字）
export const TOPICS = [
  { name: 'AI 晶片供應鏈', query: 'AI 晶片 OR 台積電 OR 輝達 OR 半導體' },
  { name: '利率與通膨預期', query: '聯準會 OR 升息 OR 降息 OR 通膨 OR 利率' },
  { name: '台海地緣政治', query: '台海 OR 地緣政治 OR 出口管制 OR 關稅' },
  { name: '台股與資金面', query: '台股 OR 加權指數 OR 外資 OR 三大法人' },
  { name: '加密貨幣', query: '比特幣 OR 以太幣 OR 加密貨幣' },
  { name: '原油與黃金', query: '油價 OR 原油 OR 黃金 OR 金價' },
];
const feedUrl = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

const HOUR = 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- RSS 解析（不依賴套件） ---------- */
function decodeXml(s) {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => {
      const r = m[1].match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
      return r ? decodeXml(r[1]) : '';
    };
    const source = get('source');
    let title = get('title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    const t = Date.parse(get('pubDate'));
    if (!title || !Number.isFinite(t)) continue;
    items.push({ title, source: source || '未知來源', link: get('link'), t });
  }
  return items;
}

/* ---------- 情緒計分 ---------- */
const TERMS = [...POSITIVE.map(([w, v]) => [w, v]), ...NEGATIVE.map(([w, v]) => [w, -v])]
  .sort((a, b) => b[0].length - a[0].length); // 長詞優先
export function scoreTitle(title) {
  const used = new Array(title.length).fill(false);
  let total = 0;
  for (const [word, value] of TERMS) {
    let from = 0;
    let idx;
    while ((idx = title.indexOf(word, from)) !== -1) {
      from = idx + word.length;
      let overlap = false;
      for (let i = idx; i < idx + word.length; i++) if (used[i]) { overlap = true; break; }
      if (overlap) continue;
      for (let i = idx; i < idx + word.length; i++) used[i] = true;
      const before = title.slice(Math.max(0, idx - 2), idx);
      const negated = NEGATORS.some((n) => before.endsWith(n));
      total += negated ? -value * 0.5 : value;
    }
  }
  return total;
}
export const labelOf = (score) => (score >= 0.5 ? 'positive' : score <= -0.5 ? 'negative' : 'neutral');
const norm = (s) => Math.max(-1, Math.min(1, s / 3)); // 單則標題的情感，壓到 -1 ~ +1

/* ---------- 統計 ---------- */
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const round2 = (n) => Math.round(n * 100) / 100;
export const temperature = (items) =>
  items.length ? Math.round(50 + 50 * Math.max(-1, Math.min(1, 2 * mean(items.map((i) => norm(i.score)))))) : null;

// 最大餘數法，讓三個百分比加起來剛好 100
export function percents(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - floor[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) floor[i]++; });
  return floor;
}

export function analyze(items, now = Date.now()) {
  const inWin = (it, fromH, toH) => it.t > now - toH * HOUR && it.t <= now - fromH * HOUR;
  const cur = items.filter((i) => inWin(i, 0, 24));
  const prev = items.filter((i) => inWin(i, 24, 48));

  const pos = cur.filter((i) => i.sentiment === 'positive').length;
  const neg = cur.filter((i) => i.sentiment === 'negative').length;
  const neu = cur.length - pos - neg;
  const [bull, bear, wait] = percents([pos, neg, neu]);
  const score = temperature(cur);
  const prevScore = temperature(prev);
  const market = {
    score, prevScore, delta: score !== null && prevScore !== null ? score - prevScore : null,
    bull, bear, neutral: wait, total: cur.length,
  };

  const perTopic = TOPICS.map((tp) => {
    const mine = (win) => win.filter((i) => i.topics.includes(tp.name));
    return { tp, cur: mine(cur), prev: mine(prev), all: mine(items) };
  });
  const maxCount = Math.max(1, ...perTopic.map((p) => p.cur.length));
  const topics = perTopic.map((p, i) => {
    const count = p.cur.length;
    const ratio = p.prev.length ? count / p.prev.length : count ? 2 : 1;
    return {
      id: i + 1, name: p.tp.name, count,
      heat: count ? Math.max(10, Math.round((100 * count) / maxCount)) : 0,
      sentiment: round2(mean(p.cur.map((x) => norm(x.score)))),
      trend: ratio > 1.2 ? 'up' : ratio < 0.8 ? 'down' : 'flat',
    };
  });

  const alerts = [];
  const sign = (n) => (n > 0 ? '+' : '') + n;
  perTopic.forEach((p) => {
    // 1) 新聞量異常：近 6 小時 vs 前 42 小時的每 6 小時平均
    const c6 = p.all.filter((i) => inWin(i, 0, 6)).length;
    const earlierAvg = p.all.filter((i) => inWin(i, 6, 48)).length / 7;
    const ratio = c6 / Math.max(earlierAvg, 0.5);
    if (c6 >= 4 && ratio >= 2) {
      alerts.push({
        type: ratio >= 3 ? 'danger' : 'warning', icon: 'fa-triangle-exclamation', weight: ratio,
        title: `${p.tp.name}主題新聞量異常增加`,
        desc: `近 6 小時 ${c6} 則，約為前 42 小時平均的 ${ratio.toFixed(1)} 倍`,
      });
    }
    // 2) 情感急轉：24 小時平均情感與前一個 24 小時相比
    if (p.cur.length >= 5 && p.prev.length >= 5) {
      const a = mean(p.prev.map((x) => norm(x.score)));
      const b = mean(p.cur.map((x) => norm(x.score)));
      if (Math.abs(b - a) >= 0.3) {
        alerts.push({
          type: b < a ? 'warning' : 'info', icon: b < a ? 'fa-triangle-exclamation' : 'fa-chart-line',
          weight: Math.abs(b - a) * 3,
          title: `${p.tp.name}情感急轉${b < a ? '負向' : '正向'}`,
          desc: `24 小時平均情感由 ${sign(Math.round(a * 100))} 變為 ${sign(Math.round(b * 100))}（${p.prev.length}→${p.cur.length} 則）`,
        });
      }
    }
  });
  // 3) 整體偏向
  if (cur.length >= 20) {
    if (bear >= 50) alerts.push({ type: 'warning', icon: 'fa-triangle-exclamation', weight: 2, title: '負面新聞占比偏高', desc: `近 24 小時 ${cur.length} 則新聞中，負面占 ${bear}%` });
    else if (bull >= 60) alerts.push({ type: 'info', icon: 'fa-chart-line', weight: 1, title: '正面新聞占比偏高', desc: `近 24 小時 ${cur.length} 則新聞中，正面占 ${bull}%（過熱時也要留意追高風險）` });
  }
  if (market.delta !== null && Math.abs(market.delta) >= 15) {
    alerts.push({ type: 'info', icon: 'fa-chart-line', weight: 1, title: `市場情緒溫度較昨日${market.delta > 0 ? '大幅升溫' : '明顯降溫'}`, desc: `由 ${prevScore} 變為 ${score}（${sign(market.delta)}）` });
  }
  alerts.sort((a, b) => b.weight - a.weight);
  return { market, topics, alerts: alerts.slice(0, 5).map(({ weight, ...rest }) => rest) };
}

/* ---------- 抓取與整合 ---------- */
async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-dashboard-bot)', Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) { lastErr = e; await sleep(REQUEST_GAP_MS * attempt); }
  }
  throw lastErr;
}
const dedupeKey = (title) => title.replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 20);

export function mergeFeeds(feeds, now = Date.now()) {
  const map = new Map();
  for (const { topic, items } of feeds) {
    for (const it of items) {
      if (it.t > now + HOUR || it.t < now - 48 * HOUR) continue;
      const key = dedupeKey(it.title);
      if (!key) continue;
      const hit = map.get(key);
      if (hit) { if (!hit.topics.includes(topic)) hit.topics.push(topic); continue; }
      const score = scoreTitle(it.title);
      map.set(key, { ...it, topics: [topic], score, sentiment: labelOf(score) });
    }
  }
  return [...map.values()].sort((a, b) => b.t - a.t);
}

async function main() {
  const now = Date.now();
  const feeds = [];
  const failed = [];
  for (const tp of TOPICS) {
    try {
      feeds.push({ topic: tp.name, items: parseRss(await fetchText(feedUrl(tp.query))) });
      console.log(`✔ ${tp.name}：${feeds.at(-1).items.length} 則`);
    } catch (e) {
      failed.push(tp.name);
      console.log(`::warning::${tp.name} 取得失敗：${e.message}`);
    }
    await sleep(REQUEST_GAP_MS);
  }
  if (feeds.length < MIN_FEEDS_OK) { console.error(`只有 ${feeds.length} 個主題成功，不更新檔案。`); process.exit(1); }

  const items = mergeFeeds(feeds, now);
  if (items.length < 10) { console.error(`整合後只有 ${items.length} 則新聞，資料太少，不更新檔案。`); process.exit(1); }
  const { market, topics, alerts } = analyze(items, now);
  const okTopics = topics.filter((t) => !failed.includes(t.name));
  const out = {
    updatedAt: new Date(now).toISOString(), source: 'Google News RSS', method: 'keyword-dictionary',
    failedTopics: failed, market, topics: okTopics, alerts,
    news: items.slice(0, KEEP_NEWS).map((i) => ({
      time: new Date(i.t).toISOString(), source: i.source, title: i.title, link: i.link,
      sentiment: i.sentiment, score: Math.round(i.score * 10) / 10, topic: i.topics[0],
    })),
  };
  await mkdir('data', { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`已寫入 ${OUT_FILE}：${items.length} 則（24 小時內 ${market.total} 則），情緒溫度 ${market.score}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
