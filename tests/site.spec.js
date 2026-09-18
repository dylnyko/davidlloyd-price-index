// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const FX = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", p), "utf8"));
const clubs = FX("clubs.json");
const packages = FX("packages_75.json");
const settings = FX("settings_75.json");
const accessible = FX("accessible_75.json");
const detail = FX("club_75.json");
const sports = { sports: [
  { sportId: 13, sportName: "Tennis" }, { sportId: 14, sportName: "Badminton" },
  { sportId: 15, sportName: "Squash" }, { sportId: 19, sportName: "Padel" },
  { sportId: 22, sportName: "Pickleball" },
] };

// Mock every David Lloyd endpoint from fixtures; block fonts/analytics so the
// suite never touches the network. Any club id resolves to the West End fixture,
// so we can drive the whole UI (incl. the Shawfair country override) offline.
async function mockDL(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com|cloudflareinsights\.com/, (r) => r.abort());
  await page.route(/mobile-app-back\.davidlloyd\.co\.uk/, async (route) => {
    const url = route.request().url();
    const json = (obj) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });
    if (/\/accessible-clubs/.test(url)) return json(accessible);
    if (/\/packages\/online/.test(url)) return json(packages);
    if (/\/membership-settings/.test(url)) return json(settings);
    if (/\/sports\b/.test(url)) return json(sports);
    if (/\/clubs\/locations/.test(url)) return json({ clubLocations: {} });
    if (/\/clubs\/\d+(\?|$)/.test(url)) return json(detail); // single-club detail
    if (/\/clubs(\?|$)/.test(url)) return json(clubs);
    return route.continue();
  });
  // Force the live-fallback path for deterministic fixture-based assertions
  // (the committed per-club bundles are exercised by their own test below).
  await page.route(/\/data\/clubs\//, (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" })
  );
  // Geocoder for "clubs near me" — fixed point near Glasgow.
  await page.route(/api\.postcodes\.io/, (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { latitude: 55.86, longitude: -4.25, postcode: "G1 1AA" } }),
    })
  );
}

// Deep-link straight to a selected club and wait for the price table.
async function openWestEnd(page) {
  await page.goto("/?club=glasgow-west-end");
  await expect(page.locator("#pricetable")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockDL(page);
});

test("boots, counts clubs and filters the search", async ({ page }) => {
  await page.goto("/");
  // Club list comes from the committed snapshot now (data/latest.json).
  await expect
    .poll(async () => Number(await page.locator("#clubcount").textContent()))
    .toBeGreaterThan(100);
  await page.locator("#q").click();
  await expect(page.locator("#results-list li").first()).toBeVisible();
  await page.fill("#q", "glasgow");
  await expect(page.locator("#results-list")).toContainText("Glasgow West End");
});

test("applies the Edinburgh Shawfair country override (England -> Scotland)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#q", "Shawfair");
  const li = page.locator("#results-list li", { hasText: "Edinburgh Shawfair" }).first();
  await expect(li.locator(".cl")).toHaveText("Scotland");
  // and it carries through to the club header after selection
  await li.click();
  await expect(page.locator("#clubsub")).toContainText("Scotland");
});

test("renders the price table 1:1 with the fixture", async ({ page }) => {
  await openWestEnd(page);

  await expect(page.locator("#clubname")).toHaveText("Glasgow West End");
  await expect(page.locator("#clubsub")).toContainText("Scotland");
  await expect(page.locator("#clubsub")).toContainText("Site #75");
  await expect(page.locator("#clubsub")).toContainText("GBP");

  // headers: Individual, then Couple flagged per-person; no Family column
  await expect(page.locator("#thead-row th").nth(1)).toContainText("Individual");
  const coupleTh = page.locator("#thead-row th").nth(2);
  await expect(coupleTh).toContainText("Couple");
  await expect(coupleTh.locator(".th-sub")).toHaveText("per person");
  await expect(page.locator("#thead-row th").filter({ hasText: "Family" })).toHaveCount(0);

  // most-popular plan with correct per-person prices + joining fee
  const plat = page.locator("#tbody tr", { has: page.locator(".pn-name", { hasText: "Club Platinum" }) });
  await expect(plat.locator(".pop")).toHaveText("Most popular");
  await expect(plat.locator("td.cell").nth(0)).toContainText("£159");
  await expect(plat.locator("td.cell").nth(0)).toContainText("/mo");
  await expect(plat.locator("td.cell").nth(1)).toContainText("£139");
  await expect(plat).toContainText("+ £150 joining");
  // the raw plan key is no longer exposed on the frontend
  await expect(page.locator("#tbody .pk")).toHaveCount(0);
  // each plan carries a "?" info button
  await expect(plat.locator(".pn-info")).toBeVisible();

  // a plan with no couple rate shows an em dash, not a fabricated price
  const club = page.locator("#tbody tr", { has: page.locator(".pn-name", { hasText: /^Club$/ }) });
  await expect(club.locator("td.cell").nth(0)).toContainText("£114");
  await expect(club.locator("td").nth(2)).toHaveClass(/na/);
  await expect(club.locator("td").nth(2)).toContainText("—");
});

test("the plan ? button opens a details modal (description + benefits)", async ({ page }) => {
  await openWestEnd(page);
  const plat = page.locator("#tbody tr", { has: page.locator(".pn-name", { hasText: "Club Platinum" }) });
  await plat.locator(".pn-info").click();
  await expect(page.locator("#planmodal")).toBeVisible();
  await expect(page.locator("#plantitle")).toContainText("Club Platinum");
  await expect(page.locator("#planbens .ben").first()).toBeVisible();
  await page.locator("#planmodal .modal-x").click();
  await expect(page.locator("#planmodal")).toBeHidden();
});

test("lists accessible clubs from clubsInTheSameTierOrLower", async ({ page }) => {
  await openWestEnd(page);
  const summary = page.locator("#tbody details.access summary").first();
  await expect(summary).toContainText("Clubs you can access");
});

test("switches duration to Annual and updates units + note", async ({ page }) => {
  await openWestEnd(page);
  await page.locator('#durations button[data-dur="ANNUAL"]').click();
  await expect(page.locator("#foot-note")).toContainText("annual total");
  await expect(page.locator("#tbody")).toContainText("/yr");
});

test("builds a shareable image + link", async ({ page }) => {
  await openWestEnd(page);
  await page.locator("#share").click();
  await expect(page.locator("#sharemodal")).toBeVisible();
  const src = await page.locator("#share-preview").getAttribute("src");
  expect(src).toMatch(/^data:image\/png/);
  await expect(page.locator("#share-link")).toContainText(
    "dylnyko.github.io/davidlloyd-price-index/?club=glasgow-west-end"
  );
});

test("deep-links restore a club from the URL", async ({ page }) => {
  await page.goto("/?club=glasgow-west-end");
  await expect(page.locator("#clubname")).toHaveText("Glasgow West End");
});

test("shows a club profile card with facility badges (#3/#4)", async ({ page }) => {
  await openWestEnd(page);
  const profile = page.locator("#profile");
  await expect(profile).toBeVisible();
  await expect(profile.locator(".pf-head h3")).toContainText("facilities");
  const badges = profile.locator(".badge");
  await expect(badges.filter({ hasText: "Pool" })).toHaveCount(1);
  await expect(badges.filter({ hasText: "Tennis" })).toHaveCount(1);
  // opening hours + phone from the club record
  await expect(profile).toContainText("Opening hours");
  await expect(profile).toContainText(detail.telephone || detail.club?.telephone || "");
});

test("surfaces live promotions per plan on a duration that has them (#10)", async ({ page }) => {
  await openWestEnd(page);
  await page.locator('#durations button[data-dur="FLEXIBLE"]').click();
  // legend appears
  const promos = page.locator("#promos");
  await expect(promos).toBeVisible();
  await expect(promos.locator(".promo-k")).toContainText("Offers");
  // offers render as chips on the plan rows they apply to — not globally
  const offers = page.locator("#tbody .offers .offer");
  expect(await offers.count()).toBeGreaterThan(0);
});

test("opens the national price league and ranks clubs cheapest-first (#6)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav button[data-view="league"]').click();
  const table = page.locator("#league-table");
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(20);
  // prices must be non-decreasing down the table
  const prices = await table.locator("tbody td.lg-price").allInnerTexts();
  const nums = prices.map((t) => parseFloat(t.replace(/[^0-9.]/g, "")));
  for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
  // clicking a row jumps back to that club's lookup
  await rows.first().click();
  await expect(page.locator("#pricetable")).toBeVisible();
});

test("price league is URL-driven and deep-linkable (#6)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav button[data-view="league"]').click();
  await expect(page.locator("#league-table")).toBeVisible();
  await expect(page).toHaveURL(/view=league/);
  await page.selectOption("#lg-dur", "A");
  await expect(page).toHaveURL(/term=A/);
  // direct deep link restores the view and the chosen metric
  await page.goto("/?view=league&plan=CLUB_PLATINUM&who=i&term=A");
  await expect(page.locator("#league-table")).toBeVisible();
  await expect(page.locator("#lg-dur")).toHaveValue("A");
});

test("facilities league ranks clubs by racquet courts (#facilities)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav button[data-view="facilities"]').click();
  const table = page.locator("#fac-table");
  await expect(table).toBeVisible();
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(20);
  await expect(page).toHaveURL(/view=facilities/);
  // court counts are non-increasing down the ranking
  const vals = (await table.locator("tbody td.lg-price").allInnerTexts()).map((t) => parseInt(t, 10));
  for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  // deep link with a per-sport metric restores it
  await page.goto("/?view=facilities&metric=Tennis");
  await expect(page.locator("#fac-table")).toBeVisible();
  await expect(page.locator("#fac-metric")).toHaveValue("Tennis");
});

test("ranks clubs by distance from a postcode (#1)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#nm-pc", "G1 1AA");
  await page.locator("#nm-form button[type=submit]").click();
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  // focus search to show the distance-sorted dropdown
  await page.locator("#q").click();
  await expect(page.locator("#results-list .cl.mi").first()).toContainText("mi");
});

test("club view is served from the committed bundle — no per-club DL calls (#12)", async ({ page }) => {
  const dlCalls = [];
  // The shared mock 404s data/clubs to force fallbacks elsewhere; here we want the
  // real committed bundles served from the repo, so lift that interception.
  await page.unroute(/\/data\/clubs\//);
  await page.route(/fonts\.(googleapis|gstatic)\.com|cloudflareinsights\.com/, (r) => r.abort());
  await page.route(/mobile-app-back\.davidlloyd\.co\.uk/, (route) => {
    const u = route.request().url();
    dlCalls.push(u);
    // Only the club list is allowed live; any per-club endpoint must NOT be needed.
    if (/\/clubs(\?|$)/.test(u))
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(clubs) });
    return route.abort();
  });
  // data/clubs/75.json, data/latest.json etc. are served from the repo by the web server.
  await page.goto("/?club=glasgow-west-end");
  await expect(page.locator("#pricetable")).toBeVisible();
  await expect(page.locator("#profile")).toBeVisible();
  const perClub = dlCalls.filter((u) =>
    /packages\/online|membership-settings|accessible-clubs|\/clubs\/\d+(\?|$)/.test(u)
  );
  expect(perClub).toHaveLength(0);
});

test("remembers the postcode across refresh via the URL (#1)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#nm-pc", "G1 1AA");
  await page.locator("#nm-form button[type=submit]").click();
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  await expect(page).toHaveURL(/pc=/);
  // arriving fresh with the pc in the URL restores it (as a refresh would)
  await page.goto("/?pc=G1%201AA");
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  await expect(page.locator("#nm-pc")).toHaveValue("G1 1AA");
});

test("compare view puts clubs side by side (#13)", async ({ page }) => {
  await page.goto("/?view=compare");
  await expect(page.locator("#compare")).toBeVisible();
  expect(await page.locator('.cmp-pick[data-i="0"] option').count()).toBeGreaterThan(50);
  await page.selectOption('.cmp-pick[data-i="0"]', { index: 1 });
  await expect(page.locator("#cmp-table")).toBeVisible();
  expect(await page.locator("#cmp-table tbody tr").count()).toBeGreaterThan(0);
});

test("compare button on a club opens Compare pre-filled (#13)", async ({ page }) => {
  await page.goto("/?club=glasgow-west-end");
  await expect(page.locator("#do-compare")).toBeVisible();
  await page.locator("#do-compare").click();
  await expect(page.locator("#compare")).toBeVisible();
  await expect(page.locator('.cmp-pick[data-i="0"]')).toHaveValue("Glasgow West End");
  await expect(page.locator("#cmp-table")).toBeVisible();
  // Back returns to the club you came from
  await page.locator("#cmp-back").click();
  await expect(page.locator("#pricetable")).toBeVisible();
  await expect(page.locator("#clubname")).toHaveText("Glasgow West End");
});

test("biggest movers view loads with an empty state before history accrues (#16)", async ({ page }) => {
  await page.goto("/?view=movers");
  await expect(page.locator("#movers")).toBeVisible();
  await expect(page.locator("#mov-empty")).toBeVisible();
});

test("hides the Movers tab until there are movers (#16)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('.nav button[data-view="movers"]')).toBeHidden();
});

test("map view builds its controls (#14)", async ({ page }) => {
  await page.goto("/?view=map");
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#mp-plan")).toBeVisible();
});

test("league is scoped to one currency (#15)", async ({ page }) => {
  await page.goto("/?view=league&cur=EUR");
  await expect(page.locator("#league-table")).toBeVisible();
  // every country shown should be a EUR one (no UK clubs mixed in)
  const countries = await page.locator("#league-table tbody .lg-country").allInnerTexts();
  expect(countries.length).toBeGreaterThan(0);
  expect(countries.includes("England")).toBeFalsy();
});

test("shows a staleness banner when the snapshot is over a week old", async ({ page }) => {
  await page.route(/\/data\/latest\.json/, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      generatedAt: "2020-01-01T00:00:00Z", date: "2020-01-01", count: 1, sports: {},
      clubs: [{ siteId: 75, name: "Glasgow West End", country: "Scotland", currency: "GBP", plans: {} }],
    }) })
  );
  await page.goto("/");
  await expect(page.locator("#stale")).toBeVisible();
  await expect(page.locator("#stale")).toContainText("out of date");
});

test("duration control does not overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openWestEnd(page);
  // no horizontal page overflow
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  expect(overflow).toBeFalsy();
  // segmented control stacked full-width (each button ~ container width)
  const wrap = await page.locator("#durations").boundingBox();
  const btn = await page.locator("#durations button").first().boundingBox();
  expect(btn.width).toBeGreaterThan(wrap.width * 0.8);
});
