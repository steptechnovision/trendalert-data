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

| Feed | Primary | Backup |
|------|---------|--------|
| gmp / upcoming_mainboard / upcoming_sme | ipowatch.in | investorgain JSON API |
| gainers / losers | 5paisa | NSE JSON API |
| ipo_reviews / stocks_today / penny / intraday | (5paisa/ipowatch only — no clean equivalent; the app also falls back to scraping on the user's own device) | — |

- First source that returns rows wins.
- If **all** sources fail, the JSON is **left unchanged** (app keeps last-good).
- Test the backups locally: `FORCE_BACKUP=1 npm run scrape` (drops each
  feed's primary so the backups run).

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
