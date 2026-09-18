/* The Price Book — independent, unofficial David Lloyd price lookup.
 * Fully client-side and self-updating: clubs come from /clubs, and the set of
 * plans / membership types / durations is read from the API's own enum (by
 * asking for a bogus value and parsing the rejection). Nothing is hardcoded, so
 * new clubs and new plans appear on their own.                                */
"use strict";

const API = "https://mobile-app-back.davidlloyd.co.uk";
const CONCURRENCY = 8;
const DAY = 864e5;

/* Snapshot used only if the live enum discovery ever fails, so the page still
 * works. The live values always win when available.                          */
const FALLBACK = {
  packages: ["CLUB","CLUB_PLUS","CLUB_PLATINUM","CLUB_PLATINUM_HOME","DIAMOND_PLUS",
    "PLATINUM_INFINITY","PLATINUM_SPA","EVERGREEN","FAMILY_PLUS","FAMILY_PLATINUM",
    "YOUNG_ADULT","YOUNG_ADULT_PLUS","YOUNG_ADULT_PLATINUM","JUNIOR","DIGITAL_MEMBERSHIP"],
  types: ["INDIVIDUAL","COUPLE","FAMILY"],
  durations: ["STANDARD","FLEXIBLE","ANNUAL"],
};
const TYPE_LABEL = { INDIVIDUAL:"Individual", COUPLE:"Couple", FAMILY:"Family" };
const DUR_LABEL  = { STANDARD:"Monthly rolling", FLEXIBLE:"Flexible", ANNUAL:"Paid annually" };

const $ = s => document.querySelector(s);
const todayISO = () => new Date().toISOString().slice(0,10);

/* ---- tiny cache helpers ---- */
function cacheGet(k){ try{ const v=JSON.parse(localStorage.getItem(k)); if(v&&v.t&&Date.now()-v.t<v.ttl) return v.d; }catch{} return null; }
function cacheSet(k,d,ttl){ try{ localStorage.setItem(k,JSON.stringify({t:Date.now(),ttl,d})); }catch{} }

/* ---- data ---- */
async function getClubs(){
  const c = cacheGet("pb_clubs"); if(c) return c;
  const r = await fetch(`${API}/clubs`); const j = await r.json();
  const clubs = (j.clubs||[]).filter(c=>c.status==="active").sort((a,b)=>a.clubName.localeCompare(b.clubName));
  cacheSet("pb_clubs", clubs, DAY);
  return clubs;
}

function parseEnum(text){
  const m = /accepted for Enum class:\s*\[([^\]]+)\]/.exec(text||"");
  return m ? m[1].split(",").map(s=>s.trim()).filter(Boolean) : null;
}
async function bogus(field){
  const body = { siteId:91, membershipType:"INDIVIDUAL", packageKey:"CLUB_PLATINUM",
    membershipDuration:"STANDARD", startDate:todayISO(), promotionIds:[], associatedMemberTypes:[], journeyType:"NORMAL" };
  body[field] = "____";
  try{
    const r = await fetch(`${API}/membership/price-breakdown`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const j = await r.json();
    return parseEnum(j?.errors?.[0]?.error);
  }catch{ return null; }
}
async function getEnums(){
  const c = cacheGet("pb_enums"); if(c) return c;
  const [packages,types,durations] = await Promise.all([bogus("packageKey"),bogus("membershipType"),bogus("membershipDuration")]);
  const e = {
    packages: packages||FALLBACK.packages,
    types:    (types||FALLBACK.types),
    durations:(durations||FALLBACK.durations),
  };
  cacheSet("pb_enums", e, DAY);
  return e;
}

function journeyFor(pkg){
  if(/^TEAM_CORPORATE|^CORPORATE/.test(pkg)) return "CORPORATE";
  if(/^YOUNG_ADULT/.test(pkg)) return "YOUNG_ADULT";
  if(/^FAMILY/.test(pkg)) return "FAMILY";
  return "NORMAL";
}
async function price(siteId,pkg,type,dur,signal){
  const body = { siteId, membershipType:type, packageKey:pkg, membershipDuration:dur,
    startDate:todayISO(), promotionIds:[], associatedMemberTypes:[], journeyType:journeyFor(pkg) };
  try{
    const r = await fetch(`${API}/membership/price-breakdown`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal});
    if(!r.ok) return null;
    const j = await r.json(); const p = j?.prices;
    if(!p || p.monthlyFeeInPennies==null) return null;
    return { monthly:p.monthlyFeeInPennies, joining:p.joiningFeeInPennies||0, total:p.totalPriceInPennies||0 };
  }catch{ return null; }
}

/* run tasks with bounded concurrency; onProgress(done,total) */
async function pool(items, worker, onProgress){
  let i=0, done=0; const total=items.length;
  async function run(){ while(i<total){ const idx=i++; await worker(items[idx],idx); onProgress&&onProgress(++done,total); } }
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,total)},run));
}

/* ---- format ---- */
const fmt = (pennies,cur) => new Intl.NumberFormat("en-GB",{style:"currency",currency:cur,minimumFractionDigits:0,maximumFractionDigits:pennies%100?2:0}).format(pennies/100);
function prettyPlan(key){
  return key.toLowerCase().split("_").map(w=>{
    if(w==="dl") return "DL"; return w.charAt(0).toUpperCase()+w.slice(1);
  }).join(" ").replace(/\bPlatinum Home\b/,"Platinum (Home)");
}

/* ---- state ---- */
let CLUBS=[], ENUMS=null, CURRENT=null, CURDUR="STANDARD", token=0;

/* ---- search / dropdown ---- */
const q=$("#q"), dd=$("#results-list");
let active=-1, shown=[];
function renderDropdown(list,term){
  shown=list;
  if(!list.length){ dd.innerHTML=`<li class="none" role="option">No club matches “${term}”</li>`; dd.hidden=false; q.setAttribute("aria-expanded","true"); return; }
  const rx = term? new RegExp("("+term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+")","ig") : null;
  dd.innerHTML = list.slice(0,60).map((c,idx)=>{
    const name = rx? c.clubName.replace(rx,"<mark>$1</mark>") : c.clubName;
    return `<li role="option" data-idx="${idx}" aria-selected="${idx===active}">
      <span class="cn">${name}</span>
      <span class="cl">${c.country||""}</span>
      <span class="cc">${c.currency||""}</span></li>`;
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
  else if(e.key==="Enter"){ e.preventDefault(); if(active>=0&&shown[active]) selectClub(shown[active]); else if(shown[0]) selectClub(shown[0]); return; }
  else if(e.key==="Escape"){ closeDropdown(); q.blur(); return; }
  else return;
  [...dd.children].forEach((li,i)=>li.setAttribute("aria-selected", i===active));
  const el=dd.children[active]; el&&el.scrollIntoView({block:"nearest"});
});
dd.addEventListener("mousedown",e=>{ const li=e.target.closest("li[data-idx]"); if(li) selectClub(shown[+li.dataset.idx]); });
document.addEventListener("click",e=>{ if(!e.target.closest(".combo")) closeDropdown(); });

/* ---- select + price a club ---- */
async function selectClub(club){
  CURRENT=club; token++; const my=token;
  q.value=club.clubName; closeDropdown(); q.blur();
  $("#intro").style.display="none";
  const panel=$("#panel"); panel.hidden=false;
  $("#clubname").textContent=club.clubName;
  $("#clubsub").innerHTML=`<span class="pin">◆</span> ${club.country||"—"} <span class="sep">/</span> site #${club.siteId} <span class="sep">/</span> prices in ${club.currency}`;
  buildDurations();
  panel.scrollIntoView({behavior:"smooth",block:"start"});
  await loadPrices(my);
}
function buildDurations(){
  const wrap=$("#durations"); const durs=ENUMS.durations.filter(d=>DUR_LABEL[d]).length?ENUMS.durations:FALLBACK.durations;
  if(!durs.includes(CURDUR)) CURDUR=durs[0];
  wrap.innerHTML=durs.map(d=>`<button role="tab" data-dur="${d}" aria-selected="${d===CURDUR}">${DUR_LABEL[d]||prettyPlan(d)}</button>`).join("");
  wrap.querySelectorAll("button").forEach(b=>b.onclick=()=>{ if(b.dataset.dur===CURDUR) return; CURDUR=b.dataset.dur;
    wrap.querySelectorAll("button").forEach(x=>x.setAttribute("aria-selected",x.dataset.dur===CURDUR));
    token++; loadPrices(token); });
}

async function loadPrices(my){
  const club=CURRENT, cur=club.currency, dur=CURDUR;
  const table=$("#pricetable"), tbody=$("#tbody"), status=$("#status"), empty=$("#empty"), foot=$("#foot-note");
  empty.hidden=true; foot.hidden=true;
  const ckey=`pb_px_${club.siteId}_${dur}`;
  const cached=cacheGet(ckey);
  if(cached){ if(my!==token) return; renderTable(cached,cur); return; }

  table.hidden=true; tbody.innerHTML="";
  status.hidden=false; status.innerHTML=`<span class="spin"></span><span>Pulling live prices…</span><span class="bar"><i></i></span>`;
  const bar=status.querySelector(".bar i");

  const types=ENUMS.types.filter(t=>TYPE_LABEL[t]).length?ENUMS.types.filter(t=>TYPE_LABEL[t]):FALLBACK.types;
  const pkgs=ENUMS.packages;
  const jobs=[]; for(const p of pkgs) for(const t of types) jobs.push([p,t]);
  const ctrl=new AbortController();
  const data={}; // pkg -> {type -> price}
  await pool(jobs, async ([p,t])=>{
    if(my!==token){ ctrl.abort(); return; }
    const res=await price(club.siteId,p,t,dur,ctrl.signal);
    if(res){ (data[p]=data[p]||{})[t]=res; }
  }, (done,total)=>{ if(my===token && bar) bar.style.width=Math.round(done/total*100)+"%"; });
  if(my!==token) return;

  const offered=Object.keys(data);
  if(offered.length) cacheSet(ckey,data,DAY/2);
  renderTable(data,cur);
}

function renderTable(data,cur){
  const table=$("#pricetable"), thead=$("#thead-row"), tbody=$("#tbody"), status=$("#status"), empty=$("#empty"), foot=$("#foot-note");
  status.hidden=true;
  const types=ENUMS.types.filter(t=>TYPE_LABEL[t]);
  const offered=Object.keys(data);
  if(!offered.length){ table.hidden=true; empty.hidden=false; foot.hidden=true; return; }

  // sort plans by cheapest available monthly
  const minMonthly=p=>Math.min(...types.map(t=>data[p][t]?.monthly ?? Infinity));
  offered.sort((a,b)=>minMonthly(a)-minMonthly(b));
  const cheapest=offered.reduce((m,p)=>minMonthly(p)<minMonthly(m)?p:m,offered[0]);

  thead.innerHTML=`<th>Plan</th>`+types.map(t=>`<th>${TYPE_LABEL[t]}</th>`).join("");
  tbody.innerHTML=offered.map(p=>{
    const cells=types.map(t=>{
      const r=data[p][t];
      if(!r) return `<td class="cell na">—</td>`;
      const tag = (p===cheapest && r.monthly===minMonthly(p)) ? `<div class="best-tag">Lowest</div>`:"";
      return `<td class="cell"><div class="mo">${fmt(r.monthly,cur)}<span class="per">/mo</span></div>`+
             `<div class="join">${r.joining?`+ ${fmt(r.joining,cur)} joining`:`no joining fee`}</div>${tag}</td>`;
    }).join("");
    return `<tr class="${p===cheapest?"best":""}"><td class="plan"><div class="pn">${prettyPlan(p)}</div><div class="pk">${p}</div></td>${cells}</tr>`;
  }).join("");
  table.hidden=false; empty.hidden=true;
  foot.hidden=false;
  foot.textContent=`Standard rates before any promotion · ${offered.length} plan${offered.length>1?"s":""} on offer · pulled live ${new Date().toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}. Joining fees are one-off; monthly fees recur.`;
}

/* ---- boot ---- */
(async function(){
  try{
    ENUMS=await getEnums();
    CLUBS=await getClubs();
    $("#clubcount").textContent=`${CLUBS.length} clubs`;
    if(document.activeElement===q) renderDropdown(filterClubs(q.value),q.value.trim());
  }catch(e){
    $("#q").placeholder="Couldn't reach the pricing service — try again later";
  }
})();
