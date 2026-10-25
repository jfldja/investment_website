#!/usr/bin/env node
// 抓取台灣證交所（TWSE）的加權指數、台積電、鴻海近期日收盤，輸出到 data/tw-quotes.json
// 需要 Node 18+（內建 fetch），不需安裝任何套件。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const OUT_FILE = 'data/tw-quotes.json';
const HISTORY_DAYS = 30;     // 每個標的保留最近幾個交易日
const MONTHS = 3;            // 往回抓幾個月（確保湊滿 30 個交易日）
const REQUEST_GAP_MS = 4000; // 證交所會限制頻率，請求之間要間隔

// id 要和前端 allAssets 的 tw 欄位一致
const TARGETS = [
  { id: 'twii',    type: 'index', name: '加權指數' },
  { id: 'tsmc',    type: 'stock', code: '2330', name: '台積電' },
  { id: 'foxconn', type: 'stock', code: '2317', name: '鴻海' },
];

const INDEX_URLS = (ym) => [
  `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym}&response=json`,
  `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date=${ym}`,
];
const STOCK_URL = (ym, code) =>
  `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}&stockNo=${code}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// 民國 '115/10/24' → '2026-10-24'
export function rocToIso(s) {
  const m = String(s).trim().match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// 依「欄位名稱」找日期與收盤欄，不寫死位置；欄位對不上時丟錯，避免悄悄寫入壞資料
function parseTable(json, closeLabel) {
  if (!json || !Array.isArray(json.data) || !Array.isArray(json.fields)) return []; // 該月無資料
  const iDate = json.fields.findIndex((f) => String(f).includes('日期'));
  const iClose = json.fields.findIndex((f) => String(f).includes(closeLabel));
  if (iDate < 0 || iClose < 0) throw new Error(`欄位與預期不符：${json.fields.join(',')}`);
  return json.data
    .map((row) => ({ d: rocToIso(row[iDate]), c: num(row[iClose]) }))
    .filter((p) => p.d && p.c !== null); // 停止交易的日子收盤價為 '--'，會被濾掉
}
export const parseStockDay = (j) => parseTable(j, '收盤價');
export const parseIndexHist = (j) => parseTable(j, '收盤指數');

export function mergePoints(all, keep = HISTORY_DAYS) {
  const byDate = new Map();
  all.forEach((p) => byDate.set(p.d, p.c));
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([d, c]) => ({ d, c }))
    .slice(-keep);
}

// 回傳「YYYYMM01」清單，從台北時間的當月起往回 n 個月
export function monthStarts(now = new Date(), n = MONTHS) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  let y = t.getUTCFullYear();
  let m = t.getUTCMonth();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m + 1).padStart(2, '0')}01`);
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return out;
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tw-quotes-bot)', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(REQUEST_GAP_MS * attempt);
    }
  }
  throw lastErr;
}

async function fetchIndexMonth(ym) {
  let lastErr = null;
  for (const url of INDEX_URLS(ym)) {
    try {
      const pts = parseIndexHist(await fetchJson(url));
      if (pts.length) return pts;
    } catch (e) { lastErr = e; }
    await sleep(REQUEST_GAP_MS);
  }
  if (lastErr) throw lastErr;
  return []; // 兩個網址都沒有該月資料
}

async function fetchSeries(target, now) {
  const all = [];
  for (const ym of monthStarts(now)) {
    const pts = target.type === 'stock'
      ? parseStockDay(await fetchJson(STOCK_URL(ym, target.code)))
      : await fetchIndexMonth(ym);
    all.push(...pts);
    await sleep(REQUEST_GAP_MS);
  }
  return mergePoints(all);
}

async function main() {
  let previous = {};
  try { previous = JSON.parse(await readFile(OUT_FILE, 'utf8')); } catch { /* 第一次執行 */ }
  const oldSeries = previous.series || {};
  const series = { ...oldSeries };
  const now = new Date();
  let ok = 0;

  for (const t of TARGETS) {
    try {
      const points = await fetchSeries(t, now);
      if (points.length < 2) throw new Error(`只取得 ${points.length} 筆資料`);
      series[t.id] = { name: t.name, points };
      ok++;
      console.log(`✔ ${t.name}：${points.length} 筆，最新 ${points.at(-1).d} = ${points.at(-1).c}`);
    } catch (e) {
      // 失敗時保留舊資料，不要把整個檔案洗掉
      console.log(`::warning::${t.name} 取得失敗：${e.message}`);
    }
  }

  if (ok === 0) {
    console.error('所有標的都取得失敗，不更新檔案。');
    process.exit(1);
  }
  if (JSON.stringify(series) === JSON.stringify(oldSeries)) {
    console.log('資料沒有變動（可能今天休市或尚未收盤），不更新檔案。');
    return;
  }
  await mkdir('data', { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ updatedAt: now.toISOString(), source: 'TWSE', series }, null, 2) + '\n');
  console.log(`已寫入 ${OUT_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
