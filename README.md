<p><img src="logo.svg" alt="Rack Rate" width="520"></p>

# Rack Rate

An independent, unofficial web tool to look up **live David Lloyd membership prices** for any club — every plan, every membership type, every duration.

👉 **[Open it](https://dylnyko.github.io/davidlloyd-price-index/)**

## What it does

Search for a club (or find the ones nearest you) and you land on that club's page showing its current **standard** membership rates — monthly fee, joining fee, plan benefits and the other clubs each membership lets you into — laid out in a clean price table. Each club has its own pre-rendered, shareable page at `/clubs/<slug>/` (built by the nightly snapshot, so it's fast and search-engine friendly).

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

It also pre-renders the SEO surface from the same data: a static `clubs/<slug>/index.html` per club (sharing one renderer, [`shared.js`](shared.js), with the browser so there's no duplicated markup), plus `sitemap.xml` and `robots.txt`.

Read-only, no auth, no secrets, and it never writes anything back to David Lloyd.

### Deploying your own copy

The public URL lives in one place — the `homepage` field in [`package.json`](package.json). The build reads it for the absolute SEO URLs (per-club canonical/OG tags, `sitemap.xml`, `robots.txt`); everything else is origin-relative, so a fork just needs to point `homepage` at its own host and re-run the snapshot. Leave `homepage` empty and those absolute URLs are simply omitted (the site still works).

## Tests

A hermetic [Playwright](https://playwright.dev) suite (`tests/`) serves the static site as shipped — the committed data and the pre-rendered club pages — and stubs the few outbound calls (the live `/clubs` fallback, fonts/analytics, the postcode geocoder), so it runs offline and covers both the homepage (search, leagues, map, compare, near-me) and the static club pages:

```
npm install       # first time only, to fetch Playwright
npx playwright install chromium   # first time only, to fetch the browser
npm test
```

## Notes

- Figures are **standard rates before any promotion**. A real quote varies with current offers and your start date — always confirm with the club.
- **Privacy:** the site sets no cookies and stores nothing in your browser (no `localStorage`, no accounts). It uses [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) — a cookieless, privacy-first page-view counter — and records which club pages are viewed (via the URL) so popular clubs can be seen in aggregate. No tracking across sites, nothing sold.

## Disclaimer

This project is **not affiliated with, endorsed by, or connected to David Lloyd Leisure** in any way. "David Lloyd" is a trademark of its owner. Prices are indicative and may be inaccurate or out of date.

## Running locally

Serve the folder over HTTP (the pages `fetch` the committed JSON, which browsers block on `file://`):

```
python3 -m http.server 8000   # then visit http://localhost:8000
```

or `npm run serve` (same thing on port 4173). The homepage is `index.html`; a club page is `clubs/<slug>/`, e.g. `http://localhost:8000/clubs/nottingham-west-bridgford/`.

To rebuild all the data and the static club pages from David Lloyd's live endpoints:

```
node scripts/snapshot.mjs
```

This rewrites `data/`, every `clubs/<slug>/index.html`, `sitemap.xml` and `robots.txt`. It's read-only against David Lloyd and takes a couple of minutes. Bump the `?v=` query on the asset links in `index.html` (and in `scripts/snapshot.mjs`, which stamps the club pages) when you change `styles.css` / `app.js` / `club.js` / `shared.js`, to bust caches.
