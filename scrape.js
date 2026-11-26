// TrendAlert data scraper — MULTI-SOURCE, production.
//
// Runs in GitHub Actions (free). Each feed has an ordered list of SOURCES on
// DIFFERENT sites. We try them in order and the first one that returns valid
// data wins — so if a primary site blocks our IP or changes layout, the backup
// keeps the app running with zero app update.
//
// Resilience:
//  - first source with rows wins; we record which one in the JSON.
//  - if ALL sources fail, we DON'T overwrite the file (app keeps last-good).
//  - every source is wrapped; one throwing never stops the others.

import { load } from 'cheerio';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT_DIR = new URL('./docs/data/', import.meta.url);
const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
const firstNum = (s) => {
  const m = norm(s).match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : '';
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + 2 retries with backoff. Source sites (and NSE especially) drop the
// odd connection; a single blip should not cost us a whole feed.
async function fetchRetry(url, options, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', ...options });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

async function getHtml(url) {
  const res = await fetchRetry(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  return load(await res.text());
}

async function getJson(url, headers = {}) {
  const res = await fetchRetry(url, {
    headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json', ...headers },
  });
  return res.json();
}

// First <table> whose header row contains all keywords.
function findTable($, keywords) {
  let found = null;
  $('table').each((_, t) => {
    if (found) return;
    const rows = $(t).find('tr');
    if (rows.length < 2) return;
    const head = norm($(rows[0]).text()).toLowerCase();
    if (keywords.every((k) => head.includes(k))) found = t;
  });
  return found;
}

// Generic header-based HTML table scraper → array of raw {field: text, url?}.
async function scrapeTable(url, keywords, colSpecs, urlField) {
  const $ = await getHtml(url);
  const table = findTable($, keywords);
  if (!table) throw new Error(`no table ${url}`);
  const rows = $(table).find('tr').toArray();
  const headers = $(rows[0])
    .find('th, td')
    .toArray()
    .map((e) => norm($(e).text()).toLowerCase());
  const idx = {};
  for (const [f, names] of Object.entries(colSpecs)) {
    idx[f] = -1;
    for (const n of names) {
      const i = headers.findIndex((h) => h.includes(n));
      if (i >= 0) { idx[f] = i; break; }
    }
  }
  const firstField = urlField || Object.keys(colSpecs)[0];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = $(rows[i]).find('td').toArray();
    if (!cells.length) continue;
    const cell = (f) =>
      idx[f] >= 0 && idx[f] < cells.length ? norm($(cells[idx[f]]).text()) : '';
    const obj = {};
    for (const f of Object.keys(colSpecs)) obj[f] = cell(f);
    if (urlField) {
      const c = idx[urlField] >= 0 ? idx[urlField] : 0;
      obj.url = c < cells.length ? $(cells[c]).find('a').attr('href') || '' : '';
    }
    const name = obj[firstField] || '';
    if (!name || /no calls/i.test(name) || /^[₹\[\].\s-]+$/.test(name)) continue;
    out.push(obj);
  }
  if (!out.length) throw new Error(`0 rows ${url}`);
  return out;
}

const absIpowatch = (u) =>
  !u ? '' : u.startsWith('http') ? u : `https://ipowatch.in${u}`;

// ---------------------------------------------------------------------------
// ipoji.com — server-rendered GMP table (backup for gmp / upcoming feeds)
// ---------------------------------------------------------------------------
//
// Columns: IPO | Type | Price Band | GMP (₹) | GMP % | Indicative Listing |
//          Open – Close | Status | Last Updated
// The name cell reads "<Name> IPO <Type> <Status>" (type/status are badges),
// so we strip those suffixes to get a clean name comparable to ipowatch's.

const MONTHS_SHORT = {
  jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'Jun',
  jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec',
};

// "Jul 22, 2026" -> "22 Jul"  (matches the ipowatch-style short dates)
function shortDate(raw) {
  const m = norm(raw).match(/([A-Za-z]{3,9})\s+(\d{1,2})/);
  if (!m) return norm(raw);
  const mon = MONTHS_SHORT[m[1].slice(0, 3).toLowerCase()];
  return mon ? `${m[2]} ${mon}` : norm(raw);
}

function ipojiCleanName(cell, type, status) {
  let n = norm(cell);
  for (const suffix of [status, type, 'IPO']) {
    if (!suffix) continue;
    const re = new RegExp(`\\s*${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    n = n.replace(re, '').trim();
  }
  return n;
}

async function ipojiRows() {
  const rows = await scrapeTable(
    'https://ipoji.com/ipo-gmp',
    ['gmp'],
    {
      title: ['ipo'],
      type: ['type'],
      price: ['price band', 'price'],
      gmp: ['gmp (', 'gmp'],
      gain: ['gmp %', '%'],
      dates: ['open', 'close'],
      status: ['status'],
    },
    'title',
  );
  return rows
    .map((r) => {
      const type = norm(r.type);
      const status = norm(r.status);
      const title = ipojiCleanName(r.title, type, status);
      // "+₹10 (+14%)" -> gmp "₹10"; "—" -> ''
      const gmpNum = firstNum(r.gmp);
      const gmp = gmpNum && gmpNum !== '0' ? `₹${gmpNum.replace('-', '')}` : '';
      // "(+14%)" -> "14%", "(-3%)" -> "-3%", "—" -> ''
      const pct = norm(r.gain).replace(/[()+]/g, '').trim();
      const gain = /\d/.test(pct) ? pct : '';
      const parts = norm(r.dates).split(/[–—-]/);
      return {
        title,
        gmp: norm(r.gmp).startsWith('-') && gmp ? `-${gmp}` : gmp,
        gain,
        price: norm(r.price),
        openDate: parts[0] ? shortDate(parts[0]) : '',
        closeDate: parts[1] ? shortDate(parts[1]) : '',
        type: type || 'Mainboard',
        status,
        url: 'https://ipoji.com/ipo-gmp',
      };
    })
    .filter((x) => x.title && x.title.length > 1);
}

const ipojiGmp = async () => (await ipojiRows()).map(({ status, ...r }) => r);

// Upcoming/open IPOs from ipoji, split by board. `sme=true` keeps SME rows.
async function ipojiUpcoming(sme) {
  return (await ipojiRows())
    .filter((r) => /sme/i.test(r.type) === !!sme)
    .filter((r) => !/listed|closed/i.test(r.status))
    .map((r) => ({
      title: r.title,
      openDate: r.openDate,
      closeDate: r.closeDate,
      size: '',
      priceBand: r.price,
      type: r.type,
      url: r.url,
    }));
}

// 5paisa 52-week high/low list page.
async function paisa52(url) {
  return scrapeTable(url, ['ltp', 'gain'], {
    name: ['company', 'stock', 'name'],
    week52: ['52w', '52 w', '52 week', 'week high', 'week low'],
    ltp: ['ltp', 'cmp', 'price'],
    gainPct: ['gain', 'change', '%'],
    dayLow: ["day's low", 'low'],
    dayHigh: ["day's high", 'high'],
    volume: ['volume', 'vol'],
  });
}

// ---------------------------------------------------------------------------
// NSE JSON APIs (movers, 52-week, bulk deals, indices, live IPO subscription)
// ---------------------------------------------------------------------------

// NSE needs a cookie handshake from the homepage first; we cache it per run.
let _nseCookie = null;
async function nseGet(apiPath) {
  if (!_nseCookie) {
    const home = await fetch('https://www.nseindia.com/', {
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html' },
    });
    _nseCookie = (home.headers.get('set-cookie') || '')
      .split(',')
      .map((c) => c.split(';')[0])
      .join('; ');
  }
  return getJson(`https://www.nseindia.com/api/${apiPath}`, {
    Referer: 'https://www.nseindia.com/market-data',
    Cookie: _nseCookie,
  });
}

async function nseMovers(index) {
  const data = await nseGet(`live-analysis-variations?index=${index}`);
  // Shape varies: sometimes {NIFTY:{data}}, sometimes {data}.
  const arr =
    (data && data.NIFTY && data.NIFTY.data) ||
    (data && data.data) ||
    (data &&
      Object.values(data).find((v) => v && Array.isArray(v.data))?.data) ||
    [];
  if (!Array.isArray(arr) || !arr.length) throw new Error('nse: no data');
  return arr.slice(0, 50).map((r) => ({
    name: norm(r.symbol),
    ltp: norm(r.ltp ?? r.lastPrice ?? r.last_price),
    gainPct: `${norm(r.perChange ?? r.pChange ?? r.net_price ?? '')} %`,
    dayLow: norm(r.low_price ?? r.dayLow ?? r.intra_day_low ?? ''),
    dayHigh: norm(r.high_price ?? r.dayHigh ?? r.intra_day_high ?? ''),
    volume: norm(r.trade_quantity ?? r.totalTradedVolume ?? r.volume ?? ''),
  }));
}

async function nse52(kind) {
  const data = await nseGet(
    kind === 'high'
      ? 'live-analysis-data-52weekhighstock'
      : 'live-analysis-data-52weeklowstock',
  );
  const arr = (data && data.data) || [];
  if (!arr.length) throw new Error('nse 52w: no data');
  return arr.slice(0, 60).map((r) => ({
    name: norm(r.comapnyName ?? r.companyName ?? r.symbol),
    week52: norm(r.new52WHL),
    ltp: norm(r.ltp),
    gainPct: `${norm(r.pChange)} %`,
    dayLow: '',
    dayHigh: '',
    volume: '',
  }));
}

// --- Live IPO subscription (category-wise) --------------------------------
//
// `ipo-current-issue` lists the issues open for bidding right now; for each we
// pull `ipo-active-category` (freshest, updated through the day) and fall back
// to `ipo-detail` for the category split. Rows survive with just the total if
// the per-symbol call fails, so one bad symbol never empties the feed.

const NSE_CAT = {
  qib: /qualified institutional/i,
  nii: /^non institutional investors$/i,
  bhni: /bid amount of more than ten lakh/i,
  shni: /bid amount of more than two lakh/i,
  rii: /retail individual/i,
};

const seriesType = (series) => {
  const s = norm(series).toUpperCase();
  if (s === 'SME' || s === 'SM' || s === 'ST') return 'SME';
  if (s === 'IV' || s === 'IT') return 'InvIT';
  return 'Mainboard';
};

// "2.2942809284517827" -> "2.29"; "" -> ""
const xTimes = (v) => {
  const d = Number(norm(v));
  return norm(v) === '' || !isFinite(d) ? '' : d.toFixed(2);
};

async function nseCategories(symbol, series) {
  const tryOne = async (path, listKey, catKey, timesKey) => {
    const data = await nseGet(path);
    const list = (data && data[listKey]) || [];
    const out = {};
    for (const row of list) {
      const cat = norm(row[catKey]);
      if (!cat || cat.toLowerCase() === 'category') continue; // header row
      const times = xTimes(row[timesKey]);
      if (/^total$/i.test(cat)) {
        out.total = times;
        continue;
      }
      for (const [key, re] of Object.entries(NSE_CAT)) {
        if (re.test(cat) && !out[key]) out[key] = times;
      }
    }
    return out;
  };

  try {
    return await tryOne(
      `ipo-active-category?symbol=${encodeURIComponent(symbol)}&series=${encodeURIComponent(series)}`,
      'dataList',
      'category',
      'noOfTotalMeant',
    );
  } catch (_) {
    try {
      return await tryOne(
        `ipo-detail?symbol=${encodeURIComponent(symbol)}&series=${encodeURIComponent(series)}`,
        'bidDetails',
        'category',
        'noOfTime',
      );
    } catch (_) {
      return {};
    }
  }
}

async function nseSubscription() {
  const active = await nseGet('ipo-current-issue');
  if (!Array.isArray(active)) {
    throw new Error('nse: unexpected ipo-current-issue response');
  }
  // No IPO open for bidding right now is a normal quiet window between issues,
  // not a scraper failure. Return an empty (but fresh) feed so the pipeline
  // publishes count:0 instead of keeping the last-good file — which, after 48h
  // of no open IPOs, makes the health check hard-fail the whole job and email a
  // false alarm. A real NSE outage still throws from nseGet() above, and a
  // response shape change is caught by the Array check.
  if (!active.length) return [];

  // One row per symbol (the endpoint repeats a symbol per category).
  const bySymbol = new Map();
  for (const r of active) {
    const sym = norm(r.symbol);
    if (!sym) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, r);
    if (/^total$/i.test(norm(r.category))) bySymbol.set(sym, r);
  }

  const out = [];
  for (const [sym, r] of bySymbol) {
    const cats = await nseCategories(sym, norm(r.series) || 'EQ');
    const shares = Number(norm(r.issueSize));
    out.push({
      name: norm(r.companyName) || sym,
      symbol: sym,
      total: cats.total || xTimes(r.noOfTime),
      qib: cats.qib || '',
      shni: cats.shni || '',
      bhni: cats.bhni || '',
      nii: cats.nii || '',
      rii: cats.rii || '',
      ipoSize: isFinite(shares) && shares > 0 ? `${shares.toLocaleString('en-IN')} shares` : '',
      price: norm(r.issuePrice).replace(/Rs\.?\s*/gi, '₹'),
      closeDate: nseDate(r.issueEndDate),
      type: seriesType(r.series),
      url: '',
    });
    await sleep(250); // be polite to NSE
  }
  if (!out.length) throw new Error('nse: no subscription rows');
  return out;
}

// --- Live IPO subscription from ipoji (primary) ----------------------------
//
// NSE's API started resetting connections from cloud runners on 25–26 Nov
// 2026, so the subscription feed froze at 0×. ipoji is self-hosted (no
// Cloudflare wall) and its table carries the full category split:
//   Company | Close Date | QIB (x) | SNII(x) | BNII(x) | NII(x) | Retail(x) |
//   Employee (x) | Others(x) | Total(x) | Applications | Issue Size
// Headers are matched EXACTLY ("nii" must not grab "snii"). The company cell
// ends with exchange badges ("NSE BSE" / "NSE" / "BSE"). Only issues still
// open for bidding (close date today or later, IST) are kept — the same
// "open right now" meaning the NSE source had.
const IPOJI_SUB_URL = 'https://www.ipoji.com/ipo-subscription-status';

// "30 Nov 2026" -> Date (UTC midnight), or null.
function dayMonYear(raw) {
  const m = norm(raw).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  const mon = Object.keys(MONTHS_SHORT).indexOf(m[2].toLowerCase());
  return mon < 0 ? null : new Date(Date.UTC(+m[3], mon, +m[1]));
}

// (Name matching uses the shared nameKey() defined with the calendar code.)
async function ipojiSubscription() {
  const $ = await getHtml(IPOJI_SUB_URL);
  const table = findTable($, ['qib', 'retail', 'total']);
  if (!table) throw new Error('ipoji subscription: no table');
  const rows = $(table).find('tr').toArray();
  const head = $(rows[0])
    .find('th, td')
    .toArray()
    .map((e) => norm($(e).text()).toLowerCase().replace(/\(x\)|\s/g, ''));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    name: col('company', 'ipo', 'companyname'),
    close: col('closedate', 'close'),
    qib: col('qib'),
    shni: col('snii', 's-nii', 'shni'),
    bhni: col('bnii', 'b-nii', 'bhni'),
    nii: col('nii', 'hni'),
    rii: col('retail', 'rii'),
    total: col('total'),
    size: col('issuesize', 'size'),
  };
  if (ix.name < 0 || ix.total < 0) throw new Error('ipoji subscription: header changed');

  // Price band and board type come from ipoji's IPO table (same site).
  let meta = new Map();
  try {
    meta = new Map((await ipojiRows()).map((r) => [nameKey(r.title), r]));
  } catch (_) {
    /* price/type are nice-to-have; the subscription figures still publish */
  }

  const istToday = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today = Date.UTC(istToday.getUTCFullYear(), istToday.getUTCMonth(), istToday.getUTCDate());

  let parsed = 0;
  const out = [];
  for (const tr of rows.slice(1)) {
    const cells = $(tr).find('td').toArray();
    if (cells.length < 4) continue;
    const cell = (i) => (i >= 0 && i < cells.length ? norm($(cells[i]).text()) : '');
    const rawName = cell(ix.name);
    const badges = (rawName.match(/(?:\s+(?:NSE|BSE))+\s*$/i) || [''])[0];
    const name = norm(rawName.slice(0, rawName.length - badges.length));
    if (!name) continue;
    parsed++;
    const m = meta.get(nameKey(name));
    let closeOn = dayMonYear(cell(ix.close));
    // ipoji writes "01 Jan 2050" when it has no close date. Trust such a row
    // only if the same IPO is in its live IPO table (and take that date).
    if (closeOn && closeOn.getUTCFullYear() > istToday.getUTCFullYear() + 1) {
      if (!m || /listed|closed/i.test(m.status || '') || !m.closeDate) continue;
      const d = m.closeDate.match(/(\d{1,2})\s+([A-Za-z]{3})/);
      if (!d) continue;
      const mon = Object.keys(MONTHS_SHORT).indexOf(d[2].toLowerCase());
      closeOn = new Date(Date.UTC(istToday.getUTCFullYear(), mon, +d[1]));
    }
    if (!closeOn || closeOn.getTime() < today) continue; // bidding over
    const exchanges = norm(badges).toUpperCase().split(' ').filter(Boolean);
    out.push({
      name,
      symbol: '',
      total: xTimes(cell(ix.total)),
      qib: xTimes(cell(ix.qib)),
      shni: xTimes(cell(ix.shni)),
      bhni: xTimes(cell(ix.bhni)),
      nii: xTimes(cell(ix.nii)),
      rii: xTimes(cell(ix.rii)),
      ipoSize: cell(ix.size).replace(/\bCrs\b/i, 'Cr'),
      price: m ? m.price : '',
      closeDate: `${closeOn.getUTCDate()} ${Object.values(MONTHS_SHORT)[closeOn.getUTCMonth()]}`,
      type: m ? m.type : exchanges.length === 1 ? 'SME' : 'Mainboard',
      url: IPOJI_SUB_URL,
    });
  }
  if (!parsed) throw new Error('ipoji subscription: 0 rows parsed');
  return out; // [] = no IPO open for bidding right now (allowEmpty)
}

// "27-Jul-2026" -> "27 Jul" (same short form the ipowatch feeds produce).
const nseDate = (raw) => {
  const m = norm(raw).match(/^(\d{1,2})-([A-Za-z]{3})/);
  return m ? `${m[1]} ${MONTHS_SHORT[m[2].toLowerCase()] || m[2]}` : norm(raw);
};

const sharesLabel = (v) => {
  const n = Number(norm(v));
  return isFinite(n) && n > 0 ? `${n.toLocaleString('en-IN')} shares` : norm(v);
};

// Upcoming mainboard/SME issues (backup for the ipowatch upcoming feeds).
async function nseUpcoming(category) {
  const arr = await nseGet(`all-upcoming-issues?category=${category}`);
  if (!Array.isArray(arr)) throw new Error('nse: unexpected all-upcoming-issues response');
  // Empty = nothing scheduled right now (see allowEmpty on the upcoming feeds).
  if (!arr.length) return [];
  return arr.map((r) => ({
    title: norm(r.companyName) || norm(r.symbol),
    openDate: nseDate(r.issueStartDate),
    closeDate: nseDate(r.issueEndDate),
    size: sharesLabel(r.issueSize),
    priceBand: norm(r.issuePrice).replace(/Rs\.?\s*/gi, '₹'),
    type: seriesType(r.series),
    url: '',
  }));
}

async function nseBulk() {
  const data = await nseGet('snapshot-capital-market-largedeal');
  const arr = (data && data.BULK_DEALS_DATA) || [];
  if (!arr.length) throw new Error('nse bulk: no data');
  return arr.slice(0, 80).map((r) => ({
    symbol: norm(r.symbol),
    name: norm(r.name),
    clientName: norm(r.clientName),
    buySell: norm(r.buySell),
    qty: norm(r.qty),
    price: norm(r.watp),
    date: norm(r.date),
  }));
}

// Bulk deals from Trendlyne's server-rendered table (primary since NSE's API
// started resetting connections from cloud runners, 25–26 Nov 2026).
// Columns: Stock | Client Name | Exchange | Deal Type | Action | Date |
//          Avg. Price | Quantity | Intraday | % Traded
// Kept to what the NSE source returned: NSE *bulk* deals of the latest trading
// day, up to 80. The stock cell carries the name in data-export and the NSE
// symbol in its link (/bulk-block-deals/<SYMBOL>/<id>/...).
async function trendlyneBulk() {
  const $ = await getHtml('https://trendlyne.com/portfolio/bulk-block-deals/');
  const table = findTable($, ['client', 'deal', 'quantity']);
  if (!table) throw new Error('trendlyne bulk: no table');
  const rows = [];
  $(table)
    .find('tr')
    .slice(1)
    .each((_, tr) => {
      const td = $(tr).find('td').toArray();
      if (td.length < 8) return;
      const t = (i) => norm($(td[i]).text());
      const link = $(td[0]).find('a').first().attr('href') || '';
      const sym = (link.match(/bulk-block-deals\/([^/]+)\//) || [])[1] || '';
      const d = t(5).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
      rows.push({
        symbol: norm(sym),
        name: norm($(td[0]).attr('data-export')) || norm($(td[0]).find('a').first().text()),
        clientName: t(1),
        exchange: t(2).toUpperCase(),
        dealType: t(3).toLowerCase(),
        buySell: /sell/i.test(t(4)) ? 'SELL' : 'BUY',
        qty: t(7).replace(/,/g, ''),
        price: t(6),
        date: d ? `${d[1].padStart(2, '0')}-${MONTHS_SHORT[d[2].toLowerCase()] || d[2]}-${d[3]}` : t(5),
      });
    });
  const bulk = rows.filter((r) => r.exchange === 'NSE' && r.dealType === 'bulk' && r.name);
  if (!bulk.length) throw new Error('trendlyne bulk: 0 NSE bulk rows');
  const when = (s) => Date.parse(s.replace(/-/g, ' ')) || 0; // "25-Nov-2026"
  const latest = bulk.reduce((a, r) => (when(r.date) > when(a) ? r.date : a), bulk[0].date);
  return bulk
    .filter((r) => r.date === latest)
    .slice(0, 80)
    .map(({ exchange, dealType, ...r }) => r);
}

// ---------------------------------------------------------------------------
// Market indices (NSE allIndices) for the Market Pulse strip
// ---------------------------------------------------------------------------
const INDEX_ORDER = [
  'NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100', 'NIFTY IT', 'INDIA VIX',
];
const fmtNum = (v) => {
  const d = Number(v);
  return isFinite(d)
    ? d.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : norm(v);
};
const fmtSigned = (v) => {
  const d = Number(v);
  return isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(2)}` : norm(v);
};
async function nseIndices() {
  const data = await nseGet('allIndices');
  const arr = (data && data.data) || [];
  if (!arr.length) throw new Error('nse indices: no data');
  const found = {};
  for (const r of arr) {
    const name = norm(r.index);
    if (INDEX_ORDER.includes(name)) {
      found[name] = {
        name,
        last: fmtNum(r.last),
        change: fmtSigned(r.variation),
        percentChange: `${fmtSigned(r.percentChange)}%`,
      };
    }
  }
  return INDEX_ORDER.filter((n) => found[n]).map((n) => found[n]);
}

// Same six indices from Yahoo Finance's public chart API (primary since NSE's
// API started resetting connections from cloud runners, 25–26 Nov 2026).
// Yahoo's meta "previous close" is unreliable around holidays (it returned
// the close from two sessions back), so the change is computed from the last
// two DAILY candles instead.
const YAHOO_INDEX = {
  'NIFTY 50': '^NSEI',
  'NIFTY BANK': '^NSEBANK',
  'NIFTY NEXT 50': '^NSMIDCP',
  'NIFTY MIDCAP 100': 'NIFTY_MIDCAP_100.NS',
  'NIFTY IT': '^CNXIT',
  'INDIA VIX': '^INDIAVIX',
};

async function yahooIndices() {
  const out = [];
  for (const name of INDEX_ORDER) {
    const sym = YAHOO_INDEX[name];
    if (!sym) continue;
    try {
      const data = await getJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
      );
      const r = data && data.chart && data.chart.result && data.chart.result[0];
      if (!r) continue;
      const closes = (r.indicators?.quote?.[0]?.close || []).filter((c) => isFinite(c) && c > 0);
      const price = Number(r.meta?.regularMarketPrice);
      if (!isFinite(price) || closes.length < 1) continue;
      // If today's candle is already in the list, yesterday is one before it.
      // Some symbols (NIFTY_MIDCAP_100.NS) keep only today's candle; then the
      // close just before the range — chartPreviousClose — is yesterday's.
      const last = closes[closes.length - 1];
      let prev = Math.abs(last - price) < price * 1e-6 ? closes[closes.length - 2] : last;
      if (closes.length === 1 && Math.abs(last - price) < price * 1e-6) {
        prev = Number(r.meta?.chartPreviousClose);
      }
      if (!isFinite(prev) || !prev) continue;
      const change = price - prev;
      out.push({
        name,
        last: fmtNum(price),
        change: fmtSigned(change),
        percentChange: `${fmtSigned((change / prev) * 100)}%`,
      });
    } catch (_) {
      /* one index failing must not drop the others */
    }
    await sleep(150);
  }
  if (out.length < 3) throw new Error(`yahoo indices: only ${out.length} of 6`);
  return out;
}

// Recently listed IPOs from ipoji's listed pages (mainboard + SME).
//
// The listing feed's source now. ipowatch's /ipo-listing/ redirects to a 2025
// archive (so it served last year's IPOs even when reachable), and its
// Cloudflare rejects GitHub's runners with 403. ipoji is self-hosted (nginx),
// reachable from the runners, and current. Each card carries a line like
// "Listing Price: ₹335.0 at a Premium of 23.62%" (or "Discount of 2.27%").
async function ipojiListed() {
  const out = [];
  for (const url of [
    'https://ipoji.com/ipo/listed-ipo',
    'https://ipoji.com/sme-ipo/listed-ipo',
  ]) {
    const $ = await getHtml(url);
    $('article.ipo-card').each((_, card) => {
      const c = $(card);
      const name = norm(c.find('.ipo-card-name').first().text());
      const lp = norm(c.text()).match(
        /Listing Price\s*:\s*₹?\s*([\d,.]+)\s*at a (Premium|Discount|Par)(?: of\s*([\d.]+)\s*%)?/i,
      );
      if (!name || !lp) return; // not listed yet — no listing price to report
      const stat = (label) => {
        let v = '';
        c.find('.ipo-card-body-stat').each((_, s) => {
          if (norm($(s).find('.ipo-card-secondary-label').text()).toLowerCase() === label) {
            v = norm($(s).find('.ipo-card-body-value').text());
          }
        });
        return v;
      };
      const dates = c.find('.ipo-card-date time').toArray().map((t) => norm($(t).text()));
      // "₹258-271" -> "₹258 to ₹271", the shape the app and calendar expect.
      const band = stat('offer price').replace(/^₹?\s*([\d,.]+)\s*[-–]\s*([\d,.]+)$/, '₹$1 to ₹$2');
      const pct = lp[3] ? `${/discount/i.test(lp[2]) ? '-' : ''}${lp[3]}%` : '0%';
      out.push({
        name,
        openDate: dates[0] || '',
        closeDate: dates[1] || '',
        size: stat('issue size'),
        priceBand: band,
        gmp: '',
        listingPrice: `₹${Number(lp[1].replace(/,/g, ''))}`,
        listingGain: pct,
      });
    });
  }
  if (!out.length) throw new Error('ipoji listed: no rows');
  return out;
}

// Broker/analyst IPO reviews from chittorgarh's report API (mainboard + SME).
//
// Backup for ipo_reviews while ipowatch blocks the runners. Each IPO lists
// named reviewers with a verdict ("Capital Market - May apply"); we publish
// the majority verdict, Capital Market's own call (the app's "CM Rating"), and
// who reviewed it — always credited to the reviewers, never presented as ours.
const VERDICT = [
  [/^(avoid|do not|don't|not)/i, 'Avoid'],
  [/^may/i, 'May Apply'],
  [/neutral|hold/i, 'Neutral'],
  [/^(apply|subscribe|must)/i, 'Apply'],
];

async function chittorgarhReviews() {
  const now = new Date();
  const y = now.getFullYear();
  // Indian financial year: Apr 2026–Mar 2027 is "2026-27".
  const fyStart = now.getMonth() >= 3 ? y : y - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const out = [];
  for (const board of ['mainboard', 'sme']) {
    const data = await getJson(
      `https://webnodejs.chittorgarh.com/cloud/report/data-read/73/1/10/${y}/${fy}/0/${board}/0?search=`,
      { Referer: 'https://www.chittorgarh.com/' },
    );
    for (const r of (data && data.reportTableData) || []) {
      const $ = load(r.Reviews || '');
      const reviews = $('li')
        .toArray()
        .map((li) => {
          const [by, call] = norm($(li).text()).split(/\s+-\s+(?=[^-]*$)/);
          return { by: norm(by), call: norm(call) };
        })
        .filter((v) => v.by && v.call);
      if (!reviews.length) continue; // no analyst has reviewed it yet

      const tally = {};
      for (const v of reviews) {
        const label = (VERDICT.find(([re]) => re.test(v.call)) || [null, 'Neutral'])[1];
        tally[label] = (tally[label] || 0) + 1;
      }
      const [top] = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const cm = reviews.find((v) => /capital market/i.test(v.by));
      const slug = norm(r['~URLRewrite_Folder_Name']);
      out.push({
        title: norm(r.Company).replace(/\s+(Ltd\.?|Limited)$/i, ''),
        date: '',
        applyOrNot: `${top[0]} (${top[1]}/${reviews.length} reviewers)`,
        rating: '',
        cmRating: cm ? cm.call : '',
        reviewBy: reviews.map((v) => v.by).join(', '),
        type: norm(r['Issue Type']) || (board === 'sme' ? 'SME' : 'Mainboard'),
        url: slug ? `https://www.chittorgarh.com/ipo/${slug}/${r['~id']}/` : '',
      });
    }
    await sleep(400);
  }
  if (!out.length) throw new Error('chittorgarh reviews: no rows');
  return out;
}

// ---------------------------------------------------------------------------
// IPO calendar (derived feed)
// ---------------------------------------------------------------------------
//
// Built here, in the scheduled job — the app never scrapes for it. It reuses
// the rows the other feeds already fetched and adds exactly ONE extra request
// (ipowatch's allotment page, which is the only place that publishes real
// allotment dates and the registrar per IPO). Everything else is computed.

const MONTH_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/// Picks the year that puts `m/d` closest to today (handles Dec→Jan).
function nearestYear(m, d, ref = new Date()) {
  const y = ref.getFullYear();
  let best = y;
  let bestGap = Infinity;
  for (const cand of [y - 1, y, y + 1]) {
    const gap = Math.abs(new Date(cand, m - 1, d) - ref);
    if (gap < bestGap) {
      bestGap = gap;
      best = cand;
    }
  }
  return best;
}

/// "4 August 2026" / "4 Aug" / "04-Aug-2026" -> "2026-08-04"
function toIsoDate(raw, ref = new Date()) {
  const s = norm(raw);
  if (!s) return '';
  const m = s.match(/(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,9})\.?(?:\s*[-,\s]\s*(\d{4}))?/);
  if (!m) return '';
  const day = Number(m[1]);
  const mon = MONTH_NUM[m[2].slice(0, 3).toLowerCase()];
  if (!mon || day < 1 || day > 31) return '';
  const year = m[3] ? Number(m[3]) : nearestYear(mon, day, ref);
  return iso(year, mon, day);
}

/// ipowatch writes ranges as "12-16 June" (same month) or "30-3 August"
/// (spills over from the previous month). Returns ISO {open, close}.
function toIsoRange(raw, ref = new Date()) {
  const s = norm(raw);
  const m = s.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(\d{4})?$/);
  if (!m) {
    const one = toIsoDate(s, ref);
    return { open: one, close: one };
  }
  const [d1, d2] = [Number(m[1]), Number(m[2])];
  const closeMon = MONTH_NUM[m[3].slice(0, 3).toLowerCase()];
  if (!closeMon) return { open: '', close: '' };
  const closeYear = m[4] ? Number(m[4]) : nearestYear(closeMon, d2, ref);

  // d1 > d2 means the open date belongs to the previous month.
  const openMon = d1 > d2 ? (closeMon === 1 ? 12 : closeMon - 1) : closeMon;
  const openYear = d1 > d2 && closeMon === 1 ? closeYear - 1 : closeYear;
  return { open: iso(openYear, openMon, d1), close: iso(closeYear, closeMon, d2) };
}

const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

/// Adds working days to an ISO date (allotment/listing never land on a weekend).
function addWorkingDays(isoDate, days) {
  if (!isoDate) return '';
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(d)) return '';
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(new Date(d.toISOString().slice(0, 10) + 'T12:00:00'))) added++;
  }
  return d.toISOString().slice(0, 10);
}

/// Collapses the naming variants our sources use for the same issue:
/// "Cube Highways Trust InvIT" vs "Cube Highways Trust", or
/// "Shree Balaji (Mala) Textiles" vs "Shree Balaji Textiles".
const nameKey = (s) =>
  norm(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop parenthetical qualifiers
    .replace(/\b(ipo|limited|ltd|pvt|private|invit|reit|sme|nse|bse|india)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');

/// Feeds hand us open/close as separate strings with no year, so each can land
/// on a different year around the Dec→Jan boundary (we saw open 2026-01-31
/// paired with close 2027-01-02). Resolve them as a pair: close must follow
/// open, and a bidding window is days, not months.
function resolvePair(openRaw, closeRaw, ref = new Date()) {
  let open = toIsoDate(openRaw, ref);
  let close = toIsoDate(closeRaw, ref);
  if (!open || !close) return { open, close };

  if (close < open) {
    // Close slipped into the wrong year — pull it back to just after open.
    const c = new Date(`${close}T00:00:00Z`);
    c.setUTCFullYear(c.getUTCFullYear() + 1);
    const bumped = c.toISOString().slice(0, 10);
    close = bumped > open ? bumped : close;
  }
  const spanDays =
    (new Date(`${close}T00:00:00Z`) - new Date(`${open}T00:00:00Z`)) / 86400000;
  // Anything wider than a month isn't a real bidding window — trust neither.
  if (spanDays < 0 || spanDays > 31) return { open: '', close: '' };
  return { open, close };
}

/// ipowatch's allotment page: IPO | IPO Date | Allotment Date | Registrar.
/// The only public table carrying real allotment dates + the registrar.
async function ipowatchAllotmentDates() {
  const $ = await getHtml('https://ipowatch.in/ipo-allotment-status-how-to-check/');
  const out = [];
  $('table').each((_, t) => {
    const rows = $(t).find('tr').toArray();
    if (rows.length < 2) return;
    const head = norm($(rows[0]).text()).toLowerCase();
    if (!head.includes('allotment')) return;
    for (const row of rows.slice(1)) {
      const cells = $(row).find('td').toArray().map((e) => norm($(e).text()));
      if (cells.length < 3) continue;
      const [name, dateRange, allotDate, registrar] = cells;
      if (!name || /^ipo$/i.test(name)) continue;
      const range = toIsoRange(dateRange);
      out.push({
        name,
        open: range.open,
        close: range.close,
        allotment: toIsoDate(allotDate),
        registrar: norm(registrar || ''),
      });
    }
  });
  return out;
}

/// Merges everything we know into one dated timeline.
async function buildCalendar(collected) {
  const byKey = new Map();

  const upsert = (name, patch) => {
    const k = nameKey(name);
    if (!k) return;
    const cur = byKey.get(k) || { name: norm(name) };
    // Keep the longest name we've seen — it's usually the most complete.
    if (norm(name).length > (cur.name || '').length) cur.name = norm(name);
    for (const [f, v] of Object.entries(patch)) {
      if (v !== '' && v != null && !cur[f]) cur[f] = v;
    }
    byKey.set(k, cur);
  };

  // 1. Live GMP board — open/close/type/gmp for everything currently in play.
  for (const r of collected.gmp || []) {
    const { open, close } = resolvePair(r.openDate, r.closeDate);
    upsert(r.title, {
      type: r.type,
      open,
      close,
      gmp: r.gmp,
      gain: r.gain,
      priceBand: r.price,
    });
  }

  // 2. Upcoming lists — dates and price bands for issues not yet open.
  for (const feed of ['upcoming_mainboard', 'upcoming_sme']) {
    for (const r of collected[feed] || []) {
      const { open, close } = resolvePair(r.openDate, r.closeDate);
      upsert(r.title, {
        type: r.type,
        open,
        close,
        priceBand: r.priceBand,
        size: r.size,
      });
    }
  }

  // 3. Real allotment dates + registrar (one extra request).
  try {
    for (const r of await ipowatchAllotmentDates()) {
      upsert(r.name, {
        open: r.open,
        close: r.close,
        allotment: r.allotment,
        registrar: r.registrar,
      });
    }
  } catch (e) {
    console.log(`   · calendar/allotment-dates: ${e.message}`);
  }

  // 4. Already listed — a real listing date beats a computed one.
  for (const r of collected.listing || []) {
    upsert(r.name, {
      listingGain: r.listingGain,
      listingPrice: r.listingPrice,
      listed: true,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  // A calendar is about what's next. Keep listed IPOs only while they're still
  // interesting (recent listing gains), instead of trailing years of history.
  const historyCutoff = new Date(Date.now() - 45 * 86400000)
    .toISOString()
    .slice(0, 10);

  const out = [];
  for (const item of byKey.values()) {
    if (!item.open && !item.close) continue; // undated — nothing to show
    const close = item.close || item.open;
    const allotment = item.allotment || addWorkingDays(close, 2);
    const listing = item.listing || addWorkingDays(close, 3);

    let status = 'upcoming';
    if (item.listed || (listing && listing < today)) status = 'listed';
    else if (listing === today) status = 'listing';
    else if (allotment && allotment <= today) status = 'allotment';
    else if (close && close < today) status = 'closed';
    else if (item.open && item.open <= today) status = 'open';

    if (status === 'listed' && (listing || close) < historyCutoff) continue;

    out.push({
      name: item.name,
      type: item.type || 'Mainboard',
      open: item.open || '',
      close: close || '',
      allotment: allotment || '',
      listing: listing || '',
      priceBand: item.priceBand || '',
      size: item.size || '',
      gmp: item.gmp || '',
      gain: item.gain || '',
      registrar: item.registrar || '',
      listingGain: item.listingGain || '',
      status,
    });
  }

  // Soonest first, with anything already listed pushed to the end.
  const rank = { open: 0, allotment: 1, listing: 2, upcoming: 3, closed: 4, listed: 5 };
  out.sort((a, b) => {
    const r = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    return r !== 0 ? r : (a.open || a.close).localeCompare(b.open || b.close);
  });
  if (!out.length) throw new Error('calendar: nothing to build');
  return out;
}

// ---------------------------------------------------------------------------
// Market / IPO news — aggregated from publisher RSS feeds (syndication-safe)
// ---------------------------------------------------------------------------
const RSS_FEEDS = [
  ['Economic Times', 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'],
  ['Moneycontrol', 'https://www.moneycontrol.com/rss/business.xml'],
  ['Livemint', 'https://www.livemint.com/rss/markets'],
  ['Business Standard', 'https://www.business-standard.com/rss/markets-106.rss'],
];
async function marketNews() {
  const all = [];
  for (const [source, url] of RSS_FEEDS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/rss+xml' },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const $ = load(await res.text(), { xmlMode: true });
      $('item').each((_, it) => {
        const title = norm($(it).find('title').first().text());
        const link = norm($(it).find('link').first().text());
        if (!title || !link) return;
        let desc = norm(load(`<x>${$(it).find('description').first().text()}</x>`).text());
        if (desc.length > 220) desc = `${desc.slice(0, 220).trim()}…`;
        const image =
          $(it).find('enclosure').attr('url') ||
          $(it).find('media\\:content').attr('url') ||
          '';
        const pub = $(it).find('pubDate').first().text();
        const d = new Date(pub);
        all.push({
          title,
          summary: desc,
          source,
          url: link,
          image,
          publishedAt: isNaN(d.getTime()) ? '' : d.toISOString(),
        });
      });
    } catch (_) {
      /* skip feed */
    }
  }
  all.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const seen = new Set();
  const out = [];
  for (const a of all) {
    const k = a.title.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  if (!out.length) throw new Error('news: no items');
  return out.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Sources per feed (ordered: primary first, then backups)
// ---------------------------------------------------------------------------

const FEATURES = [
  {
    name: 'gmp',
    sources: [
      { name: 'ipowatch', run: () => ipowatchApiGmp() },
      { name: 'ipoji', run: () => ipojiGmp() },
    ],
  },
  {
    name: 'upcoming_mainboard',
    // Empty is valid: some weeks have no upcoming mainboard IPO. ipoji's table
    // must still parse (scrapeTable throws on a missing or empty table), so a
    // genuinely broken source is still reported.
    allowEmpty: true,
    sources: [
      { name: 'ipowatch', run: () => ipowatchApiUpcoming(false) },
      { name: 'nse', run: () => nseUpcoming('ipo') },
      { name: 'ipoji', run: () => ipojiUpcoming(false) },
    ],
  },
  {
    name: 'upcoming_sme',
    // Empty is valid: some weeks have no upcoming SME IPO at all — Nov 8-12
    // 2026 failed 13 runs for exactly that reason. ipoji's table must still
    // parse, so a broken source is still reported.
    allowEmpty: true,
    sources: [
      { name: 'ipowatch', run: () => ipowatchApiUpcoming(true) },
      { name: 'ipoji', run: () => ipojiUpcoming(true) },
    ],
  },
  {
    name: 'ipo_reviews',
    sources: [
      {
        name: 'ipowatch',
        run: async () => {
          const rows = await scrapeTable(
            'https://ipowatch.in/ipo-review/',
            ['review'],
            {
              title: ['ipo', 'company', 'name'],
              date: ['ipo date', 'date'],
              applyOrNot: ['ipo review', 'review'],
              rating: ['ipo rating', 'rating'],
              cmRating: ['cm rating'],
            },
            'title',
          );
          return rows.map((r) => ({ ...r, url: absIpowatch(r.url) }));
        },
      },
      // ipowatch's Cloudflare rejects GitHub's runners (HTTP 403); this keeps
      // the feed alive with credited broker verdicts until it lets them back.
      { name: 'chittorgarh', run: () => chittorgarhReviews() },
    ],
  },
  {
    name: 'stocks_today',
    sources: [{ name: '5paisa', run: () => paisa5(
      'https://www.5paisa.com/share-market-today/stocks-to-buy-or-sell-today',
      ['cmp', 'action'],
      {
        stockName: ['stock', 'company', 'name'],
        cmp: ['cmp', 'ltp', 'price'],
        mcap: ['mcap', 'market cap', 'm cap'],
        change: ['change', 'chg', '%'],
        pe: ['pe', 'p/e'],
        action: ['action', 'call', 'signal'],
      },
    ) }],
  },
  {
    name: 'penny',
    sources: [{ name: '5paisa', run: () => paisa5(
      'https://www.5paisa.com/share-market-today/penny-stocks',
      ['ltp', 'volume'],
      {
        companyName: ['company', 'stock', 'name'],
        ltp: ['ltp', 'cmp', 'price'],
        change: ['% change', 'change', '%'],
        volume: ['volume', 'vol'],
        marketCap: ['market cap', 'mcap'],
      },
    ) }],
  },
  {
    name: 'intraday',
    sources: [{ name: '5paisa', run: () => paisa5(
      'https://www.5paisa.com/share-market-today/intraday-stocks',
      ['cmp', 'volume'],
      {
        stock: ['stock', 'company', 'name'],
        volume: ['volume', 'vol'],
        cmp: ['cmp', 'ltp', 'price'],
        dayLow: ["day's low", 'low'],
        dayHigh: ["day's high", 'high'],
      },
    ) }],
  },
  {
    name: 'gainers',
    sources: [
      { name: '5paisa', run: () => paisaMovers('https://www.5paisa.com/share-market-today/top-gainers') },
      { name: 'nse', run: () => nseMovers('gainers') },
    ],
  },
  {
    name: 'losers',
    sources: [
      { name: '5paisa', run: () => paisaMovers('https://www.5paisa.com/share-market-today/top-losers') },
      { name: 'nse', run: () => nseMovers('loosers') },
    ],
  },
  {
    name: 'week52_high',
    sources: [
      { name: '5paisa', run: () => paisa52('https://www.5paisa.com/share-market-today/52-week-high') },
      { name: 'nse', run: () => nse52('high') },
    ],
  },
  {
    name: 'week52_low',
    sources: [
      { name: '5paisa', run: () => paisa52('https://www.5paisa.com/share-market-today/52-week-low') },
      { name: 'nse', run: () => nse52('low') },
    ],
  },
  {
    name: 'bulk_deals',
    // Trendlyne first: NSE's API resets connections from cloud runners (since
    // 25–26 Nov 2026). NSE stays as the backup in case it comes back.
    sources: [
      { name: 'trendlyne', run: () => trendlyneBulk() },
      { name: 'nse', run: () => nseBulk() },
    ],
  },
  {
    name: 'subscription',
    // An empty result is valid for this feed: it means no IPO is open for
    // bidding right now (a routine gap between issues), not a broken source.
    // See nseSubscription() and runFeature().
    allowEmpty: true,
    // ipoji first: NSE's API resets connections from cloud runners (since
    // 25–26 Nov 2026). NSE stays as the backup in case it comes back.
    sources: [
      { name: 'ipoji', run: () => ipojiSubscription() },
      { name: 'nse', run: () => nseSubscription() },
    ],
  },
  {
    name: 'indices',
    // Yahoo first: NSE's API resets connections from cloud runners (since
    // 25–26 Nov 2026). NSE stays as the backup in case it comes back.
    sources: [
      { name: 'yahoo', run: () => yahooIndices() },
      { name: 'nse', run: () => nseIndices() },
    ],
  },
  {
    name: 'listing',
    // ipoji first: it has open/close dates. ipowatch's API backs it up (its
    // listing history has prices but no dates). ipowatch's old /ipo-listing/
    // HTML page redirects to a 2025 archive, so it is not used at all.
    sources: [
      { name: 'ipoji', run: () => ipojiListed() },
      { name: 'ipowatch', run: () => ipowatchApiListed() },
    ],
  },
  {
    name: 'news',
    sources: [{ name: 'rss', run: () => marketNews() }],
  },
];

// Helper source builders -----------------------------------------------------

// ipowatch's JSON API ------------------------------------------------------
//
// ipowatch rebuilt its site (Next.js) in Nov 2026: the GMP and upcoming pages
// now render their tables in the browser, so the static HTML has no <table>
// ("no table"). These are the same endpoints the site's own components call.
// The trailing slash matters — without it the API answers 308.
async function ipowatchApi(name) {
  const j = await getJson(`https://ipowatch.in/api/ipo/${name}/`, {
    Referer: 'https://ipowatch.in/',
  });
  const rows =
    j && (Array.isArray(j.data) ? j.data : Array.isArray(j.result) ? j.result : null);
  if (!j || j.status !== 1 || !rows) {
    throw new Error(`ipowatch api ${name}: unexpected response`);
  }
  return rows;
}

// "NSE Emerge" -> "NSE SME": the app spots SME issues by "sme" in the type.
const ipwType = (t) => (/emerge/i.test(norm(t)) ? 'NSE SME' : norm(t) || 'Mainboard');
// "18 Nov 2026" -> "18 Nov" (the short form every other feed uses).
const ipwDay = (s) => {
  const m = norm(s).match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  return m ? `${m[1]} ${m[2]}` : norm(s);
};
// "₹259.00 - ₹272.00" -> "₹259-272". Not announced yet ("₹0", "TBA") -> ''
// so the app shows "—" instead of doing GMP maths against a zero price.
const ipwBand = (s) => {
  const v = norm(s);
  if (!/[1-9]/.test(v)) return '';
  return v
    .replace(/\.00\b/g, '')
    .replace(/^₹?\s*([\d,.]+)\s*[-–]\s*₹?\s*([\d,.]+)$/, '₹$1-$2');
};
// 4557162528 (rupees) -> "₹455.72 Cr"
const ipwCrore = (rupees) => {
  const n = Number(rupees);
  return isFinite(n) && n > 0 ? `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr` : '';
};
const ipwUrl = (slug) => (norm(slug) ? `https://ipowatch.in/${norm(slug)}/` : '');
const ipwNum = (s) => Number(norm(s).replace(/[^\d.-]/g, ''));

// Upcoming / open issues for one board. An empty list is a valid answer
// (no issue scheduled this week) — see allowEmpty on the upcoming feeds.
async function ipowatchApiUpcoming(sme) {
  return (await ipowatchApi('GetIpoListingByStatus'))
    .filter((r) => /sme|emerge/i.test(norm(r.type)) === !!sme)
    .filter((r) => !/closed|listed/i.test(norm(r.issueStatus)))
    .map((r) => ({
      title: norm(r.name),
      openDate: ipwDay(r.openDate),
      closeDate: ipwDay(r.closeDate),
      size: ipwCrore(r.issueSize),
      priceBand: ipwBand(r.priceBand),
      type: ipwType(r.type),
      url: ipwUrl(r.slug),
    }))
    .filter((r) => r.title);
}

// The live GMP board.
async function ipowatchApiGmp() {
  return (await ipowatchApi('GetIpoGMPHistory'))
    .map((r) => {
      const [open = '', close = ''] = norm(r.IPODate).split(/\s*[-–]\s*/);
      // "₹299 (9.93%)" -> "9.93%"
      const pct = (norm(r.estListing).match(/\((-?[\d.]+)\s*%\)/) || [])[1];
      return {
        title: norm(r.ipoName),
        gmp: norm(r.ipoGmp),
        gain: pct ? `${pct}%` : '',
        price: ipwBand(r.priceBand),
        openDate: ipwDay(open),
        closeDate: ipwDay(close),
        type: ipwType(r.Type),
        url: ipwUrl(r.ipo_slug),
      };
    })
    .filter((r) => r.title);
}

// Listed IPOs with listing price (newest first). No dates in this endpoint,
// so it is the backup to ipoji for the listing feed, not the primary.
async function ipowatchApiListed() {
  return (await ipowatchApi('GetIpoListingHistory'))
    .slice(0, 120)
    .map((r) => {
      const issue = ipwNum(r.issuePrice);
      const listed = ipwNum(r.listingPrice);
      return {
        name: norm(r.ipoName),
        openDate: '',
        closeDate: '',
        size: '',
        priceBand: norm(r.issuePrice),
        gmp: norm(r.ipoGmp),
        listingPrice: norm(r.listingPrice),
        listingGain:
          issue > 0 && listed > 0 ? `${(((listed - issue) / issue) * 100).toFixed(2)}%` : '',
      };
    })
    .filter((r) => r.name && r.listingPrice);
}

const paisa5 = (url, kw, cols) => scrapeTable(url, kw, cols);

async function paisaMovers(url) {
  const rows = await scrapeTable(url, ['ltp', 'gain'], {
    name: ['company', 'stock', 'name'],
    ltp: ['ltp', 'cmp', 'price'],
    gainPct: ['gain', 'change', '%'],
    dayLow: ["day's low", 'low'],
    dayHigh: ["day's high", 'high'],
    volume: ['volume', 'vol'],
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runFeature(feature) {
  const errors = [];
  // First source that answered successfully but with nothing in it.
  let empty = null;
  for (const source of feature.sources) {
    try {
      const items = await source.run();
      if (Array.isArray(items) && items.length) {
        return { items, source: source.name, errors };
      }
      // A feature may opt in (allowEmpty) to publishing a legitimately empty
      // result — no IPO open for bidding, no upcoming SME issue this week. It
      // is only used once every source has been tried, so a later source that
      // does have data always beats an earlier, empty one.
      if (Array.isArray(items) && !empty) empty = source.name;
      errors.push(`${source.name}: 0 rows`);
      console.log(`   · ${feature.name}/${source.name}: 0 rows`);
    } catch (e) {
      errors.push(`${source.name}: ${e.message}`);
      console.log(`   · ${feature.name}/${source.name}: ${e.message}`);
    }
  }
  if (feature.allowEmpty && empty) return { items: [], source: empty, errors };
  return { items: null, source: null, errors };
}

/// How stale a kept-previous feed may get before we shout about it (hours).
const STALE_WARN_HOURS = 6;
const STALE_FAIL_HOURS = 48;

/// GMP publishing is PAUSED (owner decision, 26 Nov 2026) after SEBI's
/// advisory of 23 Nov 2026 (PR No. 75/2026) asking that IPO grey market premium
/// figures not be published or circulated. Every feed keeps its shape (old app
/// versions fall back to scraping websites themselves if a feed breaks), but
/// GMP figures and GMP-derived estimates are written as empty strings.
/// Official facts — price band, dates, actual listing price/gain — are kept.
/// To resume, set PUBLISH_GMP = true (only after a fresh legal/policy check).
const PUBLISH_GMP = false;
const GMP_FIELDS_BY_FEED = {
  gmp: ['gmp', 'gain'],          // gain = GMP-based estimated gain
  calendar: ['gmp', 'gain'],     // listingGain (actual, after listing) is kept
  listing: ['gmp'],              // listingPrice / listingGain are official
};

function withoutGmp(feedName, items) {
  if (PUBLISH_GMP) return items;
  const fields = GMP_FIELDS_BY_FEED[feedName];
  if (!fields) return items;
  return items.map((it) => {
    const out = { ...it };
    for (const f of fields) if (f in out) out[f] = '';
    return out;
  });
}

/// Age in hours of the file already on disk, or null if there isn't one.
async function fileAgeHours(file) {
  if (!existsSync(file)) return null;
  try {
    const prev = JSON.parse(await readFile(file, 'utf8'));
    const t = Date.parse(prev.updatedAt);
    return isNaN(t) ? null : (Date.now() - t) / 3600000;
  } catch (_) {
    return null;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // Test hook: FORCE_BACKUP=1 drops each feed's primary source so we exercise
  // the backups (NSE / ipoji). Harmless in production (env unset).
  if (process.env.FORCE_BACKUP) {
    for (const f of FEATURES) if (f.sources.length > 1) f.sources.shift();
  }
  const summary = [];
  const status = {};
  const now = new Date().toISOString();
  let hardFail = false;

  /// Rows of each successful feed, so derived feeds (the calendar) can reuse
  /// them instead of re-fetching the same pages.
  const collected = {};

  const allFeatures = [
    ...FEATURES,
    // Derived — must run last; reads `collected`.
    { name: 'calendar', derived: true, sources: [{ name: 'derived', run: () => buildCalendar(collected) }] },
  ];

  for (const feature of allFeatures) {
    const file = new URL(`./${feature.name}.json`, OUT_DIR);
    const { items, source, errors } = await runFeature(feature);
    if (items) collected[feature.name] = items;

    if (items) {
      await writeFile(
        file,
        JSON.stringify(
          { updatedAt: now, source, count: items.length, items: withoutGmp(feature.name, items) },
          null,
          2,
        ),
      );
      status[feature.name] = { ok: true, source, count: items.length, updatedAt: now };
      const viaBackup = source !== feature.sources[0].name;
      summary.push(
        `✅ ${feature.name}: ${items.length} (via ${source}${viaBackup ? ' — BACKUP' : ''})`,
      );
      if (viaBackup) {
        // Primary is broken but the feed still works — worth knowing before the
        // backup breaks too.
        console.log(
          `::warning title=${feature.name} primary source failed::` +
            `fell back to "${source}". ${errors.join('; ')}`,
        );
      }
      continue;
    }

    // Every source failed — keep the last-good file, but make the age visible.
    const ageH = await fileAgeHours(file);
    const age = ageH == null ? null : Math.round(ageH * 10) / 10;
    status[feature.name] = {
      ok: false,
      source: null,
      staleHours: age,
      errors,
      updatedAt: null,
    };

    if (ageH == null) {
      hardFail = true;
      console.log(
        `::error title=${feature.name} has no data::all sources failed and no previous file exists. ${errors.join('; ')}`,
      );
      summary.push(`❌ ${feature.name}: all sources failed (NO PREVIOUS FILE!)`);
    } else if (ageH >= STALE_FAIL_HOURS) {
      hardFail = true;
      console.log(
        `::error title=${feature.name} is ${age}h stale::all sources failed for over ${STALE_FAIL_HOURS}h. ${errors.join('; ')}`,
      );
      summary.push(`❌ ${feature.name}: all sources failed — data is ${age}h old`);
    } else {
      const level = ageH >= STALE_WARN_HOURS ? 'warning' : 'notice';
      console.log(
        `::${level} title=${feature.name} not updated::all sources failed; serving ${age}h-old data. ${errors.join('; ')}`,
      );
      summary.push(`⚠️  ${feature.name}: all sources failed (kept previous, ${age}h old)`);
    }
  }

  await writeFile(
    new URL('./index.json', OUT_DIR),
    JSON.stringify(
      { updatedAt: now, feeds: allFeatures.map((f) => f.name), status },
      null,
      2,
    ),
  );
  console.log(`\n${summary.join('\n')}`);

  // NOTE: we deliberately exit 0 even when a feed is unusable.
  //
  // Failing here would abort the job *before* the commit step, so one flaky
  // feed would block publishing the other fifteen that scraped perfectly —
  // a brand-new feed failing on its first run could take the whole site down
  // with it. The health check runs after the commit instead (see
  // `npm run check-health` in scrape.yml), so bad news still turns the build
  // red, but only once the good data is safely published.
  if (hardFail) {
    console.log(
      '\n::notice::one or more feeds are unusable — the health check after commit will fail the job',
    );
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
