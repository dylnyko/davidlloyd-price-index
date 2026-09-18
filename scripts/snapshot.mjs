#!/usr/bin/env node
/* Nightly price snapshot for The Price Book.
 *
 * Pulls every active club's live packages from David Lloyd's public, unauthenticated
 * endpoints (the same ones the join flow uses) and writes three committed JSON files:
 *   data/latest.json    — current prices for all clubs (powers the National price league)
 *   data/history.json   — append-on-change time series (powers price-trend deltas)
 *   data/locations.json — siteId -> {lat,lng} (powers "clubs near me" without a live call)
 *
 * No auth, no secrets, no writes to DL. Read-only. Run: `node scripts/snapshot.mjs`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://mobile-app-back.davidlloyd.co.uk";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = `${ROOT}/data`;
const DUR = { STANDARD: "S", FLEXIBLE: "F", ANNUAL: "A" };
const CONCURRENCY = 8;
// Mirror app.js: DL's /clubs feed mis-tags Edinburgh Shawfair (156) as England.
const COUNTRY_FIX = { 156: "Scotland" };

const today = new Date().toISOString().slice(0, 10);

async function getJSON(url, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (a === tries) throw e;
      await new Promise((res) => setTimeout(res, 500 * a));
    }
  }
}

// Run tasks with a small concurrency cap so we're gentle on the API.
async function pool(items, fn, limit = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Extract exactly the numbers the site displays: individual/couple/family + joining
// fee per duration (pennies), mirroring app.js so latest.json is 1:1 with the UI.
function plansFromPackages(pkg) {
  const plans = {};
  for (const p of pkg.packages || []) {
    const byDur = {};
    for (const [durLong, short] of Object.entries(DUR)) {
      const d = p.prices && p.prices[durLong];
      if (!d) continue;
      const cell = {
        i: d.individual ?? null,
        c: d.couple ?? null,
        f: d.family ?? null,
        j: d.joiningFee ?? 0,
      };
      if (cell.i != null || cell.c != null || cell.f != null) byDur[short] = cell;
    }
    if (Object.keys(byDur).length) plans[p.packageKey] = byDur;
  }
  return plans;
}

async function main() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

  console.log("Fetching club list, locations, sports…");
  const [clubsResp, locResp, sportsResp] = await Promise.all([
    getJSON(`${API}/clubs`),
    getJSON(`${API}/clubs/locations`).catch(() => ({ clubLocations: {} })),
    getJSON(`${API}/sports`).catch(() => ({ sports: [] })),
  ]);

  const clubs = (clubsResp.clubs || [])
    .filter((c) => c.status === "active")
    .sort((a, b) => a.clubName.localeCompare(b.clubName));

  const sports = {};
  for (const s of sportsResp.sports || []) sports[s.sportId] = s.sportName;

  const locations = {};
  for (const [sid, v] of Object.entries(locResp.clubLocations || {})) {
    const lat = parseFloat(v.latitude), lng = parseFloat(v.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) locations[sid] = { lat, lng };
  }

  console.log(`Fetching packages for ${clubs.length} clubs…`);
  let ok = 0, fail = 0;
  const out = await pool(clubs, async (c) => {
    try {
      const [pkg, settings] = await Promise.all([
        getJSON(`${API}/clubs/${c.siteId}/packages/online`),
        getJSON(`${API}/clubs/${c.siteId}/membership-settings`).catch(() => ({})),
      ]);
      const plans = plansFromPackages(pkg);
      if (!Object.keys(plans).length) { fail++; return null; }
      ok++;
      return {
        siteId: c.siteId,
        name: c.clubName,
        country: COUNTRY_FIX[c.siteId] || c.country,
        currency: c.currency,
        mostPopular: (settings.packageSettings || {}).standardMostPopularPackage || null,
        plans,
      };
    } catch (e) {
      fail++;
      console.warn(`  ! ${c.clubName} (#${c.siteId}): ${e.message}`);
      return null;
    }
  });

  const clubData = out.filter(Boolean);
  const latest = {
    generatedAt: new Date().toISOString(),
    date: today,
    count: clubData.length,
    sports,
    clubs: clubData,
  };
  writeFileSync(`${DATA}/latest.json`, JSON.stringify(latest));
  writeFileSync(`${DATA}/locations.json`, JSON.stringify({ generatedAt: latest.generatedAt, locations }));
  console.log(`latest.json: ${ok} clubs, ${fail} skipped.`);

  // ---- history: append headline prices only when they change ----
  let history = { updated: "", series: {} };
  if (existsSync(`${DATA}/history.json`)) {
    try { history = JSON.parse(readFileSync(`${DATA}/history.json`, "utf8")); } catch {}
  }
  history.series = history.series || {};
  let changed = 0;
  for (const club of clubData) {
    const sid = String(club.siteId);
    const cs = (history.series[sid] = history.series[sid] || {});
    for (const [key, byDur] of Object.entries(club.plans)) {
      const ks = (cs[key] = cs[key] || {});
      // track individual STANDARD (iS) and individual ANNUAL (iA)
      for (const [field, src] of [["iS", byDur.S], ["iA", byDur.A]]) {
        const val = src ? src.i : null;
        if (val == null) continue;
        const arr = (ks[field] = ks[field] || []);
        const last = arr[arr.length - 1];
        if (!last || last[1] !== val) { arr.push([today, val]); changed++; }
      }
    }
  }
  history.updated = latest.generatedAt;
  writeFileSync(`${DATA}/history.json`, JSON.stringify(history));
  console.log(`history.json: ${changed} price point(s) recorded for ${today}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
