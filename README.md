# Rack Rate

An independent, unofficial web tool to look up **live David Lloyd membership prices** for any club — every plan, every membership type, every duration.

👉 **[Open it](https://dylnyko.github.io/davidlloyd-price-index/)**

## What it does

Search for a club (or find the ones nearest you) and the page pulls its current **standard** membership rates — monthly fee, joining fee, plan benefits and the other clubs each membership lets you into — straight from David Lloyd's public pricing service, laid out in a clean price table.

- **Clubs near me** — enter a postcode or use your location to rank clubs by real distance (remembered in the URL).
- **Club profile** — opening hours, phone, racquet courts and facility badges (pool, spa, adults-only) from the club record.
- **Live promotions** — the current joining-fee offers, shown on the plans they actually apply to.
- **Compare** — put up to three clubs' prices side by side, cheapest per plan highlighted.
- **National price league** — every club ranked cheapest-to-priciest for the plan/type/term you choose, scoped by currency (£ UK / € Europe & Ireland / Fr Switzerland).
- **Facilities league** — clubs ranked by racquet courts (total or per sport).
- **Price map** — every club pinned and coloured green→red by price, on free OpenStreetMap tiles.
- **Biggest movers / trends** — price changes flagged as the nightly history builds up (e.g. "▲ £10 since 1 Mar").
- **Share** — export the current price table as an image, or copy a per-club link.

Everything is deep-linkable and shareable — each club, league metric, map and comparison lives in the URL.

## Fully self-updating

Nothing is hardcoded:

- **Clubs, plans, membership types and durations** all come from David Lloyd's own responses (via the nightly snapshot), so new clubs and new tiers appear automatically with no code changes.

It's a single static page (HTML/CSS/JS) with no backend. The club list, prices, profiles, offers, club-access lists, facilities and coordinates are all served from a nightly snapshot committed to this repo (see below), so a normal visit makes **no requests to David Lloyd at all** — the live endpoints are only a fallback for a brand-new club not yet in the snapshot. Postcode geocoding uses the free, open [postcodes.io](https://postcodes.io), and the map uses free [OpenStreetMap](https://www.openstreetmap.org) tiles via [Leaflet](https://leafletjs.com).

## Nightly snapshot (data pipeline)

A scheduled GitHub Action runs [`scripts/snapshot.mjs`](scripts/snapshot.mjs), which reads every club's public prices and commits:

- `data/latest.json` — current prices for all clubs (powers the league, compare and map)
- `data/clubs/<siteId>.json` — a full per-club bundle the club page renders from (prices, benefits, offers, club access, profile)
- `data/facilities.json` — pool/spa/courts per club (powers the facilities league)
- `data/history.json` — append-on-change price history (powers trends / movers)
- `data/locations.json` — club coordinates (powers "near me" and the map)

Read-only, no auth, no secrets, and it never writes anything back to David Lloyd.

## Tests

A hermetic [Playwright](https://playwright.dev) suite (`tests/`) serves the static site and mocks the David Lloyd API from `tests/fixtures/`, so it runs offline and asserts the shipped `app.js` directly:

```
npm install
npm test
```

## Notes

- Figures are **standard rates before any promotion**. A real quote varies with current offers and your start date — always confirm with the club.
- **Privacy:** the site sets no cookies and stores nothing in your browser (no `localStorage`, no accounts). It uses [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) — a cookieless, privacy-first page-view counter — and records which club pages are viewed (via the URL) so popular clubs can be seen in aggregate. No tracking across sites, nothing sold.

## Disclaimer

This project is **not affiliated with, endorsed by, or connected to David Lloyd Leisure** in any way. "David Lloyd" is a trademark of its owner. Prices are indicative and may be inaccurate or out of date.

## Running locally

Just open `index.html`, or serve the folder:

```
python3 -m http.server 8000   # then visit http://localhost:8000
```

To regenerate the snapshot data locally: `node scripts/snapshot.mjs`.
