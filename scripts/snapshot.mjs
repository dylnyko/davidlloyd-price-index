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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import PB from "../shared.js";

const API = "https://mobile-app-back.davidlloyd.co.uk";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Deploy origin comes from package.json "homepage" so a fork can point this at
// its own host without editing code. Absolute SEO URLs (per-club canonical/OG,
// sitemap, robots) are only emitted when it's set; otherwise they're relative or
// omitted so the site still works when served from an unknown origin.
const SITE = (() => { try { return (JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).homepage || "").replace(/\/+$/, ""); } catch { return ""; } })();
const DATA = `${ROOT}/data`;
const DUR = { STANDARD: "S", FLEXIBLE: "F", ANNUAL: "A" };
const CONCURRENCY = 8;
// Mirror app.js: DL's /clubs feed mis-tags Edinburgh Shawfair (156) as England.
const COUNTRY_FIX = { 156: "Scotland" };
// Site IDs to drop even though DL's feed says "active". 70 "Windsor" is a dummy
// record: placeholder coords (100,100), phone "12131415", no page on DL's site,
// absent from every DL tier list, and no access relationships in the tier graph
// — yet it carries a full (fictional) price card. Not a real club; don't publish it.
const EXCLUDE_SITES = { 70: "Windsor: dummy record in DL's feed" };
// Known-bad coordinates to override (none currently — Windsor is excluded instead).
const COORD_FIX = {};

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
    const grouped = p.packageInformationGroupedByType || {};
    const ben = (grouped.BENEFIT || []).map((b) => ({
      orderingPriority: b.orderingPriority,
      displayTextByLanguage: { "en-gb": { text: ((b.displayTextByLanguage || {})["en-gb"] || {}).text || "" } },
    }));
    const desc = (grouped.DESCRIPTION || []).map((d) => ({
      displayTextByLanguage: { "en-gb": { text: ((d.displayTextByLanguage || {})["en-gb"] || {}).text || "" } },
    }));
    return { packageKey: p.packageKey, prices, packageInformationGroupedByType: { BENEFIT: ben, DESCRIPTION: desc } };
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
    // Presence only — don't republish DL's club email addresses.
    pool: !!club.swimmingEmailAddress,
    spa: !!club.spaBookingsEmailAddress,
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
    .filter((c) => c.status === "active" && !EXCLUDE_SITES[c.siteId])
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
  for (const [sid, v] of Object.entries(COORD_FIX)) locations[sid] = v;

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
      const [settings, access, detail, away] = await Promise.all([
        getJSON(`${API}/clubs/${c.siteId}/membership-settings`).catch(() => ({})),
        postJSON(`${API}/accessible-clubs`, { siteId: String(c.siteId), packageKeys: keys }).catch(() => ({})),
        getJSON(`${API}/clubs/${c.siteId}`).catch(() => ({})),
        // Club-level access rules (which clubs sit above / at-or-below / exclusive
        // relative to this one) — the only place DL's tiering is exposed. See tiers below.
        getJSON(`${API}/clubs/${c.siteId}/away-clubs`).catch(() => null),
      ]);
      const club = detail.club || detail || {};
      const country = COUNTRY_FIX[c.siteId] || c.country;
      // DL runs Harbour Club as a distinct brand (e.g. Chelsea); label it as such.
      const brandName = c.brand === "harbour" ? "Harbour Club" : "David Lloyd";
      // Full bundle the club page renders entirely from (no live DL calls needed).
      const bundle = {
        siteId: c.siteId, name: c.clubName, country, currency: c.currency, brandName,
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
        fac, bundle, away,
      };
    } catch (e) {
      fail++;
      console.warn(`  ! ${c.clubName} (#${c.siteId}): ${e.message}`);
      return null;
    }
  });
  console.log(`Wrote ${bundles} per-club bundles to data/clubs/.`);

  const rows = out.filter(Boolean);

  // ---- club tiers, derived from DL's own access rules ----
  // DL's API never names a tier, but /clubs/{id}/away-clubs says which clubs sit
  // above / at-or-below / in an exclusive tier relative to each club. Clubs in the
  // same tier are classified identically by everyone else, so "how many clubs rank
  // me above them" partitions the estate exactly. Labels follow DL's published tier
  // list (Super tier, then Tier 1..N, top down). Best-effort approximation — the
  // page says so and tells people to confirm with the club.
  // Two views of the same rule set: a club's OWN count of clubs above it (primary —
  // works for brand-new clubs that nobody else's list references yet), and how many
  // OTHER clubs rank it above them (fallback when a club's own data is missing).
  // A club with neither gets no badge rather than a wrong one.
  const above = {}, votes = {}, exclusive = new Set(), brandOf = {};
  for (const c of clubs) brandOf[c.siteId] = c.brand;
  for (const r of rows) {
    const a = r.away; if (!a) continue;
    const hi = a.clubsInAHigherTier || [], ex = a.clubsInAnExclusiveTier || [];
    if (hi.length + ex.length > 0) above[r.entry.siteId] = hi.length + ex.length;   // 0/0 = DL placeholder record
    for (const s of hi) votes[s] = (votes[s] || 0) + 1;
    for (const s of ex) { votes[s] = (votes[s] || 0) + 1; exclusive.add(s); }
  }
  // Tier levels are anchored on UK clubs inside DL's published ladder (not exclusive,
  // not the separately-branded Harbour Club); other clubs snap to the nearest level.
  const anchors = rows.filter((r) => r.entry.currency === "GBP" && !exclusive.has(r.entry.siteId) && brandOf[r.entry.siteId] !== "harbour");
  const lvAbove = [...new Set(anchors.filter((r) => above[r.entry.siteId] != null).map((r) => above[r.entry.siteId]))].sort((a, b) => a - b);  // fewest above = Tier 1
  const lvVotes = [...new Set(anchors.filter((r) => votes[r.entry.siteId]).map((r) => votes[r.entry.siteId]))].sort((a, b) => b - a);          // most votes = Tier 1
  const rank = (v, lv, higherIsLower) => { let i = lv.indexOf(v); if (i < 0) i = lv.filter((l) => (higherIsLower ? l > v : l < v)).length; return `Tier ${Math.min(i, lv.length - 1) + 1}`; };
  const tierOf = (sid) => {
    if (exclusive.has(sid)) return "Super tier";
    if (brandOf[sid] === "harbour") return null;            // the brand is the distinction
    if (above[sid] != null && lvAbove.length) return rank(above[sid], lvAbove, false);
    if (votes[sid] && lvVotes.length) return rank(votes[sid], lvVotes, true);
    return null;
  };
  for (const r of rows) {
    const t = tierOf(r.entry.siteId);
    r.entry.tier = r.bundle.tier = t;
    writeFileSync(`${CLUBDIR}/${r.entry.siteId}.json`, JSON.stringify(r.bundle));   // re-write with tier
  }
  console.log(`tiers: ${lvAbove.length} levels + Super tier (${exclusive.size} exclusive clubs).`);

  const clubData = rows.map((x) => x.entry);
  const latest = {
    generatedAt: new Date().toISOString(),
    date: today,
    count: clubData.length,
    sports,
    clubs: clubData,
  };
  writeFileSync(`${DATA}/facilities.json`, JSON.stringify({
    generatedAt: latest.generatedAt, date: today, count: rows.length,
    sports, clubs: rows.map((x) => x.fac),
  }));
  console.log(`facilities.json: ${rows.length} clubs.`);
  writeFileSync(`${DATA}/locations.json`, JSON.stringify({ generatedAt: latest.generatedAt, locations }));

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
  // ---- tier history: append-on-change, same model as prices ----
  // tiers[siteId] = [[date, "Tier 4"], ...]; a second point means the club moved
  // tier, which the Movers view shows alongside price changes.
  history.tiers = history.tiers || {};
  let tierChanged = 0;
  for (const club of clubData) {
    if (!club.tier) continue;                                   // no badge → nothing to track
    const arr = (history.tiers[String(club.siteId)] = history.tiers[String(club.siteId)] || []);
    const last = arr[arr.length - 1];
    if (!last || last[1] !== club.tier) { arr.push([today, club.tier]); tierChanged++; }
  }
  history.updated = latest.generatedAt;
  writeFileSync(`${DATA}/history.json`, JSON.stringify(history));
  console.log(`history.json: ${changed} price point(s), ${tierChanged} tier point(s) recorded for ${today}.`);

  // Count movers (series with >=2 points = a price actually changed) so the
  // front-end can hide the Movers tab until there's something to show.
  let moversCount = 0;
  for (const plans of Object.values(history.series))
    for (const fields of Object.values(plans))
      for (const arr of Object.values(fields)) if (arr.length >= 2) moversCount++;
  for (const arr of Object.values(history.tiers)) if (arr.length >= 2) moversCount++;   // tier moves count too
  latest.moversCount = moversCount;
  writeFileSync(`${DATA}/latest.json`, JSON.stringify(latest));
  console.log(`latest.json: ${ok} clubs, ${fail} skipped, ${moversCount} movers.`);

  // ---- static per-club pages (SEO) + sitemap ----
  const CLUBDIR2 = `${ROOT}/clubs`;
  if (!existsSync(CLUBDIR2)) mkdirSync(CLUBDIR2, { recursive: true });
  const nameById = {}; for (const c of clubData) nameById[c.siteId] = c.name;
  const slugs = [];
  for (const x of rows) {
    const b = x.bundle;
    const slug = PB.slugify(b.name);
    const html = clubPageHTML(b, { sports, nameById, series: history.series[String(b.siteId)] || {}, coords: locations[String(b.siteId)] || null, date: today, hasMovers: moversCount > 0 });
    if (!existsSync(`${CLUBDIR2}/${slug}`)) mkdirSync(`${CLUBDIR2}/${slug}`, { recursive: true });
    writeFileSync(`${CLUBDIR2}/${slug}/index.html`, html);
    slugs.push(slug);
  }
  // Prune output for clubs no longer in the feed (renamed, closed or excluded),
  // so a dropped club doesn't linger as a stale page or bundle.
  for (const dir of readdirSync(CLUBDIR2)) if (!slugs.includes(dir)) rmSync(`${CLUBDIR2}/${dir}`, { recursive: true, force: true });
  const keepIds = new Set(rows.map((r) => `${r.entry.siteId}.json`));
  for (const f of readdirSync(CLUBDIR)) if (!keepIds.has(f)) rmSync(`${CLUBDIR}/${f}`, { force: true });
  // sitemap.xml + robots.txt need the absolute origin, so they're only written
  // when package.json "homepage" is set (see SITE). A fork with no homepage still
  // builds fine; it just ships no sitemap and a robots.txt without a Sitemap line.
  if (SITE) {
    const urls = [`${SITE}/`].concat(slugs.sort().map((s) => `${SITE}/clubs/${s}/`));
    writeFileSync(`${ROOT}/sitemap.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url><loc>${u}</loc><changefreq>daily</changefreq></url>`).join("\n") +
      `\n</urlset>\n`);
  }
  writeFileSync(`${ROOT}/robots.txt`,
    `User-agent: *\nAllow: /\n` + (SITE ? `\nSitemap: ${SITE}/sitemap.xml\n` : ``));
  console.log(`Wrote ${slugs.length} static club pages${SITE ? " + sitemap + robots" : " (no homepage set: skipped sitemap)"}.`);
}

const TIER_NOTE = "Best approximation from David Lloyd’s club-access data. Please confirm with David Lloyd.";
const CMP_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 6h7M4 12h7M4 18h7M20 6h-5M20 12h-5M20 18h-5"/><path d="M8 3v18M16 3v18"/></svg>`;
const SHARE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V3"/><path d="m8 7 4-4 4 4"/></svg>`;

// Build one static club page from its bundle — reuses shared.js (same markup as the app).
function clubPageHTML(b, ctx) {
  const { sports, nameById, series, coords, date } = ctx;
  const esc = PB.esc, fmt = PB.fmt, slug = PB.slugify(b.name), cur = b.currency, brand = b.brandName || "David Lloyd";
  const mostPopular = ((b.settings || {}).packageSettings || {}).standardMostPopularPackage || null;
  const accessNames = {};
  for (const [k, ids] of Object.entries(b.access || {})) {
    if ((ids || []).length > 1) { const names = ids.map((id) => nameById[id]).filter(Boolean).sort((a, z) => a.localeCompare(z)); if (names.length) accessNames[k] = names; }
  }
  const durs = PB.DUR_ORDER.filter((d) => (b.packages || []).some((p) => p.prices && p.prices[d]));
  const R = PB.priceTableHTML({ packages: b.packages, addOns: b.addOns, dur: "STANDARD", currency: cur, mostPopular, accessNames, trend: null });
  const profile = PB.profileHTML(b.detail, sports);
  const tabs = durs.map((d) => `<button role="tab" data-dur="${d}" aria-selected="${d === "STANDARD"}">${PB.DUR_LABEL[d]}</button>`).join("");
  const vals = [];
  for (const p of (b.packages || [])) { const s = p.prices && p.prices.STANDARD; if (!s) continue; for (const f of ["individual", "couple"]) if (s[f] != null) vals.push(s[f]); }
  const lo = vals.length ? Math.min(...vals) : null, hi = vals.length ? Math.max(...vals) : null;
  const title = `${brand} ${b.name} membership prices | Rack Rate`;
  const desc = `${b.name} ${brand} membership prices${lo != null ? `, from ${fmt(lo, cur)} a month` : ""}, plus joining fees. Standard, flexible and annual rates for every plan. Independent and unofficial.`;
  // Absolute canonical/OG only when a homepage is configured; otherwise fall back
  // to origin-relative so a fork works on any host (see SITE).
  const canon = SITE ? `${SITE}/clubs/${slug}/` : "";
  const ogImg = SITE ? `${SITE}/og-image.png?v=4` : `../../og-image.png?v=4`;
  const ld = lo != null ? `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "Product", name: `${brand} ${b.name} membership`,
    brand: { "@type": "Brand", name: brand }, description: desc,
    offers: { "@type": "AggregateOffer", priceCurrency: cur, lowPrice: lo / 100, highPrice: hi / 100, offerCount: (b.packages || []).length, availability: "https://schema.org/InStock", ...(canon ? { url: canon } : {}) },
  }).replace(/</g, "\\u003c")}</script>` : "";
  const clubJSON = JSON.stringify({ name: b.name, country: b.country, currency: cur, siteId: b.siteId, slug, mostPopular, brandName: brand, tier: b.tier || null, packages: b.packages, addOns: b.addOns, accessNames, sports, detail: b.detail, coords, series, date }).replace(/</g, "\\u003c");
  const foot = esc(`From David Lloyd’s snapshot of ${PB.fmtDate(date)}.`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
${canon ? `<link rel="canonical" href="${canon}" />\n` : ""}<meta name="theme-color" content="#efece3" />
<link rel="icon" href="../../favicon.svg?v=57" type="image/svg+xml" />
<link rel="icon" href="../../favicon.png?v=57" type="image/png" sizes="64x64" />
<link rel="apple-touch-icon" href="../../apple-touch-icon.png?v=57" />
${ld}
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Rack Rate" />
<meta property="og:title" content="${esc(`${brand} ${b.name} prices`)}" />
<meta property="og:description" content="${esc(desc)}" />
${canon ? `<meta property="og:url" content="${canon}" />\n` : ""}<meta property="og:image" content="${ogImg}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${ogImg}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Space+Mono:wght@400;700&display=swap" />
<link rel="stylesheet" href="../../styles.css?v=57" />
</head>
<body>
<div class="frame">
  <header class="topbar">
    <a class="mark" href="../../" aria-label="Rack Rate home"><img src="../../logo.svg?v=57" alt="Rack Rate" width="742" height="86" /></a>
    <nav class="nav" aria-label="Views">
      <a href="../../" aria-selected="true">Club&nbsp;lookup</a>
      <a href="../../?view=league">Price&nbsp;league</a>
      <a href="../../?view=facilities">Facilities</a>
      <a href="../../?view=map">Map</a>${ctx.hasMovers ? `\n      <a href="../../?view=movers">Movers</a>` : ""}
    </nav>
  </header>
  <div id="stale" class="stale" role="status" hidden></div>
  <main id="panel" class="panel">
    <div class="panelhead">
      <div class="ph-title">
        <a class="backbtn" href="../../">← Back</a>
        <p class="ph-brand">${esc(b.brandName || "David Lloyd").replace(" ", "&nbsp;")}</p>
        <div class="ph-name"><h1 id="clubname">${esc(b.name)}</h1><span id="clubcountry" class="ph-country">${esc(b.country || "")}</span>${b.tier ? `<span id="clubtier" class="ph-tier has-tip" tabindex="0" aria-describedby="clubtier-tip">${esc(b.tier)}<span class="tip" id="clubtier-tip" role="tooltip">${TIER_NOTE}</span></span>` : ""}</div>
        <p id="clubsub" class="clubsub" hidden></p>
        <a id="do-compare" class="cmp-open" href="../../?view=compare&a=${slug}">${CMP_SVG} Compare with another club</a>
      </div>
      <div class="head-actions">
        <div class="durations" id="durations" role="tablist" aria-label="Membership duration">${tabs}</div>
        <button id="share" class="share" type="button" aria-label="Share these prices as an image">${SHARE_SVG} Share</button>
      </div>
    </div>
    <div class="tablewrap"><table id="pricetable" class="pricetable"><thead><tr id="thead-row">${R.thead}</tr></thead><tbody id="tbody">${R.tbody}</tbody></table></div>
    <p id="addons" class="addons"${R.addonsHTML ? "" : " hidden"}>${R.addonsHTML}</p>
    <section id="profile" class="profile">${profile}</section>
    <p id="foot-note" class="foot-note">${foot}</p>
  </main>
  <footer class="sitefoot">
    <p><span class="fs-mk">UNOFFICIAL</span> Not affiliated with David&nbsp;Lloyd Leisure.</p>
  </footer>
</div>

<div id="sharemodal" class="modal" hidden>
  <div class="modal-backdrop" data-close></div>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="sharetitle">
    <div class="modal-head"><h3 id="sharetitle">Share these prices</h3><button class="modal-x" data-close type="button" aria-label="Close">✕</button></div>
    <p class="modal-sub">A snapshot of the current prices, ready to paste anywhere.</p>
    <div class="modal-preview"><img id="share-preview" alt="Preview of the price image" /></div>
    <div class="modal-actions">
      <button id="do-copy" class="mbtn primary" type="button">Copy image</button>
      <button id="do-download" class="mbtn" type="button">Download PNG</button>
      <button id="do-link" class="mbtn" type="button">Copy link</button>
    </div>
    <p class="modal-link" id="share-link"></p>
  </div>
</div>
<div id="planmodal" class="modal" hidden>
  <div class="modal-backdrop" data-close></div>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="plantitle">
    <div class="modal-head"><h3 id="plantitle">—</h3><button class="modal-x" data-close type="button" aria-label="Close">✕</button></div>
    <p id="plandesc" class="modal-sub"></p>
    <h4 id="planbens-h" class="modal-h" hidden>Facilities &amp; benefits</h4>
    <div id="planbens" class="benefits"></div>
    <div id="planaccess"></div>
  </div>
</div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

<script id="pb-bundle" type="application/json">${clubJSON}</script>
<script src="../../shared.js?v=57"></script>
<script src="../../club.js?v=57"></script>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "5661e49f2a504dd69734b894973090a0"}'></script>
</body>
</html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
