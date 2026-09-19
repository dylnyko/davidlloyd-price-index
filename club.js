/* Rack Rate — static club page interactivity.
 * The page is pre-rendered by scripts/snapshot.mjs using shared.js; this hydrates:
 * re-renders identically to populate state, wires the duration tabs, plan modal,
 * share image and the "near me" distance. Same renderer (shared.js) as the build. */
"use strict";
const PB = window.PB;
const qs = (s) => document.querySelector(s);
const B = JSON.parse(qs("#pb-bundle").textContent);
let CURDUR = "STANDARD", PLANINFO = {}, LASTIMG = null, CURCANVAS = null;

/* price trend from the embedded per-club history slice */
function trendFor(key){
  if(CURDUR==="FLEXIBLE") return null;
  const arr = ((B.series||{})[key]||{})[CURDUR==="ANNUAL"?"iA":"iS"];
  if(!arr || arr.length<2) return null;
  const c=arr[arr.length-1][1], p=arr[arr.length-2];
  if(c===p[1]) return null;
  return { delta:c-p[1], since:p[0], up:c>p[1] };
}

function renderTable(){
  const dur=CURDUR, cur=B.currency, unit=dur==="ANNUAL"?"/yr":"/mo";
  const R = PB.priceTableHTML({ packages:B.packages, addOns:B.addOns, dur, currency:cur, mostPopular:B.mostPopular, accessNames:B.accessNames, trend:trendFor });
  if(R.empty) return;
  qs("#thead-row").innerHTML=R.thead; qs("#tbody").innerHTML=R.tbody; PLANINFO=R.planinfo;
  const ad=qs("#addons"); ad.hidden=!R.addonsHTML; ad.innerHTML=R.addonsHTML||"";
  const foot=qs("#foot-note"); const snap=B.date?`From David Lloyd’s snapshot of ${PB.fmtDate(B.date)}.`:"";
  const ft=(snap+(dur==="ANNUAL"?" Prices shown are the annual total.":"")).trim(); foot.hidden=!ft; foot.textContent=ft;
  // model for the shareable image (same order/types the builder used)
  const priceAt=(p,t)=>{ const d=p.prices&&p.prices[dur]; const v=d&&d[PB.TYPE_FIELD[t]]; return v==null?null:v; };
  LASTIMG={ club:B.name, brand:"David Lloyd", country:B.country||"", term:PB.DUR_LABEL[dur]||dur,
    cols:R.activeTypes.map(t=>({label:PB.TYPE_LABEL[t],pp:t!=="INDIVIDUAL"})),
    rows:R.pkgs.map(p=>{ const jf=p.prices[dur].joiningFee||0;
      return { name:PB.prettyPlan(p.packageKey), desc:PB.descOf(p), pop:p.packageKey===B.mostPopular,
        cells:R.activeTypes.map(t=>{ const v=priceAt(p,t); if(v==null) return null;
          return { price:PB.fmt(v,cur), unit, join: jf?`+ ${PB.fmt(jf,cur)} joining`:"no joining fee" }; }) }; }),
    url:(location.host+location.pathname).replace(/\/$/,"")+"/",
    date:B.date?PB.fmtDate(B.date):"" };
}

/* duration tabs */
qs("#durations")?.querySelectorAll("button").forEach((b)=>b.onclick=()=>{
  if(b.dataset.dur===CURDUR) return; CURDUR=b.dataset.dur;
  qs("#durations").querySelectorAll("button").forEach((x)=>x.setAttribute("aria-selected", x.dataset.dur===CURDUR));
  renderTable();
});

/* plan details modal */
function openPlanModal(key){
  const info=PLANINFO[key]; if(!info) return;
  qs("#plantitle").textContent=info.name;
  const d=qs("#plandesc"); d.textContent=info.desc||""; d.hidden=!info.desc;
  const bh=qs("#planbens-h"); if(bh) bh.hidden=!info.bens.length;
  qs("#planbens").innerHTML=info.bens.length?info.bens.map((x)=>`<span class="ben">${PB.esc(x)}</span>`).join(""):"";
  const a=qs("#planaccess"); if(a) a.innerHTML=(info.access&&info.access.length)?`<h4 class="modal-h">Clubs you can access · ${info.access.length}</h4><p class="access-list">${info.access.map(PB.esc).join(" · ")}</p>`:"";
  qs("#planmodal").hidden=false; document.body.style.overflow="hidden";
}
function closePlanModal(){ qs("#planmodal").hidden=true; document.body.style.overflow=""; }
qs("#tbody").addEventListener("click",(e)=>{ const b=e.target.closest(".pn-more"); if(b) openPlanModal(b.dataset.key); });
qs("#planmodal").addEventListener("click",(e)=>{ if(e.target.closest("[data-close]")) closePlanModal(); });

/* shareable image */
function ellipsize(ctx,text,maxW){ if(!text) return ""; if(ctx.measureText(text).width<=maxW) return text; let t=text; while(t.length>1&&ctx.measureText(t+"…").width>maxW) t=t.slice(0,-1); return t.replace(/[ ,.;:]+$/,"")+"…"; }
function drawShare(m){
  const INK="#0b0b0a", PAPER="#efece3", ACCENT="#ff3d00", MUTED="#6b675d", LINE="rgba(11,11,10,0.14)";
  const DISP='"Bricolage Grotesque", sans-serif', MONO='"Space Mono", monospace';
  const S=2, W=960, P=48, ncol=m.cols.length;
  const planW=Math.round((W-2*P)*0.40), priceW=Math.round((W-2*P-planW)/ncol);
  const colR=i=>P+planW+priceW*(i+1)-8; const RH=66;
  const yWord=P+16,yBrand=yWord+42,yClub=yBrand+44,yTerm=yClub+24,yDiv=yTerm+22,yHead=yDiv+34,yRule=yHead+26,yRows=yRule+12;
  const yFoot=yRows+m.rows.length*RH+26, H=yFoot+44+P-24;
  const cv=document.createElement("canvas"); cv.width=W*S; cv.height=H*S;
  const ctx=cv.getContext("2d"); ctx.scale(S,S); ctx.textBaseline="alphabetic";
  ctx.fillStyle=PAPER; ctx.fillRect(0,0,W,H); ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.strokeRect(1,1,W-2,H-2);
  ctx.textAlign="left"; ctx.fillStyle=INK; ctx.font=`700 14px ${MONO}`; ctx.fillText("RACK RATE", P, yWord);
  ctx.textAlign="right"; ctx.fillStyle=MUTED; ctx.font=`400 13px ${MONO}`; ctx.fillText(m.date, W-P, yWord);
  // Header block mirrors the club page: "David Lloyd" eyebrow, club name, ◆ country.
  ctx.textAlign="left"; ctx.fillStyle=MUTED; ctx.font=`600 20px ${DISP}`; ctx.fillText(m.brand, P, yBrand);
  ctx.fillStyle=INK; ctx.font=`700 44px ${DISP}`; ctx.fillText(m.club, P, yClub);
  if(m.country){ const cx=P+ctx.measureText(m.club).width+18;
    ctx.font=`400 13px ${MONO}`; ctx.fillStyle=ACCENT; ctx.fillText("◆", cx, yClub-4);
    ctx.fillStyle=MUTED; ctx.fillText(m.country.toUpperCase(), cx+ctx.measureText("◆ ").width, yClub-4); }
  if(m.term){ ctx.fillStyle=MUTED; ctx.font=`400 13px ${MONO}`; ctx.fillText(m.term.toUpperCase(), P, yTerm); }
  ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(P,yDiv); ctx.lineTo(W-P,yDiv); ctx.stroke();
  ctx.textAlign="left"; ctx.fillStyle=ACCENT; ctx.font=`700 12px ${MONO}`; ctx.fillText("PLAN", P, yHead);
  ctx.textAlign="right";
  m.cols.forEach((c,i)=>{ ctx.fillStyle=ACCENT; ctx.font=`700 12px ${MONO}`; ctx.fillText(c.label.toUpperCase(), colR(i), yHead);
    if(c.pp){ ctx.fillStyle=MUTED; ctx.font=`400 9px ${MONO}`; ctx.fillText("PER PERSON", colR(i), yHead+13); } });
  ctx.strokeStyle=INK; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(P,yRule); ctx.lineTo(W-P,yRule); ctx.stroke();
  m.rows.forEach((r,ri)=>{ const top=yRows+ri*RH;
    ctx.textAlign="left"; ctx.fillStyle=INK; ctx.font=`700 19px ${DISP}`; ctx.fillText(r.name, P, top+26);
    if(r.pop){ const w=ctx.measureText(r.name).width; ctx.font=`700 9px ${MONO}`; ctx.fillStyle=ACCENT; ctx.fillText("★ MOST POPULAR", P+w+10, top+24); }
    if(r.desc){ ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED; ctx.fillText(ellipsize(ctx,r.desc,planW-6), P, top+45); }
    r.cells.forEach((cell,i)=>{ const rx=colR(i);
      if(!cell){ ctx.textAlign="right"; ctx.fillStyle=MUTED; ctx.font=`400 18px ${MONO}`; ctx.fillText("—", rx, top+27); return; }
      ctx.textAlign="right"; ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED; ctx.fillText(cell.unit, rx, top+26);
      const uw=ctx.measureText(cell.unit).width+3;
      ctx.font=`700 19px ${MONO}`; ctx.fillStyle=INK; ctx.fillText(cell.price, rx-uw, top+27);
      ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED; ctx.fillText(cell.join, rx, top+45); });
    ctx.strokeStyle=LINE; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(P,top+RH); ctx.lineTo(W-P,top+RH); ctx.stroke(); });
  ctx.textAlign="left"; ctx.font=`700 13px ${MONO}`; ctx.fillStyle=ACCENT; ctx.fillText(m.url, P, yFoot+16);
  ctx.font=`400 11px ${MONO}`; ctx.fillStyle=MUTED;
  ctx.fillText(`Unofficial · not affiliated with David Lloyd`, P, yFoot+36);
  return cv;
}
let _toastT; function toast(msg){ const t=qs("#toast"); if(!t) return; t.textContent=msg; t.hidden=false; clearTimeout(_toastT); _toastT=setTimeout(()=>{t.hidden=true;},2400); }
function openShare(){ if(!LASTIMG) return; CURCANVAS=drawShare(LASTIMG); qs("#share-preview").src=CURCANVAS.toDataURL("image/png"); qs("#share-link").textContent="https://"+LASTIMG.url; qs("#sharemodal").hidden=false; document.body.style.overflow="hidden"; }
function closeShare(){ qs("#sharemodal").hidden=true; document.body.style.overflow=""; }
function copyImg(){ if(!CURCANVAS) return; try{ const item=new ClipboardItem({ "image/png": new Promise(res=>CURCANVAS.toBlob(b=>res(b),"image/png")) }); navigator.clipboard.write([item]).then(()=>toast("Image copied ✓")).catch(()=>downloadCanvas(CURCANVAS)); }catch(e){ downloadCanvas(CURCANVAS); } }
function copyLink(){ const u="https://"+LASTIMG.url; (navigator.clipboard?.writeText(u) ?? Promise.reject()).then(()=>toast("Link copied ✓")).catch(()=>toast("Couldn't copy link")); }
function downloadCanvas(cv){ cv.toBlob(b=>{ const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=`rack-rate-${B.slug}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); toast("Image downloaded"); },"image/png"); }
qs("#share").addEventListener("click", openShare);
qs("#sharemodal").addEventListener("click",(e)=>{ if(e.target.closest("[data-close]")) closeShare(); });
qs("#do-copy").addEventListener("click", copyImg);
qs("#do-download").addEventListener("click",()=>{ if(CURCANVAS) downloadCanvas(CURCANVAS); });
qs("#do-link").addEventListener("click", copyLink);
document.addEventListener("keydown",(e)=>{ if(e.key!=="Escape") return; if(!qs("#sharemodal").hidden) closeShare(); if(!qs("#planmodal").hidden) closePlanModal(); });

/* carry the postcode into Compare, and show distance from ?pc= */
(function(){
  const pc=new URLSearchParams(location.search).get("pc"); if(!pc) return;
  const cmp=qs("#do-compare"); if(cmp) cmp.href += `&pc=${encodeURIComponent(pc)}`;
  if(!B.coords) return;
  fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`).then(r=>r.ok?r.json():null).then(j=>{
    if(!j||!j.result) return;
    const R=3958.8, rad=d=>d*Math.PI/180, a={lat:j.result.latitude,lng:j.result.longitude}, b=B.coords;
    const dLat=rad(b.lat-a.lat), dLng=rad(b.lng-a.lng);
    const h=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
    const mi=R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
    const sub=qs("#clubsub"); sub.hidden=false; sub.innerHTML=`<span class="pin">◆</span> ${mi<10?mi.toFixed(1):Math.round(mi)} mi from ${PB.esc(j.result.postcode)}`;
  }).catch(()=>{});
})();

/* hydrate: re-render the pre-rendered STANDARD table identically + populate state */
renderTable();
