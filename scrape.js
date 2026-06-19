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
import { writeFile, mkdir } from 'node:fs/promises';
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

async function getHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return load(await res.text());
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json', ...headers },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
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
const absInvestorgain = (u) =>
  !u ? '' : u.startsWith('http') ? u : `https://www.investorgain.com${u}`;

// ---------------------------------------------------------------------------
// investorgain JSON API (backup for all IPO feeds)
// ---------------------------------------------------------------------------

async function investorgainReport(reportId, filter) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const fyStart = m >= 4 ? y : y - 1;
  const fy = (s) => `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
  // Try a few year/FY combos for robustness around the financial-year boundary.
  const combos = [
    [y, fy(fyStart)],
    [y, fy(fyStart - 1)],
    [y - 1, fy(fyStart - 1)],
    [y + 1, fy(fyStart)],
  ];
  for (const [cy, f] of combos) {
    try {
      const url = `https://webnodejs.investorgain.com/cloud/report/data-read/${reportId}/1/1/${cy}/${f}/0/${filter}`;
      const data = await getJson(url, {
        Referer: 'https://www.investorgain.com/',
      });
      const rows = data && data.msg === 1 ? data.reportTableData || [] : [];
      if (rows.length) return rows;
    } catch (_) {
      /* try next combo */
    }
  }
  throw new Error(`investorgain ${reportId}: no data for any FY combo`);
}

// investorgain subscription report (333) → category-wise live subscription.
async function investorgainSub() {
  const rows = await investorgainReport(333, 'all');
  return rows
    .map((r) => {
      const $n = load(`<div>${r.Name || ''}</div>`);
      const a = $n('a').first();
      const name =
        norm(a.text()) || norm($n.root().text()).split('  ')[0];
      const badge = norm($n('span').map((_, e) => $n(e).text()).get().join(' '));
      const isSme = /sme/i.test(badge) || /sme/i.test(r.Name || '');
      return {
        name,
        total: firstNum(r.Total),
        qib: norm(r.QIB),
        shni: norm(r.SHNI),
        bhni: norm(r.BHNI),
        nii: norm(r.NII),
        rii: norm(r.RII),
        ipoSize: norm(load(`<x>${r['IPO Size'] || ''}</x>`).text())
          .replace(/^Rs\s*/, '₹'),
        price: norm(r['IPO Price']),
        closeDate: norm(r['Close Date']),
        type: isSme ? 'SME' : 'Mainboard',
        url: absInvestorgain(a.attr('href') || ''),
      };
    })
    .filter((x) => x.name && !/^[-\s]*$/.test(x.name));
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

// Parses one investorgain row into our IPO shape.
function igParse(row) {
  const $n = load(`<div>${row.Name || ''}</div>`);
  const a = $n('a').first();
  const title = norm(a.text()) || norm($n.root().text()).split('  ')[0];
  const url = absInvestorgain(a.attr('href') || '');
  const badge = norm($n('span').map((_, e) => $n(e).text()).get().join(' '));
  const isSme = /sme/i.test(badge) || /sme/i.test(row.Name || '');

  const gmpText = norm(load(`<div>${row.GMP || ''}</div>`).root().text());
  // "₹ 52 (50.49%) ..." -> gmp "₹52", gain "50.49%"
  const gmpNum = firstNum(gmpText.split('(')[0]);
  const pctM = gmpText.match(/\(([-\d.]+)%\)/);
  const gmp = gmpNum && gmpNum !== '0' ? `₹${gmpNum}` : '';
  const gain = pctM ? `${pctM[1]}%` : '';

  const price = firstNum(row['Price (₹)']);
  const cleanDate = (s) => {
    const t = norm(s).match(/^\d{1,2}[- ]?[A-Za-z]{0,9}/);
    return t ? t[0].replace(/\s+$/, '') : '';
  };
  return {
    title,
    gmp,
    gain,
    price: price ? `₹${price}` : '',
    openDate: cleanDate(row.Open),
    closeDate: cleanDate(row.Close),
    size: norm(row['IPO Size']) === '-' ? '' : norm(row['IPO Size']),
    type: isSme ? (badge.includes('NSE') ? 'NSE SME' : 'BSE SME') : 'Mainboard',
    url,
    _sme: isSme,
  };
}

// ---------------------------------------------------------------------------
// NSE gainers/losers JSON API (backup for movers)
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
      {
        name: 'investorgain',
        run: async () => (await investorgainReport(331, 'all')).map(igParse),
      },
    ],
  },
  {
    name: 'upcoming_mainboard',
    sources: [
      {
        name: 'ipowatch',
        run: () => ipowatchUpcoming('https://ipowatch.in/upcoming-ipo-list/', 'Mainboard'),
      },
      {
        name: 'investorgain',
        run: async () =>
          (await investorgainReport(331, 'ipo'))
            .map(igParse)
            .filter((x) => !x._sme)
            .map(toUpcoming),
      },
    ],
  },
  {
    name: 'upcoming_sme',
    sources: [
      {
        name: 'ipowatch',
        run: () => ipowatchUpcoming('https://ipowatch.in/upcoming-sme-ipo-list/', null),
      },
      {
        name: 'investorgain',
        run: async () =>
          (await investorgainReport(331, 'sme')).map(igParse).map(toUpcoming),
      },
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
    sources: [{ name: 'investorgain', run: () => investorgainSub() }],
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

function toUpcoming(x) {
  return {
    title: x.title,
    openDate: x.openDate,
    closeDate: x.closeDate,
    size: x.size,
    priceBand: x.price,
    type: x.type,
    url: x.url,
  };
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
  for (const source of feature.sources) {
    try {
      const items = await source.run();
      if (Array.isArray(items) && items.length) {
        // strip internal helper keys
        const clean = items.map(({ _sme, ...rest }) => rest);
        return { items: clean, source: source.name };
      }
    } catch (e) {
      console.log(`   · ${feature.name}/${source.name}: ${e.message}`);
    }
  }
  return null;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // Test hook: FORCE_BACKUP=1 drops each feed's primary source so we exercise
  // the backups (investorgain / NSE). Harmless in production (env unset).
  if (process.env.FORCE_BACKUP) {
    for (const f of FEATURES) if (f.sources.length > 1) f.sources.shift();
  }
  const summary = [];

  for (const feature of FEATURES) {
    const file = new URL(`./${feature.name}.json`, OUT_DIR);
    const result = await runFeature(feature);
    if (result) {
      await writeFile(
        file,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            source: result.source,
            count: result.items.length,
            items: result.items,
          },
          null,
          2,
        ),
      );
      summary.push(`✅ ${feature.name}: ${result.items.length} (via ${result.source})`);
    } else {
      const kept = existsSync(file) ? 'kept previous' : 'NO PREVIOUS!';
      summary.push(`⚠️  ${feature.name}: all sources failed (${kept})`);
    }
  }

  await writeFile(
    new URL('./index.json', OUT_DIR),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        feeds: FEATURES.map((f) => f.name),
      },
      null,
      2,
    ),
  );
  console.log(summary.join('\n'));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
