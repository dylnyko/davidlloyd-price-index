/* The Price Book — independent, unofficial David Lloyd price lookup.
 * Self-updating & backend-free: the club list and every club's plans, prices
 * and plan benefits come live from David Lloyd's own public endpoints, so new
 * clubs and new plans appear on their own.                                    */
"use strict";

const API = "https://mobile-app-back.davidlloyd.co.uk";
const DAY = 864e5;

const TYPES = ["INDIVIDUAL","COUPLE","FAMILY"];                 // column order
const TYPE_LABEL = { INDIVIDUAL:"Individual", COUPLE:"Couple", FAMILY:"Family" };
const TYPE_FIELD = { INDIVIDUAL:"individual", COUPLE:"couple", FAMILY:"family" };
const DUR_ORDER  = ["STANDARD","FLEXIBLE","ANNUAL"];
const DUR_LABEL  = { STANDARD:"Monthly rolling", FLEXIBLE:"Flexible", ANNUAL:"Paid annually" };

const qs = s => document.querySelector(s);
const cacheGet = k => { try{ const v=JSON.parse(localStorage.getItem(k)); if(v&&Date.now()-v.t<v.ttl) return v.d; }catch{} return null; };
const cacheSet = (k,d,ttl) => { try{ localStorage.setItem(k,JSON.stringify({t:Date.now(),ttl,d})); }catch{} };

/* ---- data ---- */
async function getClubs(){
  const c = cacheGet("pb_clubs"); if(c) return c;
  const r = await fetch(`${API}/clubs`); const j = await r.json();
  const clubs = (j.clubs||[]).filter(c=>c.status==="active").sort((a,b)=>a.clubName.localeCompare(b.clubName));
  cacheSet("pb_clubs", clubs, DAY);
  return clubs;
}
async function getPackages(siteId){
  const ck = `pb_pkg_${siteId}`; const c = cacheGet(ck); if(c) return c;
  const r = await fetch(`${API}/clubs/${siteId}/packages/online`);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  cacheSet(ck, j, DAY/2);
  return j;
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

/* ---- state ---- */
let CLUBS=[], CURRENT=null, DATA=null, CURDUR="STANDARD", token=0, LASTIMG=null;

/* ---- search / dropdown ---- */
const q=qs("#q"), dd=qs("#results-list");
let active=-1, shown=[];
function renderDropdown(list,term){
  shown=list;
  if(!list.length){ dd.innerHTML=`<li class="none" role="option">No club matches “${term}”</li>`; dd.hidden=false; q.setAttribute("aria-expanded","true"); return; }
  const rx = term? new RegExp("("+term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")","ig") : null;
  dd.innerHTML = list.slice(0,60).map((c,idx)=>{
    const name = rx? c.clubName.replace(rx,"<mark>$1</mark>") : c.clubName;
    return `<li role="option" data-idx="${idx}" aria-selected="${idx===active}">
      <span class="cn">${name}</span><span class="cl">${c.country||""}</span><span class="cc">${c.currency||""}</span></li>`;
  }).join("");
  dd.hidden=false; q.setAttribute("aria-expanded","true");
}
function closeDropdown(){ dd.hidden=true; q.setAttribute("aria-expanded","false"); active=-1; }
function filterClubs(term){
  const t=term.trim().toLowerCase();
  if(!t) return CLUBS.slice(0,60);
  const starts=[], has=[];
  for(const c of CLUBS){ const n=c.clubName.toLowerCase(); if(n.startsWith(t)) starts.push(c); else if(n.includes(t)||(c.country||"").toLowerCase().includes(t)) has.push(c); }
  return starts.concat(has);
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

/* ---- select a club ---- */
async function selectClub(club, fromUrl){
  CURRENT=club; const my=++token;
  q.value=club.clubName; closeDropdown(); q.blur();
  // Give each club its own URL + title so Cloudflare's SPA tracking logs it as a
  // distinct page view — the dashboard's "Top pages" then shows which clubs get
  // looked up. Cookieless: it's just a path, no identifiers.
  const url=`?club=${slugify(club.clubName)}`;
  if(fromUrl) history.replaceState({}, "", url); else history.pushState({}, "", url);
  document.title=`${club.clubName} — The Price Book`;
  const panel=qs("#panel"); panel.hidden=false;
  qs("#clubname").textContent=club.clubName;
  qs("#clubsub").innerHTML=`<span class="pin">◆</span> ${club.country||"—"} <span class="sep">/</span> site #${club.siteId} <span class="sep">/</span> prices in ${club.currency}`;
  qs("#pricetable").hidden=true; qs("#empty").hidden=true; qs("#foot-note").hidden=true; qs("#addons").hidden=true; qs("#share").hidden=true;
  qs("#durations").innerHTML="";
  const status=qs("#status"); status.hidden=false;
  status.innerHTML=`<span class="spin"></span><span>Pulling live prices…</span>`;
  panel.scrollIntoView({behavior:"smooth",block:"start"});
  try{
    const data = await getPackages(club.siteId);
    if(my!==token) return;
    DATA = data;
    const durs = DUR_ORDER.filter(d => (data.packages||[]).some(p=>p.prices&&p.prices[d]));
    if(!durs.includes(CURDUR)) CURDUR = durs[0] || "STANDARD";
    buildDurations(durs);
    renderTable();
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

  const minAmt = p => Math.min(...TYPES.map(t=>priceAt(p,t) ?? Infinity));
  pkgs.sort((a,b)=> (planRank(a.packageKey)-planRank(b.packageKey)) || (minAmt(a)-minAmt(b)) || a.packageKey.localeCompare(b.packageKey));
  const cheapest = pkgs.reduce((m,p)=>minAmt(p)<minAmt(m)?p:m,pkgs[0]);

  thead.innerHTML=`<th>Plan</th>`+TYPES.map(t=>`<th>${TYPE_LABEL[t]}</th>`).join("");
  tbody.innerHTML=pkgs.map(p=>{
    const jf = p.prices[dur].joiningFee||0;
    const bens = benefitsOf(p);
    const benHtml = bens.length ? `<div class="benefits">${bens.map(b=>`<span class="ben">${b}</span>`).join("")}</div>` : "";
    const cells=TYPES.map(t=>{
      const v=priceAt(p,t);
      if(v==null) return `<td class="cell na">—</td>`;
      const tag = (p===cheapest && v===minAmt(p)) ? `<div class="best-tag">Lowest</div>`:"";
      return `<td class="cell"><div class="mo">${fmt(v,cur)}<span class="per">${unit}</span></div>`+
             `<div class="join">${jf?`+ ${fmt(jf,cur)} joining`:`no joining fee`}</div>${tag}</td>`;
    }).join("");
    return `<tr class="${p===cheapest?"best":""}"><td class="plan"><div class="pn">${prettyPlan(p.packageKey)}</div>`+
           `<div class="pk">${p.packageKey}</div>${benHtml}</td>${cells}</tr>`;
  }).join("");
  table.hidden=false; empty.hidden=true;

  // add-ons (optional extras) for the current duration
  const ao=(DATA.addOns||[]).map(a=>{ const d=a.prices&&a.prices[dur]; if(!d||d.price==null) return null;
    return `${prettyPlan(a.addOnKey)} ${fmt(d.price,cur)}${unit}`; }).filter(Boolean);
  addons.hidden = !ao.length;
  if(ao.length) addons.innerHTML = `<span class="ao-k">Add-ons</span> ${ao.join(" · ")}`;

  foot.hidden=false;
  foot.textContent=`Standard rates before any promotion · ${pkgs.length} plan${pkgs.length>1?"s":""} · pulled live ${new Date().toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}. ${dur==="ANNUAL"?"Prices are the annual total.":"Monthly fees recur; joining fees are one-off."}`;

  // capture a model for the shareable image, and reveal the button
  LASTIMG = {
    club: CURRENT.clubName,
    meta: `${CURRENT.country||"—"} · Site #${CURRENT.siteId} · ${cur} · ${DUR_LABEL[dur]||dur}`,
    cols: TYPES.map(t=>TYPE_LABEL[t]),
    rows: pkgs.map(p=>{ const jf=p.prices[dur].joiningFee||0;
      return { name:prettyPlan(p.packageKey), key:p.packageKey,
        cells: TYPES.map(t=>{ const v=priceAt(p,t); if(v==null) return null;
          return { price:fmt(v,cur), unit, join: jf?`+ ${fmt(jf,cur)} joining`:"no joining fee", lowest:(p===cheapest && v===minAmt(p)) }; }) }; }),
    url: `dylnyko.github.io/davidlloyd-price-index/?club=${slugify(CURRENT.clubName)}`,
    date: new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}),
    annual: dur==="ANNUAL",
  };
  qs("#share").hidden=false;
}

/* ---- shareable image (custom-drawn canvas in the site's style) ---- */
function drawShare(m){
  const INK="#0b0b0a", PAPER="#efece3", ACCENT="#ff3d00", MUTED="#6b675d", LINE="rgba(11,11,10,0.14)";
  const DISP='"Bricolage Grotesque", sans-serif', MONO='"Space Mono", monospace';
  const S=2, W=960, P=48, ncol=m.cols.length;
  const planW=Math.round((W-2*P)*0.40), priceW=Math.round((W-2*P-planW)/ncol);
  const colR = i => P+planW+priceW*(i+1)-8;
  const RH=66;
  const yWord=P+16, yClub=yWord+52, yMeta=yClub+26, yDiv=yMeta+22, yHead=yDiv+34, yRule=yHead+12, yRows=yRule+12;
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
  ctx.fillStyle=ACCENT; ctx.font=`700 12px ${MONO}`;
  ctx.textAlign="left"; ctx.fillText("PLAN", P, yHead);
  ctx.textAlign="right"; m.cols.forEach((c,i)=>ctx.fillText(c.toUpperCase(), colR(i), yHead));
  ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(P,yRule); ctx.lineTo(W-P,yRule); ctx.stroke();
  // rows
  m.rows.forEach((r,ri)=>{
    const top=yRows+ri*RH;
    ctx.textAlign="left"; ctx.fillStyle=INK; ctx.font=`700 19px ${DISP}`; ctx.fillText(r.name, P, top+26);
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
  ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED;
  ctx.fillText(`Standard rates · pre-promotion${m.annual?" · annual total":""} · unofficial, not affiliated with David Lloyd`, P, yFoot+36);
  return cv;
}
function shareImage(){
  if(!LASTIMG) return;
  const cv=drawShare(LASTIMG);
  try{
    const item=new ClipboardItem({ "image/png": new Promise(res=>cv.toBlob(b=>res(b),"image/png")) });
    navigator.clipboard.write([item]).then(()=>toast("Price image copied ✓")).catch(()=>downloadCanvas(cv));
  }catch(e){ downloadCanvas(cv); }
}
function downloadCanvas(cv){
  cv.toBlob(b=>{ const a=document.createElement("a"); a.href=URL.createObjectURL(b);
    a.download=`price-book-${slugify(LASTIMG.club)}.png`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000); toast("Price image downloaded"); },"image/png");
}
let _toastT; function toast(msg){ const t=qs("#toast"); if(!t) return; t.textContent=msg; t.hidden=false; clearTimeout(_toastT); _toastT=setTimeout(()=>{t.hidden=true;},2400); }
qs("#share").addEventListener("click", shareImage);

/* ---- boot ---- */
(async function(){
  try{
    CLUBS=await getClubs();
    qs("#clubcount").textContent=`${CLUBS.length}`;
    const spec=qs("#spec-clubs"); if(spec) spec.textContent=`${CLUBS.length} clubs`;
    // Deep link: ?club=<slug> opens straight to that club (shareable URLs).
    const cslug=new URLSearchParams(location.search).get("club");
    if(cslug){ const m=CLUBS.find(c=>slugify(c.clubName)===cslug); if(m){ selectClub(m,true); return; } }
    if(document.activeElement===q) renderDropdown(filterClubs(q.value),q.value.trim());
  }catch{
    q.placeholder="Couldn't reach the pricing service — try again later";
  }
})();
