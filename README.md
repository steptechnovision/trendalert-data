# TrendAlert data backend (free, GitHub Actions)

Scrapes IPO/stock sources **once** every 20 minutes and publishes parsed JSON to
GitHub's CDN. The app reads these cached JSON files instead of every phone
scraping the sites — so only this one GitHub job ever touches the sources.

**Cost: $0 forever.** GitHub Actions is free & unlimited on public repos; GitHub
Pages serves the JSON over a CDN for free.

## What it produces

`docs/data/*.json` — one file per feed, each shaped like:

```json
{ "updatedAt": "2026-06-10T12:00:00Z", "count": 8, "items": [ { ...fields... } ] }
```

Feeds: `gmp`, `upcoming_mainboard`, `upcoming_sme`, `ipo_reviews`,
`stocks_today`, `penny`, `intraday`, `gainers`, `losers` (+ `index.json`).
Each JSON includes a `"source"` field naming which site the data came from.

## Multi-source fallback (resilience)

Each feed tries multiple sources **in order** — if a primary site blocks our IP
or changes layout, the backup keeps the app working with **no app update**:

| Feed | Primary | Backups |
|------|---------|---------|
| gmp | ipowatch.in | ipoji.com |
| upcoming_mainboard | ipowatch.in | NSE `all-upcoming-issues` → ipoji.com |
| upcoming_sme | ipowatch.in | ipoji.com |
| gainers / losers | 5paisa | NSE `live-analysis-variations` |
| week52_high / week52_low | 5paisa | NSE `live-analysis-data-52week*` |
| subscription | NSE `ipo-current-issue` + `ipo-active-category` | — |
| bulk_deals / indices | NSE | — |
| listing | ipowatch.in | — |
| news | publisher RSS (ET, Moneycontrol, Livemint, Business Standard) | — |
| ipo_reviews / stocks_today / penny / intraday | ipowatch / 5paisa (no clean equivalent; the app also falls back to scraping on the user's own device) | — |

- First source that returns rows wins; the winner is recorded in the JSON's
  `"source"` field.
- If **all** sources fail, the JSON is **left unchanged** (app keeps last-good).
- Test the backups locally: `FORCE_BACKUP=1 npm run scrape` (drops each
  feed's primary so the backups run).

> **Note — investorgain was removed (July 2026).** Its report API
> (`webnodejs.investorgain.com/cloud/report/data-read/...`) was retired and now
> answers every request with `{"msg":"API not found"}`; the site renders its
> tables with JavaScript, so it can't be scraped statically either. It used to
> be the *only* source for `subscription`, which silently served stale data for
> 16 days before this was caught — hence the staleness alerting below.

## Knowing when a feed breaks

Silent staleness was the real failure mode, so the job now reports it:

- `docs/data/index.json` carries a **`status`** block — per feed: `ok`, which
  source won, row count, and `staleHours` + the per-source error messages when
  everything failed. Open it to see health at a glance.
- Every run emits GitHub **annotations**: a warning when a feed had to fall back
  to a backup (primary is broken — fix it before the backup breaks too), and
  when a feed couldn't refresh at all.
- The job **fails** (red ❌) only when a feed is genuinely unusable: no data file
  at all, or all sources failing for more than **48h** (`STALE_FAIL_HOURS` in
  `scrape.js`). One flaky scrape won't page you; a dead source will.

## One-time setup (≈5 minutes)

1. Create a **new PUBLIC** GitHub repo (e.g. `trendalert-data`). Public is
   required for unlimited free Actions minutes — keep NO secrets here.
2. Copy everything in this `backend/` folder to that repo's **root** and push:
   `scrape.js`, `package.json`, `.github/workflows/scrape.yml`.
3. Repo → **Settings → Actions → General → Workflow permissions** →
   "Read and write permissions" → Save. (Lets the job commit the data.)
4. Repo → **Actions** tab → run **"Scrape data"** once manually
   (workflow_dispatch). It creates `docs/data/*.json`.
5. Repo → **Settings → Pages** → Source: "Deploy from a branch" →
   Branch: `main` / folder: **`/docs`** → Save.
6. Your data base URL is:
   `https://<your-username>.github.io/<repo>/data/`
   e.g. open `…/data/gmp.json` in a browser to confirm.

## Wire the app

Put that base URL in **Firebase Remote Config** under key
**`stock_data_base_url`** (the app reads it; there's also a hardcoded default in
`lib/network/data_feed.dart`). If a source ever breaks or you want to swap it,
edit `scrape.js` here — no app update needed.

## Run locally

```bash
npm install
npm run scrape      # writes docs/data/*.json
```

## Re-running a run in the Actions tab

Safe to do. The commit step pushes with `git push origin HEAD:main` and, if the
push is rejected, rebases onto the current `origin/main` and retries (3×).

That matters because **re-running an old run checks out that run's original
commit** — so without the rebase the push is a non-fast-forward and the job goes
red even though the scrape succeeded. (That was the failure on run #171.)
`fetch-depth: 0` on checkout exists for the same reason — a shallow clone
can't rebase.
