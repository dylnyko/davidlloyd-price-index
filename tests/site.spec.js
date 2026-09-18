// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const FX = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", p), "utf8"));
const clubs = FX("clubs.json");
const packages = FX("packages_75.json");
const settings = FX("settings_75.json");
const accessible = FX("accessible_75.json");

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
    if (/\/clubs(\?|$)/.test(url)) return json(clubs);
    return route.continue();
  });
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
  await expect(page.locator("#clubcount")).toHaveText("160");
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

test("country override applies even to a stale cached club list", async ({ page }) => {
  // Simulate a returning visitor whose localStorage holds the pre-fix list
  // (Shawfair tagged England). The override must still correct it on read.
  await page.addInitScript(() => {
    localStorage.setItem(
      "pb_clubs",
      JSON.stringify({
        t: Date.now(),
        ttl: 86400000,
        d: [
          { siteId: 156, clubName: "Edinburgh Shawfair", country: "England", currency: "GBP", status: "active" },
          { siteId: 75, clubName: "Glasgow West End", country: "Scotland", currency: "GBP", status: "active" },
        ],
      })
    );
  });
  await page.goto("/");
  await page.fill("#q", "Shawfair");
  await expect(
    page.locator("#results-list li", { hasText: "Edinburgh Shawfair" }).first().locator(".cl")
  ).toHaveText("Scotland");
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
  const plat = page.locator("#tbody tr", { has: page.locator(".pk", { hasText: "CLUB_PLATINUM" }) });
  await expect(plat.locator(".pn")).toContainText("Club Platinum");
  await expect(plat.locator(".pop")).toHaveText("Most popular");
  await expect(plat.locator("td.cell").nth(0)).toContainText("£159");
  await expect(plat.locator("td.cell").nth(0)).toContainText("/mo");
  await expect(plat.locator("td.cell").nth(1)).toContainText("£139");
  await expect(plat).toContainText("+ £150 joining");

  // a plan with no couple rate shows an em dash, not a fabricated price
  const club = page.locator("#tbody tr", { has: page.locator(".pk", { hasText: /^CLUB$/ }) });
  await expect(club.locator("td.cell").nth(0)).toContainText("£114");
  await expect(club.locator("td").nth(2)).toHaveClass(/na/);
  await expect(club.locator("td").nth(2)).toContainText("—");
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
