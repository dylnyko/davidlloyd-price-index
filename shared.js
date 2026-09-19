/* Rack Rate — shared display logic (single source of truth).
 * String builders used BOTH in the browser (app.js) and in Node
 * (scripts/snapshot.mjs, to pre-render static per-club pages). UMD so it works as
 * a browser global (window.PB) and a Node import. The builders are pure; the one
 * DOM helper (initScrollShadows) only touches the document when called, so
 * importing this in Node stays side-effect-free.                                */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PB = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Individual = one person; Couple = per person on a joint membership. Family is
  // excluded (whole-family total, undefined composition — inconsistent).
  const TYPES = ["INDIVIDUAL", "COUPLE"];
  const TYPE_LABEL = { INDIVIDUAL: "Individual", COUPLE: "Couple", FAMILY: "Family" };
  const TYPE_FIELD = { INDIVIDUAL: "individual", COUPLE: "couple", FAMILY: "family" };
  const DUR_ORDER = ["STANDARD", "FLEXIBLE", "ANNUAL"];
  const DUR_LABEL = { STANDARD: "Standard · 12-mo", FLEXIBLE: "Flexible · 3-mo", ANNUAL: "Annual · paid yearly" };
  const RACQUET_IDS = [13, 14, 15, 19, 22];

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (pennies, cur) => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, minimumFractionDigits: 0, maximumFractionDigits: pennies % 100 ? 2 : 0 }).format(pennies / 100);
  const prettyPlan = (key) => key.toLowerCase().split("_")
    .map((w) => (w === "dl" ? "DL" : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")
    .replace(/\bPlatinum Home\b/, "Platinum (Home)").replace(/2$/, "");
  const benefitsOf = (pkg) => ((pkg.packageInformationGroupedByType || {}).BENEFIT || [])
    .slice().sort((a, b) => (a.orderingPriority == null ? 999 : a.orderingPriority) - (b.orderingPriority == null ? 999 : b.orderingPriority))
    .map((b) => ((b.displayTextByLanguage || {})["en-gb"] || {}).text).filter(Boolean);
  const descOf = (pkg) => (((pkg.packageInformationGroupedByType || {}).DESCRIPTION || [])
    .map((d) => ((d.displayTextByLanguage || {})["en-gb"] || {}).text).filter(Boolean)[0]) || "";
  const planRank = (p) => p.startsWith("CLUB") ? 0 : p.startsWith("JUNIOR") ? 1 : p.startsWith("YOUNG_ADULT") ? 2 : p.startsWith("TEAM") ? 3 : 4;
  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return iso; } };

  // Human offer text from a promotion: DL's own copy, then a derived saving, then a cleaned name.
  function promoText(pm) {
    const en = (pm.textByLanguage || {})["en-gb"] || {};
    let t = (en.shortDescription || en.rateCardBannerTitle || "").trim();
    if (!t) {
      const it = (pm.promotionItems || [])[0];
      if (it) {
        const what = it.type === "JOINING_FEE" ? "joining fee" : String(it.type || "").toLowerCase().replace(/_/g, " ");
        if (it.savingType === "PERCENTAGE" && it.savingAmount) t = it.savingAmount >= 100 ? "Free " + what : `${(+it.savingAmount).toFixed(0)}% off ${what}`;
        else if (it.savingType === "AMOUNT" && it.savingAmount) t = `Money off ${what}`;
      }
    }
    if (!t) {
      t = (pm.name || "").replace(/^[A-Z0-9]+(?:\s+[A-Z0-9/]+)*\s+-\s+/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (/lead|copy|part\s*\d/i.test(pm.name || "") && !/joining|free|off|month/i.test(t)) t = "";
    }
    return t;
  }

  // Facility badges from real /clubs/{id} fields only. `sports` maps sportId -> name.
  function facilitiesOf(detail, sports) {
    sports = sports || {};
    const f = [];
    if (detail.pool || detail.swimmingEmailAddress) f.push({ k: "Pool" });
    if (detail.isBlaze) f.push({ k: "Blaze", hot: true });
    if (detail.spa || detail.spaBookingsEmailAddress) f.push({ k: "Spa" });
    (detail.sportIdsAvailable || []).filter((id) => RACQUET_IDS.includes(id)).map((id) => sports[id]).filter(Boolean).forEach((r) => f.push({ k: r }));
    if (detail.isAdultOnly) f.push({ k: "Adults only", hot: true });
    return f;
  }

  function openHoursHtml(detail) {
    const w = (detail.clubOpeningTimes || {}).weeklyOpeningTimes; if (!w) return "";
    const days = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
    const rng = (list) => (list && list.length) ? list.map((s) => `${s.from}–${s.to}`).join(", ") : "Closed";
    return `<div class="hours">` + days.map(([k, lbl]) => `<div class="hrow"><span class="hd">${lbl}</span><span class="ht">${esc(rng(w[k]))}</span></div>`).join("") + `</div>`;
  }

  /* The price table — the single markup used on the live page and the static pages.
   * opts: { packages, addOns, dur, currency, mostPopular, accessNames, trend }
   *  - accessNames: { packageKey: [clubName,...] } (already resolved to names)
   *  - trend: optional (key) => {delta, since, up} | null  (browser only)
   * Returns { empty } or { thead, tbody, addonsHTML, planinfo, count }.        */
  function priceTableHTML(opts) {
    const { packages, addOns, dur, currency, mostPopular, accessNames = {}, trend = null } = opts;
    const unit = dur === "ANNUAL" ? "/yr" : "/mo";
    const priceAt = (p, t) => { const d = p.prices && p.prices[dur]; const v = d && d[TYPE_FIELD[t]]; return v == null ? null : v; };
    const pkgs = (packages || []).filter((p) => TYPES.some((t) => priceAt(p, t) != null));
    if (!pkgs.length) return { empty: true };
    const activeTypes = TYPES.filter((t) => pkgs.some((p) => priceAt(p, t) != null));
    const minAmt = (p) => Math.min.apply(null, activeTypes.map((t) => priceAt(p, t) == null ? Infinity : priceAt(p, t)));
    pkgs.sort((a, b) => (planRank(a.packageKey) - planRank(b.packageKey)) || (minAmt(a) - minAmt(b)) || a.packageKey.localeCompare(b.packageKey));

    const thead = `<th>Plan</th>` + activeTypes.map((t) => `<th>${TYPE_LABEL[t]}${t === "INDIVIDUAL" ? "" : `<span class="th-sub">per person</span>`}</th>`).join("");
    const planinfo = {};
    const tbody = pkgs.map((p) => {
      const jf = p.prices[dur].joiningFee || 0;
      const bens = benefitsOf(p);
      const desc = descOf(p);
      const accNames = accessNames[p.packageKey] || [];
      const pop = p.packageKey === mostPopular ? `<span class="pop">Most popular</span>` : "";
      const offers = Array.from(new Set((p.prices[dur].promotions || []).filter((pm) => !pm.inHiddenMenuInClub).map(promoText).filter(Boolean)));
      const offerHtml = offers.length ? `<div class="offers">${offers.map((t) => `<span class="offer">★ ${esc(t)}</span>`).join("")}</div>` : "";
      const tr = trend ? trend(p.packageKey) : null;
      const trendHtml = tr ? `<div class="trend ${tr.up ? "up" : "down"}" title="Individual ${DUR_LABEL[dur]} price change">${tr.up ? "▲" : "▼"} ${fmt(Math.abs(tr.delta), currency)} since ${esc(fmtDate(tr.since))}</div>` : "";
      const cells = activeTypes.map((t) => {
        const v = priceAt(p, t);
        if (v == null) return `<td class="cell na">—</td>`;
        return `<td class="cell"><div class="mo">${fmt(v, currency)}<span class="per">${unit}</span></div>` +
          `<div class="join">${jf ? `+ ${fmt(jf, currency)} joining` : `no joining fee`}</div></td>`;
      }).join("");
      const descHtml = desc ? `<div class="pdesc">${esc(desc)}</div>` : "";
      const hasMore = bens.length || accNames.length || desc;
      if (hasMore) planinfo[p.packageKey] = { name: prettyPlan(p.packageKey), desc, bens, access: accNames };
      const bits = [];
      if (bens.length) bits.push(`${bens.length} perk${bens.length > 1 ? "s" : ""}`);
      if (accNames.length) bits.push(`${accNames.length} clubs you can access`);
      const moreHtml = hasMore ? `<button class="pn-more" type="button" data-key="${esc(p.packageKey)}">What’s included${bits.length ? ` · ${bits.join(" · ")}` : ""} <span class="chev">›</span></button>` : "";
      return `<tr><td class="plan"><div class="pn"><span class="pn-name">${prettyPlan(p.packageKey)}</span>${pop}</div>${descHtml}${offerHtml}${trendHtml}${moreHtml}</td>${cells}</tr>`;
    }).join("");

    const ao = (addOns || []).map((a) => { const d = a.prices && a.prices[dur]; if (!d || d.price == null) return null; return `${prettyPlan(a.addOnKey)} ${fmt(d.price, currency)}${unit}`; }).filter(Boolean);
    const addonsHTML = ao.length ? `<span class="ao-k">Add-ons</span> ${ao.join(" · ")}` : "";
    return { thead, tbody, addonsHTML, planinfo, count: pkgs.length, activeTypes, pkgs };
  }

  function profileHTML(detail, sports) {
    if (!detail) return "";
    const badges = facilitiesOf(detail, sports);
    const badgeHtml = badges.length ? `<div class="badges">` + badges.map((b) => `<span class="badge${b.hot ? " hot" : ""}">${esc(b.k)}</span>`).join("") + `</div>` : "";
    const courtsBySport = {};
    for (const c of (detail.courts || [])) { const n = (sports || {})[c.sportId]; if (n) courtsBySport[n] = (courtsBySport[n] || 0) + 1; }
    const courtsHtml = Object.keys(courtsBySport).length
      ? `<div class="pf-item"><span class="pf-k">Racquet courts</span><span class="pf-v">${Object.entries(courtsBySport).sort((a, b) => b[1] - a[1]).map(([n, ct]) => `${ct} ${esc(n)}`).join(" · ")}</span></div>` : "";
    const telHtml = detail.telephone ? `<div class="pf-item"><span class="pf-k">Phone</span><span class="pf-v"><a href="tel:${esc((detail.telephone || "").replace(/\s+/g, ""))}">${esc(detail.telephone)}</a></span></div>` : "";
    const hours = openHoursHtml(detail);
    const hoursHtml = hours ? `<div class="pf-item pf-hours"><span class="pf-k">Opening hours</span>${hours}</div>` : "";
    return `<div class="pf-head"><h3>Club facilities</h3>${badgeHtml}</div><div class="pf-grid">${telHtml}${courtsHtml}${hoursHtml}</div>`;
  }

  /* Flags which edges of each .tablewrap still have table to reach, so the CSS can
   * show that edge's scroll-shadow ("l"/"r" in data-sx). Called by app.js and
   * club.js on load; the league tables are built after that and the compare table
   * is rebuilt on every pick, so a ResizeObserver re-measures rather than the
   * callers having to remember to. */
  function initScrollShadows(scope) {
    const root = scope || document;
    const update = (el) => {
      const max = el.scrollWidth - el.clientWidth, x = el.scrollLeft;
      // 1px slack: sub-pixel widths otherwise leave an edge stuck on at the end.
      el.dataset.sx = `${x > 1 ? "l" : ""} ${x < max - 1 ? "r" : ""}`.trim();
    };
    for (const el of root.querySelectorAll(".tablewrap")) {
      update(el);
      el.addEventListener("scroll", () => update(el), { passive: true });
      if (typeof ResizeObserver === "function") new ResizeObserver(() => update(el)).observe(el);
    }
  }

  return { TYPES, TYPE_LABEL, TYPE_FIELD, DUR_ORDER, DUR_LABEL, RACQUET_IDS,
    esc, fmt, prettyPlan, benefitsOf, descOf, planRank, slugify, fmtDate, promoText,
    facilitiesOf, openHoursHtml, priceTableHTML, profileHTML, initScrollShadows };
});
