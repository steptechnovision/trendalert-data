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

// Splits an ipowatch-style combined date ("12-16 June", "12 Jun to 16 Jun").
function splitDate(raw) {
  raw = norm(raw);
  if (!raw || raw === 'N/A') return { open: '', close: '' };
  if (/^\d{4}$/.test(raw)) return { open: 'Coming Soon', close: 'Coming Soon' };
  let m = raw.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)/);
  if (m) return { open: `${m[1]} ${m[3]}`, close: `${m[2]} ${m[3]}` };
  const parts = raw.split(/\s*(?:-|–|to)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { open: parts[0], close: parts[1] };
  return { open: raw, close: raw };
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
  if (!Array.isArray(active) || !active.length) {
    throw new Error('nse: no active issues');
  }

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
  if (!Array.isArray(arr) || !arr.length) throw new Error('nse: no upcoming issues');
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

// ---------------------------------------------------------------------------
// Recently listed IPOs with listing price & gain (ipowatch)
// ---------------------------------------------------------------------------
async function ipowatchListings() {
  const $ = await getHtml('https://ipowatch.in/ipo-listing/');
  const table = findTable($, ['listing']);
  if (!table) throw new Error('listings: no table');
  const rows = $(table).find('tr').toArray();
  const headers = $(rows[0])
    .find('td, th')
    .toArray()
    .map((e) => $(e).text().trim().toLowerCase());
  const col = (keys) => {
    for (let i = 0; i < headers.length; i++)
      for (const k of keys) if (headers[i].includes(k)) return i;
    return -1;
  };
  const ci = {
    name: col(['company', 'name']),
    openDate: col(['open']),
    closeDate: col(['close']),
    size: col(['size']),
    priceBand: col(['price band', 'band']),
    gmp: col(['gmp']),
    listingPrice: col(['listing price']),
    listingGain: col(['listing gain', 'gain']),
  };
  const out = [];
  for (const row of rows.slice(1)) {
    const cells = $(row).find('td').toArray();
    if (!cells.length) continue;
    const cell = (c) => (c >= 0 && c < cells.length ? norm($(cells[c]).text()) : '');
    const name = cell(ci.name);
    if (!name || name.toLowerCase() === 'company name') continue;
    out.push({
      name,
      openDate: cell(ci.openDate),
      closeDate: cell(ci.closeDate),
      size: cell(ci.size),
      priceBand: cell(ci.priceBand),
      gmp: cell(ci.gmp),
      listingPrice: cell(ci.listingPrice),
      listingGain: cell(ci.listingGain),
    });
  }
  if (!out.length) throw new Error('listings: no rows');
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
      {
        name: 'ipowatch',
        run: async () => {
          const rows = await scrapeTable(
            'https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/',
            ['gmp'],
            {
              title: ['ipo name', 'company', 'stock', 'ipo'],
              gmp: ['gmp', 'grey market'],
              price: ['price'],
              gain: ['gain'],
              date: ['date'],
              type: ['type'],
            },
            'title',
          );
          return rows.map((r) => {
            const d = splitDate(r.date);
            return {
              title: r.title,
              gmp: r.gmp,
              gain: r.gain,
              price: r.price,
              openDate: d.open,
              closeDate: d.close,
              type: r.type,
              url: absIpowatch(r.url),
            };
          });
        },
      },
      { name: 'ipoji', run: () => ipojiGmp() },
    ],
  },
  {
    name: 'upcoming_mainboard',
    sources: [
      {
        name: 'ipowatch',
        run: () => ipowatchUpcoming('https://ipowatch.in/upcoming-ipo-list/', 'Mainboard'),
      },
      { name: 'nse', run: () => nseUpcoming('ipo') },
      { name: 'ipoji', run: () => ipojiUpcoming(false) },
    ],
  },
  {
    name: 'upcoming_sme',
    sources: [
      {
        name: 'ipowatch',
        run: () => ipowatchUpcoming('https://ipowatch.in/upcoming-sme-ipo-list/', null),
      },
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
    sources: [{ name: 'nse', run: () => nseBulk() }],
  },
  {
    name: 'subscription',
    sources: [{ name: 'nse', run: () => nseSubscription() }],
  },
  {
    name: 'indices',
    sources: [{ name: 'nse', run: () => nseIndices() }],
  },
  {
    name: 'listing',
    sources: [{ name: 'ipowatch', run: () => ipowatchListings() }],
  },
  {
    name: 'news',
    sources: [{ name: 'rss', run: () => marketNews() }],
  },
];

// Helper source builders -----------------------------------------------------

async function ipowatchUpcoming(url, forcedType) {
  const rows = await scrapeTable(
    url,
    ['price band'],
    {
      title: ['company', 'ipo name', 'ipo', 'name'],
      date: ['ipo date', 'date'],
      size: ['ipo size', 'size'],
      priceBand: ['ipo price band', 'price band', 'price'],
      type: ['platform', 'exchange'],
    },
    'title',
  );
  return rows.map((r) => {
    const d = splitDate(r.date);
    return {
      title: r.title,
      openDate: d.open,
      closeDate: d.close,
      size: r.size,
      priceBand: r.priceBand,
      type: forcedType || r.type || 'SME',
      url: absIpowatch(r.url),
    };
  });
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
  for (const source of feature.sources) {
    try {
      const items = await source.run();
      if (Array.isArray(items) && items.length) {
        return { items, source: source.name, errors };
      }
      errors.push(`${source.name}: 0 rows`);
      console.log(`   · ${feature.name}/${source.name}: 0 rows`);
    } catch (e) {
      errors.push(`${source.name}: ${e.message}`);
      console.log(`   · ${feature.name}/${source.name}: ${e.message}`);
    }
  }
  return { items: null, source: null, errors };
}

/// How stale a kept-previous feed may get before we shout about it (hours).
const STALE_WARN_HOURS = 6;
const STALE_FAIL_HOURS = 48;

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

  for (const feature of FEATURES) {
    const file = new URL(`./${feature.name}.json`, OUT_DIR);
    const { items, source, errors } = await runFeature(feature);

    if (items) {
      await writeFile(
        file,
        JSON.stringify(
          { updatedAt: now, source, count: items.length, items },
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
      { updatedAt: now, feeds: FEATURES.map((f) => f.name), status },
      null,
      2,
    ),
  );
  console.log(`\n${summary.join('\n')}`);

  // Exit non-zero only when a feed is genuinely unusable (no data at all, or
  // stale beyond STALE_FAIL_HOURS) — a single flaky scrape shouldn't page you.
  if (hardFail) {
    console.log('\n::error::one or more feeds are unusable — see annotations above');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
