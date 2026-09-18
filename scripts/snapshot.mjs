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

async function postJSON(url, body, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (a === tries) throw e;
      await new Promise((res) => setTimeout(res, 500 * a));
    }
  }
}

/* ---- per-club bundle: exactly what the club page renders, trimmed ----
 * Keeps DL's own field names/nesting so the front-end render code is unchanged;
 * strips the megabytes of unused multi-language promo text and other cruft. */
const DURS = ["STANDARD", "FLEXIBLE", "ANNUAL"];
function trimPromo(pm) {
  const en = ((pm.textByLanguage || {})["en-gb"]) || {};
  return {
    promotionId: pm.promotionId,
    name: pm.name,
    endDate: pm.endDate,
    inHiddenMenuInClub: !!pm.inHiddenMenuInClub,
    textByLanguage: { "en-gb": { shortDescription: en.shortDescription || "", rateCardBannerTitle: en.rateCardBannerTitle || "" } },
    promotionItems: (pm.promotionItems || []).map((it) => ({ type: it.type, savingType: it.savingType, savingAmount: it.savingAmount })),
  };
}
function trimPackages(pkg) {
  return (pkg.packages || []).map((p) => {
    const prices = {};
    for (const dur of DURS) {
      const d = p.prices && p.prices[dur];
      if (!d) continue;
      prices[dur] = { individual: d.individual ?? null, couple: d.couple ?? null, family: d.family ?? null,
        joiningFee: d.joiningFee ?? 0, promotions: (d.promotions || []).map(trimPromo) };
    }
    const ben = ((p.packageInformationGroupedByType || {}).BENEFIT || []).map((b) => ({
      orderingPriority: b.orderingPriority,
      displayTextByLanguage: { "en-gb": { text: ((b.displayTextByLanguage || {})["en-gb"] || {}).text || "" } },
    }));
    return { packageKey: p.packageKey, prices, packageInformationGroupedByType: { BENEFIT: ben } };
  });
}
function trimAddOns(pkg) {
  return (pkg.addOns || []).map((a) => {
    const prices = {};
    for (const dur of DURS) { const d = a.prices && a.prices[dur]; if (d && d.price != null) prices[dur] = { price: d.price }; }
    return { addOnKey: a.addOnKey, prices };
  });
}
function trimDetail(club, siteId) {
  return {
    siteId,
    telephone: club.telephone || null,
    isBlaze: !!club.isBlaze,
    isAdultOnly: !!club.isAdultOnly,
    swimmingEmailAddress: club.swimmingEmailAddress || null,
    spaBookingsEmailAddress: club.spaBookingsEmailAddress || null,
    sportIdsAvailable: club.sportIdsAvailable || [],
    courts: (club.courts || []).map((c) => ({ sportId: c.sportId })),
    clubOpeningTimes: { weeklyOpeningTimes: (club.clubOpeningTimes || {}).weeklyOpeningTimes || null },
  };
}
function accessFromResp(resp) {
  const map = {};
  for (const e of (resp.awayClubsByPackageKeys || [])) map[e.packageKey] = ((e.awayClubs || {}).clubsInTheSameTierOrLower || []);
  return map;
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
    // Validate ranges — DL sometimes emits placeholders (e.g. Windsor at 100,100).
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)
      locations[sid] = { lat, lng };
  }

  const CLUBDIR = `${DATA}/clubs`;
  if (!existsSync(CLUBDIR)) mkdirSync(CLUBDIR, { recursive: true });

  console.log(`Fetching full data for ${clubs.length} clubs…`);
  let ok = 0, fail = 0, bundles = 0;
  const out = await pool(clubs, async (c) => {
    try {
      const pkg = await getJSON(`${API}/clubs/${c.siteId}/packages/online`);
      const plans = plansFromPackages(pkg);
      if (!Object.keys(plans).length) { fail++; return null; }
      const keys = (pkg.packages || []).map((p) => p.packageKey);
      // The other three per-club calls the browser used to make — now server-side.
      const [settings, access, detail] = await Promise.all([
        getJSON(`${API}/clubs/${c.siteId}/membership-settings`).catch(() => ({})),
        postJSON(`${API}/accessible-clubs`, { siteId: String(c.siteId), packageKeys: keys }).catch(() => ({})),
        getJSON(`${API}/clubs/${c.siteId}`).catch(() => ({})),
      ]);
      const club = detail.club || detail || {};
      const country = COUNTRY_FIX[c.siteId] || c.country;
      // Full bundle the club page renders entirely from (no live DL calls needed).
      const bundle = {
        siteId: c.siteId, name: c.clubName, country, currency: c.currency,
        settings: { packageSettings: { standardMostPopularPackage: (settings.packageSettings || {}).standardMostPopularPackage || null } },
        access: accessFromResp(access),
        packages: trimPackages(pkg),
        addOns: trimAddOns(pkg),
        detail: trimDetail(club, c.siteId),
      };
      writeFileSync(`${CLUBDIR}/${c.siteId}.json`, JSON.stringify(bundle));
      bundles++;
      ok++;
      // Facility summary for the Facilities League (#facilities).
      const courts = {};
      for (const ct of (club.courts || [])) { const n = sports[ct.sportId]; if (n) courts[n] = (courts[n] || 0) + 1; }
      const fac = {
        siteId: c.siteId, name: c.clubName, country,
        pool: !!club.swimmingEmailAddress, spa: !!club.spaBookingsEmailAddress,
        blaze: !!club.isBlaze, adultOnly: !!club.isAdultOnly,
        courts, totalCourts: Object.values(courts).reduce((a, b) => a + b, 0),
      };
      return {
        entry: {
          siteId: c.siteId, name: c.clubName, country, currency: c.currency,
          mostPopular: bundle.settings.packageSettings.standardMostPopularPackage,
          plans,
        },
        fac,
      };
    } catch (e) {
      fail++;
      console.warn(`  ! ${c.clubName} (#${c.siteId}): ${e.message}`);
      return null;
    }
  });
  console.log(`Wrote ${bundles} per-club bundles to data/clubs/.`);

  const rows = out.filter(Boolean);
  const clubData = rows.map((x) => x.entry);
  const latest = {
    generatedAt: new Date().toISOString(),
    date: today,
    count: clubData.length,
    sports,
    clubs: clubData,
  };
  writeFileSync(`${DATA}/latest.json`, JSON.stringify(latest));
  writeFileSync(`${DATA}/facilities.json`, JSON.stringify({
    generatedAt: latest.generatedAt, date: today, count: rows.length,
    sports, clubs: rows.map((x) => x.fac),
  }));
  console.log(`facilities.json: ${rows.length} clubs.`);
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
