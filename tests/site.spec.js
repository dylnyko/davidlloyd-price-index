// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const FX = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", p), "utf8"));
const clubs = FX("clubs.json");

// The homepage (search, league, facilities, map, compare, movers, near-me) is
// backend-free: it reads the committed nightly JSON served straight from the repo
// (data/latest.json, facilities.json, …). Per-club prices live on the static
// /clubs/<slug>/ pages, also committed. So we serve the real repo and only stub
// the few outbound calls the homepage can still make: the live /clubs fallback,
// fonts/analytics (blocked), and the postcode geocoder.
async function mockNet(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com|cloudflareinsights\.com/, (r) => r.abort());
  // Live /clubs is only a fallback (latest.json normally wins); keep it deterministic.
  await page.route(/mobile-app-back\.davidlloyd\.co\.uk\/clubs(\?|$)/, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(clubs) })
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

test.beforeEach(async ({ page }) => {
  await mockNet(page);
});

/* ---------------------------------------------------------------- homepage -- */

test("boots, counts clubs and filters the search", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => Number(await page.locator("#clubcount").textContent()))
    .toBeGreaterThan(100);
  await page.locator("#q").click();
  await expect(page.locator("#results-list li").first()).toBeVisible();
  await page.fill("#q", "glasgow");
  await expect(page.locator("#results-list")).toContainText("Glasgow West End");
});

test("shows the Edinburgh Shawfair country override in the dropdown (England -> Scotland)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#q", "Shawfair");
  const li = page.locator("#results-list li", { hasText: "Edinburgh Shawfair" }).first();
  await expect(li.locator(".cl")).toHaveText("Scotland");
});

test("a search selection navigates to the club's static page", async ({ page }) => {
  await page.goto("/");
  await page.fill("#q", "glasgow west end");
  await page.locator("#results-list li", { hasText: "Glasgow West End" }).first().click();
  await expect(page).toHaveURL(/\/clubs\/glasgow-west-end\/$/);
  await expect(page.locator("#pricetable")).toBeVisible();
});

test("pressing Enter in the search navigates to the top match", async ({ page }) => {
  await page.goto("/");
  await page.fill("#q", "glasgow west end");
  await page.locator("#q").press("Enter");
  await expect(page).toHaveURL(/\/clubs\/glasgow-west-end\/$/);
});

test("a set postcode carries into the club link (?pc=)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#nm-pc", "G1 1AA");
  await page.locator("#nm-form button[type=submit]").click();
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  await page.fill("#q", "glasgow west end");
  await page.locator("#q").press("Enter");
  await expect(page).toHaveURL(/\/clubs\/glasgow-west-end\/\?pc=G1(%20|\+)?1AA/);
});

test("ranks clubs by distance from a postcode (#1)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#nm-pc", "G1 1AA");
  await page.locator("#nm-form button[type=submit]").click();
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  await page.locator("#q").click();
  await expect(page.locator("#results-list .cl.mi").first()).toContainText("mi");
});

test("remembers the postcode across refresh via the URL (#1)", async ({ page }) => {
  await page.goto("/");
  await page.fill("#nm-pc", "G1 1AA");
  await page.locator("#nm-form button[type=submit]").click();
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  await expect(page).toHaveURL(/pc=/);
  await page.goto("/?pc=G1%201AA");
  await expect(page.locator("#nm-status")).toContainText("nearest is");
  await expect(page.locator("#nm-pc")).toHaveValue("G1 1AA");
});

test("opens the national price league and ranks clubs cheapest-first (#6)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav button[data-view="league"]').click();
  const table = page.locator("#league-table");
  await expect(table).toBeVisible();
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(20);
  const prices = await table.locator("tbody td.lg-price").allInnerTexts();
  const nums = prices.map((t) => parseFloat(t.replace(/[^0-9.]/g, "")));
  for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
  // clicking a row navigates to that club's static page
  await table.locator("tbody tr").first().click();
  await expect(page).toHaveURL(/\/clubs\/[a-z0-9-]+\/(\?|$)/);
  await expect(page.locator("#pricetable")).toBeVisible();
});

test("price league is URL-driven and deep-linkable (#6)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav button[data-view="league"]').click();
  await expect(page.locator("#league-table")).toBeVisible();
  await expect(page).toHaveURL(/view=league/);
  await page.selectOption("#lg-dur", "A");
  await expect(page).toHaveURL(/term=A/);
  await page.goto("/?view=league&plan=CLUB_PLATINUM&who=i&term=A");
  await expect(page.locator("#league-table")).toBeVisible();
  await expect(page.locator("#lg-dur")).toHaveValue("A");
});

test("league is scoped to one currency (#15)", async ({ page }) => {
  await page.goto("/?view=league&cur=EUR");
  await expect(page.locator("#league-table")).toBeVisible();
  const countries = await page.locator("#league-table tbody .lg-country").allInnerTexts();
  expect(countries.length).toBeGreaterThan(0);
  expect(countries.includes("England")).toBeFalsy();
});

test("facilities league ranks clubs by racquet courts (#facilities)", async ({ page }) => {
  await page.goto("/");
  await page.locator('.nav button[data-view="facilities"]').click();
  const table = page.locator("#fac-table");
  await expect(table).toBeVisible();
  expect(await table.locator("tbody tr").count()).toBeGreaterThan(20);
  await expect(page).toHaveURL(/view=facilities/);
  const vals = (await table.locator("tbody td.lg-price").allInnerTexts()).map((t) => parseInt(t, 10));
  for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
  await page.goto("/?view=facilities&metric=Tennis");
  await expect(page.locator("#fac-table")).toBeVisible();
  await expect(page.locator("#fac-metric")).toHaveValue("Tennis");
});

test("facilities row navigates to the club's static page", async ({ page }) => {
  await page.goto("/?view=facilities");
  await expect(page.locator("#fac-table")).toBeVisible();
  await page.locator("#fac-table tbody tr").first().click();
  await expect(page).toHaveURL(/\/clubs\/[a-z0-9-]+\/(\?|$)/);
});

test("compare view puts clubs side by side (#13)", async ({ page }) => {
  await page.goto("/?view=compare");
  await expect(page.locator("#compare")).toBeVisible();
  expect(await page.locator('.cmp-pick[data-i="0"] option').count()).toBeGreaterThan(50);
  await page.selectOption('.cmp-pick[data-i="0"]', { index: 1 });
  await expect(page.locator("#cmp-table")).toBeVisible();
  expect(await page.locator("#cmp-table tbody tr").count()).toBeGreaterThan(0);
});

test("map view builds its controls (#14)", async ({ page }) => {
  await page.goto("/?view=map");
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#mp-plan")).toBeVisible();
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

/* ----------------------------------------------------- static club pages -- */

const WE = "/clubs/glasgow-west-end/";

test("club page is pre-rendered with prices, SEO title and canonical", async ({ page }) => {
  await page.goto(WE);
  await expect(page).toHaveTitle(/Glasgow West End membership prices \| Rack Rate/);
  const canon = await page.locator('link[rel="canonical"]').getAttribute("href");
  expect(canon).toMatch(/\/clubs\/glasgow-west-end\/$/);
  // table is in the served HTML (not built client-side): visible immediately.
  await expect(page.locator("#pricetable")).toBeVisible();
  await expect(page.locator("#clubname")).toHaveText("Glasgow West End");
  await expect(page.locator("#clubcountry")).toHaveText("Scotland");
  // headers: Individual, then Couple flagged per-person; no Family column
  await expect(page.locator("#thead-row th").nth(1)).toContainText("Individual");
  const coupleTh = page.locator("#thead-row th").nth(2);
  await expect(coupleTh).toContainText("Couple");
  await expect(coupleTh.locator(".th-sub")).toHaveText("per person");
  await expect(page.locator("#thead-row th").filter({ hasText: "Family" })).toHaveCount(0);
  // the raw plan key is never exposed
  await expect(page.locator("#tbody .pk")).toHaveCount(0);
  expect(await page.locator("#tbody tr").count()).toBeGreaterThan(1);
});

test("club page carries a Product/AggregateOffer JSON-LD block", async ({ page }) => {
  await page.goto(WE);
  const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
  const data = JSON.parse(ld);
  expect(data["@type"]).toBe("Product");
  expect(data.offers["@type"]).toBe("AggregateOffer");
  expect(data.offers.priceCurrency).toBe("GBP");
  expect(data.offers.lowPrice).toBeLessThanOrEqual(data.offers.highPrice);
});

test("club page: the plan ? button opens a details modal", async ({ page }) => {
  await page.goto(WE);
  await page.locator("#tbody .pn-more").first().click();
  await expect(page.locator("#planmodal")).toBeVisible();
  await expect(page.locator("#plantitle")).not.toHaveText("—");
  await page.locator("#planmodal .modal-x").click();
  await expect(page.locator("#planmodal")).toBeHidden();
});

test("club page: switching duration to Annual updates units + note", async ({ page }) => {
  await page.goto(WE);
  await page.locator('#durations button[data-dur="ANNUAL"]').click();
  await expect(page.locator("#foot-note")).toContainText("annual total");
  await expect(page.locator("#tbody")).toContainText("/yr");
});

test("club page: builds a shareable image", async ({ page }) => {
  await page.goto(WE);
  await page.locator("#share").click();
  await expect(page.locator("#sharemodal")).toBeVisible();
  const src = await page.locator("#share-preview").getAttribute("src");
  expect(src).toMatch(/^data:image\/png/);
  // share link is derived from the page's own URL (no hardcoded origin)
  await expect(page.locator("#share-link")).toContainText("/clubs/glasgow-west-end/");
});

test("club page: shows a profile card with facility badges (#3/#4)", async ({ page }) => {
  await page.goto(WE);
  const profile = page.locator("#profile");
  await expect(profile).toBeVisible();
  await expect(profile.locator(".pf-head h3")).toContainText("facilities");
  expect(await profile.locator(".badge").count()).toBeGreaterThan(0);
});

test("club page: Back returns to the homepage lookup", async ({ page }) => {
  await page.goto(WE);
  await expect(page.locator(".backbtn")).toHaveAttribute("href", "../../");
  await page.locator(".backbtn").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".search")).toBeVisible();
});

test("club page reflects the Shawfair country override (Scotland)", async ({ page }) => {
  await page.goto("/clubs/edinburgh-shawfair/");
  await expect(page.locator("#clubname")).toHaveText("Edinburgh Shawfair");
  await expect(page.locator("#clubcountry")).toHaveText("Scotland");
});

test("club page carries the postcode into the Compare link (?pc=)", async ({ page }) => {
  await page.goto(WE + "?pc=G1%201AA");
  await expect(page.locator("#clubsub")).toContainText("mi");
});

test("club page does not overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(WE);
  await expect(page.locator("#pricetable")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  expect(overflow).toBeFalsy();
});
