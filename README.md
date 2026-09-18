# The Price Book

An independent, unofficial web tool to look up **live David Lloyd membership prices** for any club — every plan, every membership type, every duration.

👉 **[Open it](https://dylnyko.github.io/davidlloyd-price-index/)**

## What it does

Search for a club, and the page pulls its current **standard** membership rates (monthly fee + joining fee) straight from David Lloyd's public pricing service and lays them out in a clean price table.

## Fully self-updating

Nothing is hardcoded:

- **Clubs** are read live from the public `/clubs` list, so new clubs appear automatically.
- **Plans, membership types and durations** are discovered from the API's own enum at runtime, so new membership tiers show up here with no code changes.

It's a single static page (HTML/CSS/JS) with no backend — all calls happen in the browser, and the API sends `Access-Control-Allow-Origin: *`, so it can be hosted anywhere, including GitHub Pages.

## Notes

- Figures are **standard rates before any promotion**. A real quote varies with current offers and your start date — always confirm with the club.
- No data is collected; there is no analytics or tracking.

## Disclaimer

This project is **not affiliated with, endorsed by, or connected to David Lloyd Leisure** in any way. "David Lloyd" is a trademark of its owner. Prices are indicative and may be inaccurate or out of date.

## Running locally

Just open `index.html`, or serve the folder:

```
python3 -m http.server 8000   # then visit http://localhost:8000
```
