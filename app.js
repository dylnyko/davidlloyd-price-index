/* The Price Book — independent, unofficial David Lloyd price lookup.
 * Self-updating & backend-free: the club list and every club's plans, prices
 * and plan benefits come live from David Lloyd's own public endpoints, so new
 * clubs and new plans appear on their own.                                    */
"use strict";

const API = "https://mobile-app-back.davidlloyd.co.uk";
const DAY = 864e5;

// Individual = one person; Couple = PER PERSON on a joint membership. Family is
// deliberately excluded: it only exists as a rare bundled FAMILY_* package priced
// as a whole-family total (inconsistent with the per-person couple rate) and the
// API doesn't define what it includes — so it's dropped rather than misrepresented.
const TYPES = ["INDIVIDUAL","COUPLE"];                          // column order
const TYPE_LABEL = { INDIVIDUAL:"Individual", COUPLE:"Couple", FAMILY:"Family" };
const TYPE_FIELD = { INDIVIDUAL:"individual", COUPLE:"couple", FAMILY:"family" };
const DUR_ORDER  = ["STANDARD","FLEXIBLE","ANNUAL"];
// Match David Lloyd's own wording: Standard = 12-month term (best value),
// Flexible = 3-month term, Annual = paid yearly.
const DUR_LABEL  = { STANDARD:"Standard · 12-mo", FLEXIBLE:"Flexible · 3-mo", ANNUAL:"Annual · paid yearly" };

const qs = s => document.querySelector(s);
// No browser storage: all data is same-origin static JSON (HTTP-cached by the
// browser) plus in-memory caches for the current visit, so nothing is persisted.
const cacheGet = () => null;
const cacheSet = () => {};

// David Lloyd's /clubs feed mis-tags a few clubs' country (audited 18 Sep 2026:
// only Edinburgh Shawfair, site 156, is wrong — "England" vs "Scotland"). The
// snapshot already corrects it, and this belt-and-braces override covers the
// live-fallback path too.
const COUNTRY_FIX = { 156: "Scotland" };
const fixCountry = c => COUNTRY_FIX[c.siteId] ? {...c, country: COUNTRY_FIX[c.siteId]} : c;

/* ---- data ---- */
// Club list comes from the committed snapshot (data/latest.json) so a normal
// visit makes no calls to David Lloyd at all; live /clubs is only a fallback.
async function getClubs(){
  let clubs;
  try{
    const L = await getLatest();
    if(L && L.clubs && L.clubs.length)
      clubs = L.clubs.map(c=>({ clubName:c.name, siteId:c.siteId, country:c.country, currency:c.currency }));
  }catch{}
  if(!clubs){
    const r = await fetch(`${API}/clubs`); const j = await r.json();
    clubs = (j.clubs||[]).filter(c=>c.status==="active")
      .map(c=>({ clubName:c.clubName, siteId:c.siteId, country:c.country, currency:c.currency }));
  }
  clubs.sort((a,b)=>a.clubName.localeCompare(b.clubName));
  return clubs.map(fixCountry);
}
// Everything a club page renders is served from a committed nightly bundle
// (data/clubs/<id>.json) so visitors don't hit David Lloyd at all. If the file
// is missing (e.g. a brand-new club not yet snapshotted), fall back to the live
// endpoints so nothing breaks. One fetch per club, cached in memory + localStorage.
const _bundles = {};
async function getClubBundle(siteId){
  if(_bundles[siteId]!==undefined) return _bundles[siteId];
  const ck=`pb_bundle_${siteId}`; const c=cacheGet(ck);
  if(c){ _bundles[siteId]=c; return c; }
  let b=null;
  try{ const r=await fetch(`data/clubs/${siteId}.json?t=${Math.floor(Date.now()/36e5)}`);
    if(r.ok){ b=await r.json(); cacheSet(ck,b,DAY/2); } }catch{}
  _bundles[siteId]=b; return b;
}
async function getPackages(siteId){
  const b=await getClubBundle(siteId);
  if(b) return { packages:b.packages||[], addOns:b.addOns||[] };
  const r = await fetch(`${API}/clubs/${siteId}/packages/online`);      // live fallback
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function getSettings(siteId){
  const b=await getClubBundle(siteId);
  if(b) return b.settings||{};
  const r = await fetch(`${API}/clubs/${siteId}/membership-settings`);   // live fallback
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function getAccess(siteId, keys){                 // clubs each plan can visit
  const b=await getClubBundle(siteId);
  if(b) return b.access||{};
  const r = await fetch(`${API}/accessible-clubs`,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({siteId:String(siteId),packageKeys:keys})});     // live fallback
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json(); const map={};
  // Accessible set = clubsInTheSameTierOrLower ONLY (higher/exclusive tiers are NOT accessible).
  for(const e of (j.awayClubsByPackageKeys||[])) map[e.packageKey]=((e.awayClubs||{}).clubsInTheSameTierOrLower||[]);
  return map;
}
async function getDetail(siteId){                        // full club profile (#3/#4)
  const b=await getClubBundle(siteId);
  if(b) return b.detail||null;
  const r = await fetch(`${API}/clubs/${siteId}`);                        // live fallback
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json(); return j.club||j;
}
let SPORTS = {};                                         // sportId -> name
async function getSports(){
  if(Object.keys(SPORTS).length) return SPORTS;
  const c = cacheGet("pb_sports"); if(c){ SPORTS=c; return SPORTS; }
  try{ const r=await fetch(`${API}/sports`); const j=await r.json();
    for(const s of (j.sports||[])) SPORTS[s.sportId]=s.sportName;
    cacheSet("pb_sports", SPORTS, 7*DAY);
  }catch{}
  return SPORTS;
}
// Committed nightly data (self-hosted, same origin) — powers the league (#6),
// price trends (#12) and clubs-near-me (#1). All optional: the site works if absent.
let LATEST=null, HISTORY=null, LOCS=null;
async function getLatest(){
  if(LATEST) return LATEST;
  try{ const r=await fetch(`data/latest.json?t=${Math.floor(Date.now()/36e5)}`); LATEST=await r.json();
    if(LATEST.sports) SPORTS={...LATEST.sports, ...SPORTS}; }
  catch{ LATEST={clubs:[]}; }
  return LATEST;
}
async function getHistory(){
  if(HISTORY) return HISTORY;
  try{ const r=await fetch(`data/history.json?t=${Math.floor(Date.now()/36e5)}`); HISTORY=await r.json(); }
  catch{ HISTORY={series:{}}; }
  return HISTORY;
}
async function getLocations(){
  if(LOCS) return LOCS;
  try{ const r=await fetch(`data/locations.json?t=${Math.floor(Date.now()/36e5)}`); const j=await r.json(); LOCS=j.locations||{}; }
  catch{
    try{ const r=await fetch(`${API}/clubs/locations`); const j=await r.json(); LOCS={};
      for(const [sid,v] of Object.entries(j.clubLocations||{})){ const la=parseFloat(v.latitude),ln=parseFloat(v.longitude);
        if(isFinite(la)&&isFinite(ln)) LOCS[sid]={lat:la,lng:ln}; } }
    catch{ LOCS={}; }
  }
  return LOCS;
}

/* ---- helpers ---- */
const fmt = (pennies,cur) => new Intl.NumberFormat("en-GB",{style:"currency",currency:cur,minimumFractionDigits:0,maximumFractionDigits:pennies%100?2:0}).format(pennies/100);
const prettyPlan = key => key.toLowerCase().split("_")
  .map(w=> w==="dl"?"DL" : w.charAt(0).toUpperCase()+w.slice(1)).join(" ")
  .replace(/\bPlatinum Home\b/,"Platinum (Home)").replace(/2$/,"");
const benefitsOf = pkg => ((pkg.packageInformationGroupedByType||{}).BENEFIT||[])
  .slice().sort((a,b)=>(a.orderingPriority??999)-(b.orderingPriority??999))
  .map(b=>((b.displayTextByLanguage||{})["en-gb"]||{}).text).filter(Boolean);
const planRank = p => p.startsWith("CLUB")?0 : p.startsWith("JUNIOR")?1 : p.startsWith("YOUNG_ADULT")?2 : p.startsWith("TEAM")?3 : 4;
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const esc = s => String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// Great-circle distance in miles (haversine) — for "clubs near me" (#1).
function distMiles(a,b){
  const R=3958.8, rad=d=>d*Math.PI/180;
  const dLat=rad(b.lat-a.lat), dLng=rad(b.lng-a.lng);
  const h=Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
const fmtMiles = m => m<10 ? `${m.toFixed(1)} mi` : `${Math.round(m)} mi`;

// Facility signals derived from real /clubs/{id} fields only (#4) — never fabricated.
const RACQUET_IDS = [13,14,15,19,22];
function facilitiesOf(detail){
  const f=[];
  if(detail.swimmingEmailAddress) f.push({k:"Pool"});
  if(detail.isBlaze) f.push({k:"Blaze",hot:true});
  if(detail.spaBookingsEmailAddress) f.push({k:"Spa"});
  const racq=(detail.sportIdsAvailable||[]).filter(id=>RACQUET_IDS.includes(id)).map(id=>SPORTS[id]).filter(Boolean);
  for(const r of racq) f.push({k:r});
  if(detail.isAdultOnly) f.push({k:"Adults only",hot:true});
  return f;
}

// Human offer text from a promotion (#10). Prefer DL's own customer-facing copy,
// then a saving derived from promotionItems, then a cleaned internal name.
function promoText(pm){
  const en=(pm.textByLanguage||{})["en-gb"]||{};
  let t = (en.shortDescription||en.rateCardBannerTitle||"").trim();
  if(!t){
    const it=(pm.promotionItems||[])[0];
    if(it){
      const what = it.type==="JOINING_FEE" ? "joining fee" : String(it.type||"").toLowerCase().replace(/_/g," ");
      if(it.savingType==="PERCENTAGE" && it.savingAmount) t = (it.savingAmount>=100?`Free ${what}`:`${(+it.savingAmount).toFixed(0)}% off ${what}`);
      else if(it.savingType==="AMOUNT" && it.savingAmount) t = `Money off ${what}`;
    }
  }
  if(!t){ // strip internal codes: "EXERP - Half Price Joining Fee (PROMO50)"
    t = (pm.name||"").replace(/^[A-Z0-9]+(?:\s+[A-Z0-9/]+)*\s+-\s+/,"").replace(/\s*\([^)]*\)\s*$/,"").trim();
    if(/lead|copy|part\s*\d/i.test(pm.name||"") && !/joining|free|off|month/i.test(t)) t=""; // drop pure internal labels
  }
  return t;
}
const fmtDate = iso => { try{ return new Date(iso).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}); }catch{ return iso; } };

/* ---- state ---- */
let CLUBS=[], CURRENT=null, DATA=null, CURDUR="STANDARD", token=0, LASTIMG=null, MOSTPOP=null, ACCESS={}, CLUBBY={};
let DETAIL=null, USERLOC=null, USERLABEL="", PC=null;   // club profile + "near me" origin (PC persists in the URL)

// Build a URL for the current view, always carrying the postcode (?pc=) so a
// refresh or shared link keeps "clubs near me" — no browser storage needed.
function buildURL(params){
  const u=new URLSearchParams();
  for(const [k,v] of Object.entries(params)) if(v!=null && v!=="") u.set(k,v);
  if(PC) u.set("pc", PC);
  const s=u.toString();
  return s ? `?${s}` : location.pathname;
}
function syncURL(){
  let u;
  if(!qs("#league").hidden) u=leagueURL();
  else if(!qs("#facilities").hidden) u=facURL();
  else if(CURRENT) u=buildURL({club:slugify(CURRENT.clubName)});
  else u=buildURL({});
  history.replaceState({},"",u);
}

/* ---- search / dropdown ---- */
const q=qs("#q"), dd=qs("#results-list");
let active=-1, shown=[];
function renderDropdown(list,term){
  shown=list;
  if(!list.length){ dd.innerHTML=`<li class="none" role="option">No club matches “${term}”</li>`; dd.hidden=false; q.setAttribute("aria-expanded","true"); return; }
  const rx = term? new RegExp("("+term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")","ig") : null;
  dd.innerHTML = list.slice(0,60).map((c,idx)=>{
    const name = rx? c.clubName.replace(rx,"<mark>$1</mark>") : c.clubName;
    // When a "near me" origin is set, the distance is the useful right-hand fact.
    const right = USERLOC && c._mi!=null ? `<span class="cl mi">${fmtMiles(c._mi)}</span>` : `<span class="cl">${esc(c.country||"")}</span>`;
    return `<li role="option" data-idx="${idx}" aria-selected="${idx===active}">
      <span class="cn">${name}</span>${right}<span class="cc">${esc(c.currency||"")}</span></li>`;
  }).join("");
  dd.hidden=false; q.setAttribute("aria-expanded","true");
}
function closeDropdown(){ dd.hidden=true; q.setAttribute("aria-expanded","false"); active=-1; }
function filterClubs(term){
  const t=term.trim().toLowerCase();
  let base;
  if(!t){
    // No query: nearest-first when a location is set, else alphabetical.
    base = USERLOC ? CLUBS.filter(c=>c._mi!=null).slice().sort((a,b)=>a._mi-b._mi) : CLUBS;
    return base.slice(0,60);
  }
  const starts=[], has=[];
  for(const c of CLUBS){ const n=c.clubName.toLowerCase(); if(n.startsWith(t)) starts.push(c); else if(n.includes(t)||(c.country||"").toLowerCase().includes(t)) has.push(c); }
  const out = starts.concat(has);
  if(USERLOC) out.sort((a,b)=>(a._mi??1e9)-(b._mi??1e9));  // among matches, nearest first
  return out;
}
q.addEventListener("input",()=>{ active=-1; renderDropdown(filterClubs(q.value),q.value.trim()); });
q.addEventListener("focus",()=>{ if(CLUBS.length) renderDropdown(filterClubs(q.value),q.value.trim()); });
q.addEventListener("keydown",e=>{
  if(dd.hidden) return;
  if(e.key==="ArrowDown"){ e.preventDefault(); active=Math.min(active+1,Math.min(shown.length,60)-1); }
  else if(e.key==="ArrowUp"){ e.preventDefault(); active=Math.max(active-1,0); }
  else if(e.key==="Enter"){ e.preventDefault(); if(shown[active>=0?active:0]) selectClub(shown[active>=0?active:0]); return; }
  else if(e.key==="Escape"){ closeDropdown(); q.blur(); return; }
  else return;
  [...dd.children].forEach((li,i)=>li.setAttribute("aria-selected", i===active));
  const el=dd.children[active]; el&&el.scrollIntoView({block:"nearest"});
});
dd.addEventListener("mousedown",e=>{ const li=e.target.closest("li[data-idx]"); if(li) selectClub(shown[+li.dataset.idx]); });
document.addEventListener("click",e=>{ if(!e.target.closest(".combo")) closeDropdown(); });

/* ---- clubs near me (#1) ---- */
async function applyDistances(){
  const locs = await getLocations();
  for(const c of CLUBS){ const l=USERLOC?locs[c.siteId]:null; c._mi = l? distMiles(USERLOC,l) : null; }
}
async function afterLocation(boot){
  await applyDistances();
  const nm=qs("#nm-status");
  const nearest=CLUBS.filter(c=>c._mi!=null).sort((a,b)=>a._mi-b._mi)[0];
  if(nm){ nm.innerHTML = `<span class="ok">◆</span> ${esc(USERLABEL)} — nearest is <b>${esc(nearest?nearest.clubName:"—")}</b>${nearest?` · ${fmtMiles(nearest._mi)}`:""} <button id="nm-clear" class="nm-clear" type="button">clear</button>`;
    qs("#nm-clear")?.addEventListener("click", clearNearMe); }
  if(!qs("#league").hidden) renderLeague();
  if(!qs("#facilities").hidden) renderFacilities();
  if(!boot){ renderDropdown(filterClubs(q.value), q.value.trim()); q.focus(); }
}
async function setNearMeByPostcode(pc, boot){
  pc=(pc||"").trim(); if(!pc) return;
  const nm=qs("#nm-status"); if(nm) nm.textContent="Locating…";
  try{
    const r=await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    if(!r.ok) throw 0; const j=await r.json(); const res=j.result||{};
    USERLOC={lat:res.latitude,lng:res.longitude}; USERLABEL=res.postcode||pc.toUpperCase();
    PC=USERLABEL;                       // persisted in the URL so refresh remembers it
    if(!boot) syncURL();
    await afterLocation(boot);
  }catch{ if(nm) nm.textContent="Postcode not found — try a full UK postcode."; }
}
function setNearMeByGeo(){
  const nm=qs("#nm-status");
  if(!navigator.geolocation){ if(nm) nm.textContent="Location not available on this device."; return; }
  if(nm) nm.textContent="Locating…";
  navigator.geolocation.getCurrentPosition(async pos=>{
    USERLOC={lat:pos.coords.latitude,lng:pos.coords.longitude}; USERLABEL="Your location";
    PC=null; syncURL();               // one-off; not persisted (would need coords in URL)
    await afterLocation();
  }, ()=>{ if(nm) nm.textContent="Location permission denied — enter a postcode instead."; }, {timeout:8000});
}
function clearNearMe(){
  USERLOC=null; USERLABEL=""; PC=null; for(const c of CLUBS) c._mi=null;
  const nm=qs("#nm-status"); if(nm) nm.textContent="";
  const pcIn=qs("#nm-pc"); if(pcIn) pcIn.value="";
  syncURL();
  renderDropdown(filterClubs(q.value),q.value.trim());
  if(!qs("#league").hidden) renderLeague();
}

/* ---- select a club ---- */
async function selectClub(club, fromUrl){
  CURRENT=club; const my=++token;
  q.value=club.clubName; closeDropdown(); q.blur();
  // Give each club its own URL + title so Cloudflare's SPA tracking logs it as a
  // distinct page view — the dashboard's "Top pages" then shows which clubs get
  // looked up. Cookieless: it's just a path, no identifiers.
  const url=buildURL({club:slugify(club.clubName)});
  if(fromUrl) history.replaceState({}, "", url); else history.pushState({}, "", url);
  document.title=`${club.clubName} — The Price Book`;
  const panel=qs("#panel"); panel.hidden=false;
  DETAIL=null;
  qs("#clubname").textContent=club.clubName;
  const distChip = (USERLOC && club._mi!=null) ? ` <span class="sep">/</span> <span class="mi">${fmtMiles(club._mi)} away</span>` : "";
  qs("#clubsub").innerHTML=`<span class="pin">◆</span> ${esc(club.country||"—")} <span class="sep">/</span> Site #${club.siteId} <span class="sep">/</span> prices in ${esc(club.currency)}${distChip}`;
  qs("#pricetable").hidden=true; qs("#empty").hidden=true; qs("#foot-note").hidden=true; qs("#addons").hidden=true; qs("#share").hidden=true;
  const profEl=qs("#profile"); if(profEl) profEl.hidden=true;
  const promoEl=qs("#promos"); if(promoEl) promoEl.hidden=true;
  qs("#durations").innerHTML="";
  const status=qs("#status"); status.hidden=false;
  status.innerHTML=`<span class="spin"></span><span>Pulling live prices…</span>`;
  panel.scrollIntoView({behavior:"smooth",block:"start"});
  try{
    const data = await getPackages(club.siteId);
    if(my!==token) return;
    DATA = data;
    const keys = (data.packages||[]).map(p=>p.packageKey);
    const [settings, access] = await Promise.all([
      getSettings(club.siteId).catch(()=>({})),
      getAccess(club.siteId, keys).catch(()=>({})),
    ]);
    if(my!==token) return;
    MOSTPOP = (settings.packageSettings||{}).standardMostPopularPackage || null;
    ACCESS = access || {};
    const durs = DUR_ORDER.filter(d => (data.packages||[]).some(p=>p.prices&&p.prices[d]));
    if(!durs.includes(CURDUR)) CURDUR = durs[0] || "STANDARD";
    buildDurations(durs);
    renderTable();
    // Profile card (#3/#4) + price trend (#12) load after the prices, non-blocking.
    Promise.all([getSports(), getDetail(club.siteId).catch(()=>null), getHistory().catch(()=>null)])
      .then(([, detail])=>{ if(my!==token) return; DETAIL=detail; renderProfile(); });
  }catch(e){
    if(my!==token) return;
    status.hidden=true; qs("#pricetable").hidden=true;
    const empty=qs("#empty"); empty.hidden=false; empty.textContent="Couldn't load prices for this club — try again shortly.";
  }
}
function buildDurations(durs){
  const wrap=qs("#durations");
  wrap.innerHTML=durs.map(d=>`<button role="tab" data-dur="${d}" aria-selected="${d===CURDUR}">${DUR_LABEL[d]||d}</button>`).join("");
  wrap.querySelectorAll("button").forEach(b=>b.onclick=()=>{
    if(b.dataset.dur===CURDUR) return; CURDUR=b.dataset.dur;
    wrap.querySelectorAll("button").forEach(x=>x.setAttribute("aria-selected",x.dataset.dur===CURDUR));
    renderTable();
  });
}

/* ---- render ---- */
function renderTable(){
  const cur=CURRENT.currency, dur=CURDUR, unit = dur==="ANNUAL" ? "/yr" : "/mo";
  const status=qs("#status"), table=qs("#pricetable"), thead=qs("#thead-row"), tbody=qs("#tbody"),
        empty=qs("#empty"), foot=qs("#foot-note"), addons=qs("#addons");
  status.hidden=true;

  const priceAt = (p,t) => { const d=p.prices&&p.prices[dur]; const v=d&&d[TYPE_FIELD[t]]; return (v==null)?null:v; };
  const pkgs = (DATA.packages||[]).filter(p => TYPES.some(t=>priceAt(p,t)!=null));
  if(!pkgs.length){ table.hidden=true; empty.hidden=false; empty.textContent="Nothing on offer for this club at this duration."; foot.hidden=true; addons.hidden=true; qs("#share").hidden=true; LASTIMG=null; return; }

  // Only show membership-type columns that actually have prices for this club
  // (Family is usually empty — DL builds families from adults + child add-ons,
  // except at clubs with a dedicated FAMILY_* package).
  const activeTypes = TYPES.filter(t => pkgs.some(p=>priceAt(p,t)!=null));
  const minAmt = p => Math.min(...activeTypes.map(t=>priceAt(p,t) ?? Infinity));
  pkgs.sort((a,b)=> (planRank(a.packageKey)-planRank(b.packageKey)) || (minAmt(a)-minAmt(b)) || a.packageKey.localeCompare(b.packageKey));

  thead.innerHTML=`<th>Plan</th>`+activeTypes.map(t=>`<th>${TYPE_LABEL[t]}${t==="INDIVIDUAL"?"":`<span class="th-sub">per person</span>`}</th>`).join("");
  tbody.innerHTML=pkgs.map(p=>{
    const jf = p.prices[dur].joiningFee||0;
    const bens = benefitsOf(p);
    const benHtml = bens.length ? `<div class="benefits">${bens.map(b=>`<span class="ben">${b}</span>`).join("")}</div>` : "";
    const acc = ACCESS[p.packageKey]||[];
    let accHtml="";
    if(acc.length>1){
      const names=acc.map(id=>CLUBBY[id]).filter(Boolean).sort((a,b)=>a.localeCompare(b));
      accHtml=`<details class="access"><summary>Clubs you can access · ${names.length}</summary>`+
              `<div class="access-list">${names.join(" · ")}</div></details>`;
    }
    const pop = p.packageKey===MOSTPOP ? `<span class="pop">Most popular</span>` : "";
    // Offers are attached per package by DL — show them on the plans they apply to (#10).
    const offers=[...new Set((p.prices[dur].promotions||[]).filter(pm=>!pm.inHiddenMenuInClub).map(promoText).filter(Boolean))];
    const offerHtml = offers.length ? `<div class="offers">${offers.map(t=>`<span class="offer">★ ${esc(t)}</span>`).join("")}</div>` : "";
    const tr = trendFor(p.packageKey);
    const trendHtml = tr ? `<div class="trend ${tr.up?"up":"down"}" title="Individual ${DUR_LABEL[dur]} price change">${tr.up?"▲":"▼"} ${fmt(Math.abs(tr.delta),cur)} since ${esc(fmtDate(tr.since))}</div>` : "";
    const cells=activeTypes.map(t=>{
      const v=priceAt(p,t);
      if(v==null) return `<td class="cell na">—</td>`;
      return `<td class="cell"><div class="mo">${fmt(v,cur)}<span class="per">${unit}</span></div>`+
             `<div class="join">${jf?`+ ${fmt(jf,cur)} joining`:`no joining fee`}</div></td>`;
    }).join("");
    return `<tr><td class="plan"><div class="pn">${prettyPlan(p.packageKey)}${pop}</div>`+
           `<div class="pk">${p.packageKey}</div>${offerHtml}${trendHtml}${benHtml}${accHtml}</td>${cells}</tr>`;
  }).join("");
  table.hidden=false; empty.hidden=true;
  renderPromos(dur);

  // add-ons (optional extras) for the current duration
  const ao=(DATA.addOns||[]).map(a=>{ const d=a.prices&&a.prices[dur]; if(!d||d.price==null) return null;
    return `${prettyPlan(a.addOnKey)} ${fmt(d.price,cur)}${unit}`; }).filter(Boolean);
  addons.hidden = !ao.length;
  if(ao.length) addons.innerHTML = `<span class="ao-k">Add-ons</span> ${ao.join(" · ")}`;

  const ppTypes = activeTypes.filter(t=>t!=="INDIVIDUAL").map(t=>TYPE_LABEL[t]);
  const ppNote = ppTypes.length ? ` ${ppTypes.join(" & ")} rates are per person.` : "";
  foot.hidden=false;
  const snap = (LATEST&&LATEST.date) ? ` · from David Lloyd, snapshot ${fmtDate(LATEST.date)}` : "";
  foot.textContent=`Standard rates before any promotion · ${pkgs.length} plan${pkgs.length>1?"s":""}${snap}. ${dur==="ANNUAL"?"Prices are the annual total.":"Monthly fees recur; joining fees are one-off."}${ppNote}`;

  // capture a model for the shareable image, and reveal the button
  LASTIMG = {
    club: CURRENT.clubName,
    meta: `${CURRENT.country||""} · Site #${CURRENT.siteId} · ${cur} · ${DUR_LABEL[dur]||dur}`,
    cols: activeTypes.map(t=>({ label:TYPE_LABEL[t], pp:t!=="INDIVIDUAL" })),
    rows: pkgs.map(p=>{ const jf=p.prices[dur].joiningFee||0;
      return { name:prettyPlan(p.packageKey), key:p.packageKey, pop:p.packageKey===MOSTPOP,
        cells: activeTypes.map(t=>{ const v=priceAt(p,t); if(v==null) return null;
          return { price:fmt(v,cur), unit, join: jf?`+ ${fmt(jf,cur)} joining`:"no joining fee" }; }) }; }),
    url: `dylnyko.github.io/davidlloyd-price-index/?club=${slugify(CURRENT.clubName)}`,
    date: new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}),
    annual: dur==="ANNUAL",
  };
  qs("#share").hidden=false;
}

/* ---- price trend (#12) — from committed history.json ---- */
function trendFor(key){
  if(!HISTORY||!CURRENT||CURDUR==="FLEXIBLE") return null;   // history tracks Standard + Annual
  const field = CURDUR==="ANNUAL"?"iA":"iS";
  const arr = (((HISTORY.series||{})[String(CURRENT.siteId)]||{})[key]||{})[field];
  if(!arr||arr.length<2) return null;
  const cur=arr[arr.length-1][1], prev=arr[arr.length-2];
  if(cur===prev[1]) return null;
  return { delta: cur-prev[1], since: prev[0], up: cur>prev[1] };
}

/* ---- live promotions (#10) ---- */
// Offers differ per plan (DL attaches each promotion only to the packages it
// covers), so they render inline per row; this is just the legend, shown when
// at least one plan at this duration has a visible offer.
function renderPromos(dur){
  const el=qs("#promos"); if(!el) return;
  let earliestEnd=null;
  const any=(DATA.packages||[]).some(p=>{ const d=p.prices&&p.prices[dur]; if(!d) return false;
    return (d.promotions||[]).some(pm=>{ if(pm.inHiddenMenuInClub||!promoText(pm)) return false;
      if(pm.endDate && (!earliestEnd||pm.endDate<earliestEnd)) earliestEnd=pm.endDate; return true; }); });
  if(!any){ el.hidden=true; el.innerHTML=""; return; }
  el.hidden=false;
  el.innerHTML=`<span class="promo-k">Offers</span>`+
    `<span class="promo-note">★ current offers are shown on the plans they apply to`+
    `${earliestEnd?` · ends ${esc(fmtDate(earliestEnd))}`:""}</span>`;
}

/* ---- club profile card + facility badges (#3/#4) ---- */
function openHoursHtml(detail){
  const w=(detail.clubOpeningTimes||{}).weeklyOpeningTimes; if(!w) return "";
  const days=[["mon","Mon"],["tue","Tue"],["wed","Wed"],["thu","Thu"],["fri","Fri"],["sat","Sat"],["sun","Sun"]];
  const rng=list=>(list&&list.length)?list.map(s=>`${s.from}–${s.to}`).join(", "):"Closed";
  return `<div class="hours">`+days.map(([k,lbl])=>`<div class="hrow"><span class="hd">${lbl}</span><span class="ht">${esc(rng(w[k]))}</span></div>`).join("")+`</div>`;
}
function renderProfile(){
  const el=qs("#profile"); if(!el) return;
  const d=DETAIL; if(!d){ el.hidden=true; el.innerHTML=""; return; }
  const badges=facilitiesOf(d);
  const badgeHtml = badges.length ? `<div class="badges">`+badges.map(b=>`<span class="badge${b.hot?" hot":""}">${esc(b.k)}</span>`).join("")+`</div>` : "";
  // Count courts only for sports David Lloyd actually names (/sports) — skip
  // internal court types with no public name rather than label them "Court".
  const courtsBySport={};
  for(const c of (d.courts||[])){ const n=SPORTS[c.sportId]; if(n) courtsBySport[n]=(courtsBySport[n]||0)+1; }
  const courtsHtml = Object.keys(courtsBySport).length
    ? `<div class="pf-item"><span class="pf-k">Racquet courts</span><span class="pf-v">${Object.entries(courtsBySport).sort((a,b)=>b[1]-a[1]).map(([n,ct])=>`${ct} ${esc(n)}`).join(" · ")}</span></div>` : "";
  const telHtml = d.telephone ? `<div class="pf-item"><span class="pf-k">Phone</span><span class="pf-v"><a href="tel:${esc((d.telephone||"").replace(/\s+/g,""))}">${esc(d.telephone)}</a></span></div>` : "";
  const hours=openHoursHtml(d);
  const hoursHtml = hours ? `<div class="pf-item pf-hours"><span class="pf-k">Opening hours</span>${hours}</div>` : "";
  el.hidden=false;
  el.innerHTML=`<div class="pf-head"><h3>Club facilities</h3>${badgeHtml}</div>`+
    `<div class="pf-grid">${telHtml}${courtsHtml}${hoursHtml}</div>`;
}

/* ---- national price league (#6) — from committed latest.json ---- */
let LEAGUE_METRIC={ plan:"CLUB_PLATINUM", type:"i", dur:"S" };
const DUR_SHORT={ S:"Standard · 12-mo", F:"Flexible · 3-mo", A:"Annual total" };
// Family deliberately excluded (as on the club tables): DL prices it as a
// whole-family total with undefined composition, so a per-person ranking is
// meaningless (e.g. Family Platinum reads ~£4k vs Individual ~£174).
const TYPE_SHORT={ i:"Individual", c:"Couple" };
const leagueURL = () => buildURL({ view:"league", plan:LEAGUE_METRIC.plan, who:LEAGUE_METRIC.type, term:LEAGUE_METRIC.dur });
async function openLeague(fromUrl){
  setView("league");
  const box=qs("#league"); box.hidden=false;
  qs("#league-status").hidden=false; qs("#league-table").hidden=true;
  // Shareable/bookmarkable URL for the league view (and its chosen metric).
  if(fromUrl) history.replaceState({},"",leagueURL()); else history.pushState({},"",leagueURL());
  document.title="National price league — The Price Book";
  await Promise.all([getLatest(), USERLOC?applyDistances():null]);
  buildLeagueControls();
  renderLeague();
}
function planUniverse(){
  const set=new Set();
  for(const c of (LATEST.clubs||[])) for(const k of Object.keys(c.plans||{})) set.add(k);
  return [...set].sort((a,b)=> (planRank(a)-planRank(b)) || a.localeCompare(b));
}
function buildLeagueControls(){
  const wrap=qs("#league-controls"); if(!wrap) return;
  const plans=planUniverse();
  if(!plans.includes(LEAGUE_METRIC.plan)) LEAGUE_METRIC.plan = plans.includes("CLUB_PLATINUM")?"CLUB_PLATINUM":plans[0];
  if(!TYPE_SHORT[LEAGUE_METRIC.type]) LEAGUE_METRIC.type="i";   // guard stale ?who=f links
  const opt=(v,l,sel)=>`<option value="${v}"${v===sel?" selected":""}>${esc(l)}</option>`;
  wrap.innerHTML=
    `<label>Plan <select id="lg-plan">${plans.map(p=>opt(p,prettyPlan(p),LEAGUE_METRIC.plan)).join("")}</select></label>`+
    `<label>Who <select id="lg-type">${Object.entries(TYPE_SHORT).map(([v,l])=>opt(v,l,LEAGUE_METRIC.type)).join("")}</select></label>`+
    `<label>Term <select id="lg-dur">${Object.entries(DUR_SHORT).map(([v,l])=>opt(v,l,LEAGUE_METRIC.dur)).join("")}</select></label>`;
  const upd=()=>{ renderLeague(); history.replaceState({},"",leagueURL()); };
  qs("#lg-plan").onchange=e=>{ LEAGUE_METRIC.plan=e.target.value; upd(); };
  qs("#lg-type").onchange=e=>{ LEAGUE_METRIC.type=e.target.value; upd(); };
  qs("#lg-dur").onchange=e=>{ LEAGUE_METRIC.dur=e.target.value; upd(); };
}
function renderLeague(){
  const box=qs("#league"); if(!box || box.hidden) return;
  const {plan,type,dur}=LEAGUE_METRIC;
  const rows=[];
  for(const c of (LATEST.clubs||[])){
    const cell=(c.plans[plan]||{})[dur];
    const v=cell?cell[type]:null;
    if(v==null) continue;
    rows.push({ name:c.name, country:c.country, siteId:c.siteId, cur:c.currency, val:v,
      mi: USERLOC ? (CLUBS.find(x=>x.siteId===c.siteId)?._mi ?? null) : null });
  }
  rows.sort((a,b)=>a.val-b.val);
  qs("#league-status").hidden=true;
  const t=qs("#league-table"); t.hidden=false;
  const unit = dur==="A" ? "/yr" : "/mo";
  const showMi = USERLOC && rows.some(r=>r.mi!=null);
  const cheapest = rows.length?rows[0].val:0, dearest=rows.length?rows[rows.length-1].val:0;
  const pp = type!=="i";   // couple/family rates are per person (as in the club tables)
  qs("#league-sub").textContent =
    `${rows.length} clubs with ${prettyPlan(plan)} · ${TYPE_SHORT[type]}${pp?" (per person)":""} · ${DUR_SHORT[dur]} — from ${fmt(cheapest,rows[0]?.cur||"GBP")} to ${fmt(dearest,rows[rows.length-1]?.cur||"GBP")}${unit}`;
  t.innerHTML=
    `<thead><tr><th>#</th><th>Club</th><th>Country</th>${showMi?`<th class="num">Distance</th>`:""}<th class="num">${TYPE_SHORT[type]} ${unit}${pp?`<span class="th-sub">per person</span>`:""}</th></tr></thead>`+
    `<tbody>`+rows.map((r,i)=>`<tr data-site="${r.siteId}">`+
      `<td class="lg-rank">${i+1}</td>`+
      `<td class="lg-name">${esc(r.name)}</td>`+
      `<td class="lg-country">${esc(r.country||"")}</td>`+
      `${showMi?`<td class="num">${r.mi!=null?fmtMiles(r.mi):"—"}</td>`:""}`+
      `<td class="num lg-price">${fmt(r.val,r.cur)}<span class="per">${unit}</span></td></tr>`).join("")+
    `</tbody>`;
  t.querySelectorAll("tbody tr").forEach(tr=>tr.onclick=()=>{
    const club=CLUBS.find(c=>c.siteId===+tr.dataset.site); if(club){ setView("lookup"); selectClub(club); }
  });
}

/* ---- facilities league (#facilities) — from committed facilities.json ---- */
let FACS=null, FAC_METRIC="total";
async function getFacilities(){
  if(FACS) return FACS;
  try{ const r=await fetch(`data/facilities.json?t=${Math.floor(Date.now()/36e5)}`); FACS=await r.json(); }
  catch{ FACS={clubs:[]}; }
  return FACS;
}
const facURL = () => buildURL({ view:"facilities", metric:FAC_METRIC });
async function openFacilities(fromUrl){
  setView("facilities");
  qs("#fac-status").hidden=false; qs("#fac-table").hidden=true;
  if(fromUrl) history.replaceState({},"",facURL()); else history.pushState({},"",facURL());
  document.title="Facilities league — The Price Book";
  await Promise.all([getFacilities(), USERLOC?applyDistances():null]);
  buildFacControls();
  renderFacilities();
}
function facMetrics(){
  const s=new Set();
  for(const c of (FACS.clubs||[])) for(const k of Object.keys(c.courts||{})) s.add(k);
  return ["total", ...[...s].sort()];
}
function buildFacControls(){
  const wrap=qs("#fac-controls"); if(!wrap) return;
  const opts=facMetrics(); if(!opts.includes(FAC_METRIC)) FAC_METRIC="total";
  const label=m=>m==="total"?"Total racquet courts":`${m} courts`;
  wrap.innerHTML=`<label>Rank by <select id="fac-metric">${opts.map(m=>`<option value="${m}"${m===FAC_METRIC?" selected":""}>${esc(label(m))}</option>`).join("")}</select></label>`;
  qs("#fac-metric").onchange=e=>{ FAC_METRIC=e.target.value; renderFacilities(); history.replaceState({},"",facURL()); };
}
function renderFacilities(){
  const box=qs("#facilities"); if(!box || box.hidden) return;
  const val = c => FAC_METRIC==="total" ? (c.totalCourts||0) : ((c.courts||{})[FAC_METRIC]||0);
  const rows=(FACS.clubs||[]).map(c=>({ ...c, v:val(c),
      mi: USERLOC ? (CLUBS.find(x=>x.siteId===c.siteId)?._mi ?? null) : null }))
    .filter(r=>r.v>0).sort((a,b)=> (b.v-a.v) || a.name.localeCompare(b.name));
  qs("#fac-status").hidden=true; const t=qs("#fac-table"); t.hidden=false;
  const showMi = USERLOC && rows.some(r=>r.mi!=null);
  const label = FAC_METRIC==="total"?"Racquet courts":`${FAC_METRIC} courts`;
  qs("#fac-sub").textContent = `${rows.length} clubs ranked by ${label.toLowerCase()}. Information comes from David Lloyd’s API and may not be 100% accurate.`;
  const chips=c=>Object.entries(c.courts||{}).sort((a,b)=>b[1]-a[1]).map(([n,ct])=>`${ct} ${esc(n)}`).join(" · ");
  t.innerHTML=
    `<thead><tr><th>#</th><th>Club</th><th>Country</th>${showMi?`<th class="num">Distance</th>`:""}<th>Courts</th><th class="num">${esc(label)}</th></tr></thead>`+
    `<tbody>`+rows.map((r,i)=>`<tr data-site="${r.siteId}">`+
      `<td class="lg-rank">${i+1}</td><td class="lg-name">${esc(r.name)}</td><td class="lg-country">${esc(r.country||"")}</td>`+
      `${showMi?`<td class="num">${r.mi!=null?fmtMiles(r.mi):"—"}</td>`:""}`+
      `<td class="fac-courts">${chips(r)||"—"}</td>`+
      `<td class="num lg-price">${r.v}</td></tr>`).join("")+
    `</tbody>`;
  t.querySelectorAll("tbody tr").forEach(tr=>tr.onclick=()=>{
    const club=CLUBS.find(c=>c.siteId===+tr.dataset.site); if(club){ setView("lookup"); selectClub(club); }
  });
}

/* ---- view switching (lookup / league / facilities) ---- */
function setView(v){
  const isLeague=v==="league", isFac=v==="facilities", isLookup=v==="lookup";
  qs("#league").hidden = !isLeague;
  qs("#facilities").hidden = !isFac;
  qs(".hero").hidden = !isLookup;
  qs(".search").hidden = !isLookup;
  qs("#panel").hidden = isLookup ? !CURRENT : true;
  document.querySelectorAll(".nav button").forEach(b=>b.setAttribute("aria-selected", b.dataset.view===v));
  if(isLeague) qs("#league").scrollIntoView({behavior:"smooth",block:"start"});
  if(isFac) qs("#facilities").scrollIntoView({behavior:"smooth",block:"start"});
}

/* ---- shareable image (custom-drawn canvas in the site's style) ---- */
function drawShare(m){
  const INK="#0b0b0a", PAPER="#efece3", ACCENT="#ff3d00", MUTED="#6b675d", LINE="rgba(11,11,10,0.14)";
  const DISP='"Bricolage Grotesque", sans-serif', MONO='"Space Mono", monospace';
  const S=2, W=960, P=48, ncol=m.cols.length;
  const planW=Math.round((W-2*P)*0.40), priceW=Math.round((W-2*P-planW)/ncol);
  const colR = i => P+planW+priceW*(i+1)-8;
  const RH=66;
  const yWord=P+16, yClub=yWord+52, yMeta=yClub+26, yDiv=yMeta+22, yHead=yDiv+34, yRule=yHead+26, yRows=yRule+12;
  const yFoot = yRows+m.rows.length*RH+26, H = yFoot+44+P-24;
  const cv=document.createElement("canvas"); cv.width=W*S; cv.height=H*S;
  const ctx=cv.getContext("2d"); ctx.scale(S,S); ctx.textBaseline="alphabetic";
  ctx.fillStyle=PAPER; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.strokeRect(1,1,W-2,H-2);
  // wordmark + date
  ctx.textAlign="left"; ctx.fillStyle=INK; ctx.font=`700 14px ${MONO}`; ctx.fillText("THE PRICE BOOK", P, yWord);
  ctx.textAlign="right"; ctx.fillStyle=MUTED; ctx.font=`400 13px ${MONO}`; ctx.fillText(m.date, W-P, yWord);
  // club + meta
  ctx.textAlign="left"; ctx.fillStyle=INK; ctx.font=`700 40px ${DISP}`; ctx.fillText(m.club, P, yClub);
  ctx.fillStyle=MUTED; ctx.font=`400 13px ${MONO}`; ctx.fillText(m.meta.toUpperCase(), P, yMeta);
  ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(P,yDiv); ctx.lineTo(W-P,yDiv); ctx.stroke();
  // header
  ctx.textAlign="left"; ctx.fillStyle=ACCENT; ctx.font=`700 12px ${MONO}`; ctx.fillText("PLAN", P, yHead);
  ctx.textAlign="right";
  m.cols.forEach((c,i)=>{
    ctx.fillStyle=ACCENT; ctx.font=`700 12px ${MONO}`; ctx.fillText(c.label.toUpperCase(), colR(i), yHead);
    if(c.pp){ ctx.fillStyle=MUTED; ctx.font=`400 9px ${MONO}`; ctx.fillText("PER PERSON", colR(i), yHead+13); }
  });
  ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(P,yRule); ctx.lineTo(W-P,yRule); ctx.stroke();
  // rows
  m.rows.forEach((r,ri)=>{
    const top=yRows+ri*RH;
    ctx.textAlign="left"; ctx.fillStyle=INK; ctx.font=`700 19px ${DISP}`; ctx.fillText(r.name, P, top+26);
    if(r.pop){ const w=ctx.measureText(r.name).width; ctx.font=`700 9px ${MONO}`; ctx.fillStyle=ACCENT; ctx.fillText("★ MOST POPULAR", P+w+10, top+24); }
    ctx.fillStyle=MUTED; ctx.font=`400 11px ${MONO}`; ctx.fillText(r.key, P, top+45);
    r.cells.forEach((cell,i)=>{ const rx=colR(i);
      if(!cell){ ctx.textAlign="right"; ctx.fillStyle=MUTED; ctx.font=`400 18px ${MONO}`; ctx.fillText("—", rx, top+27); return; }
      ctx.textAlign="right";
      ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED; ctx.fillText(cell.unit, rx, top+26);
      const uw=ctx.measureText(cell.unit).width+3;
      ctx.font=`700 19px ${MONO}`; ctx.fillStyle=cell.lowest?ACCENT:INK; ctx.fillText(cell.price, rx-uw, top+27);
      ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED; ctx.fillText(cell.join, rx, top+45);
    });
    ctx.strokeStyle=LINE; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(P,top+RH); ctx.lineTo(W-P,top+RH); ctx.stroke();
  });
  // footer: shareable link (accent) + note
  ctx.textAlign="left"; ctx.font=`700 13px ${MONO}`; ctx.fillStyle=ACCENT; ctx.fillText(m.url, P, yFoot+16);
  const ppCols=m.cols.filter(c=>c.pp).map(c=>c.label.toLowerCase());
  const ppTxt=ppCols.length?` · ${ppCols.join("/")} per person`:"";
  ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED;
  ctx.fillText(`Standard rates · pre-promotion${m.annual?" · annual total":""}${ppTxt} · unofficial, not affiliated with David Lloyd`, P, yFoot+36);
  return cv;
}
let CURCANVAS=null;
function openShare(){
  if(!LASTIMG) return;
  CURCANVAS=drawShare(LASTIMG);
  qs("#share-preview").src=CURCANVAS.toDataURL("image/png");
  qs("#share-link").textContent="https://"+LASTIMG.url;
  qs("#sharemodal").hidden=false; document.body.style.overflow="hidden";
}
function closeShare(){ qs("#sharemodal").hidden=true; document.body.style.overflow=""; }
function copyImg(){
  if(!CURCANVAS) return;
  try{
    const item=new ClipboardItem({ "image/png": new Promise(res=>CURCANVAS.toBlob(b=>res(b),"image/png")) });
    navigator.clipboard.write([item]).then(()=>toast("Image copied to clipboard ✓")).catch(()=>downloadCanvas(CURCANVAS));
  }catch(e){ downloadCanvas(CURCANVAS); }
}
function copyLink(){
  const u="https://"+LASTIMG.url;
  (navigator.clipboard?.writeText(u) ?? Promise.reject()).then(()=>toast("Link copied ✓")).catch(()=>toast("Couldn't copy link"));
}
function downloadCanvas(cv){
  cv.toBlob(b=>{ const a=document.createElement("a"); a.href=URL.createObjectURL(b);
    a.download=`price-book-${slugify(LASTIMG.club)}.png`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000); toast("Image downloaded"); },"image/png");
}
let _toastT; function toast(msg){ const t=qs("#toast"); if(!t) return; t.textContent=msg; t.hidden=false; clearTimeout(_toastT); _toastT=setTimeout(()=>{t.hidden=true;},2400); }
qs("#share").addEventListener("click", openShare);
qs("#sharemodal").addEventListener("click", e=>{ if(e.target.closest("[data-close]")) closeShare(); });
qs("#do-copy").addEventListener("click", copyImg);
qs("#do-download").addEventListener("click", ()=>{ if(CURCANVAS) downloadCanvas(CURCANVAS); });
qs("#do-link").addEventListener("click", copyLink);
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && !qs("#sharemodal").hidden) closeShare(); });

/* ---- nav + near-me wiring ---- */
function gotoLookup(){
  setView("lookup");
  const u = CURRENT ? buildURL({club:slugify(CURRENT.clubName)}) : buildURL({});
  history.pushState({},"",u);
  document.title = CURRENT ? `${CURRENT.clubName} — The Price Book` : "The Price Book — unofficial David Lloyd price lookup";
}
document.querySelectorAll(".nav button").forEach(b=>b.addEventListener("click",()=>{
  const v=b.dataset.view;
  if(v==="league") openLeague(); else if(v==="facilities") openFacilities(); else gotoLookup();
}));
qs("#nm-geo")?.addEventListener("click", setNearMeByGeo);
qs("#nm-form")?.addEventListener("submit", e=>{ e.preventDefault(); setNearMeByPostcode(qs("#nm-pc").value); });

// Back/forward between league and club views.
window.addEventListener("popstate",()=>{
  const p=new URLSearchParams(location.search);
  if(p.get("view")==="league"){
    if(p.get("plan")) LEAGUE_METRIC.plan=p.get("plan");
    if(p.get("who")) LEAGUE_METRIC.type=p.get("who");
    if(p.get("term")) LEAGUE_METRIC.dur=p.get("term");
    openLeague(true); return;
  }
  if(p.get("view")==="facilities"){ if(p.get("metric")) FAC_METRIC=p.get("metric"); openFacilities(true); return; }
  const cs=p.get("club");
  if(cs){ const m=CLUBS.find(c=>slugify(c.clubName)===cs); if(m){ setView("lookup"); selectClub(m,true); return; } }
  setView("lookup");
});

/* ---- boot ---- */
(async function(){
  try{
    CLUBS=await getClubs();
    CLUBBY=Object.fromEntries(CLUBS.map(c=>[c.siteId, c.clubName]));
    qs("#clubcount").textContent=`${CLUBS.length}`;
    const spec=qs("#spec-clubs"); if(spec) spec.textContent=`${CLUBS.length} clubs`;
    // Deep links (shareable URLs): ?view=league[&plan&who&term] or ?club=<slug>,
    // plus ?pc=<postcode> which restores "clubs near me" across refresh/shares.
    const params=new URLSearchParams(location.search);
    const pc=params.get("pc");
    if(pc){ const pcIn=qs("#nm-pc"); if(pcIn) pcIn.value=pc; await setNearMeByPostcode(pc, true); }
    if(params.get("view")==="league"){
      if(params.get("plan")) LEAGUE_METRIC.plan=params.get("plan");
      if(params.get("who")) LEAGUE_METRIC.type=params.get("who");
      if(params.get("term")) LEAGUE_METRIC.dur=params.get("term");
      openLeague(true); return;
    }
    if(params.get("view")==="facilities"){ if(params.get("metric")) FAC_METRIC=params.get("metric"); openFacilities(true); return; }
    const cslug=params.get("club");
    if(cslug){ const m=CLUBS.find(c=>slugify(c.clubName)===cslug); if(m){ selectClub(m,true); return; } }
    if(document.activeElement===q) renderDropdown(filterClubs(q.value),q.value.trim());
  }catch{
    q.placeholder="Couldn't reach the pricing service — try again later";
  }
})();
