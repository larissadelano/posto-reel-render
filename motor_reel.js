// ═══════════════════════════════════════════════════════════════════
// POSTÔ · MOTOR DE REEL — v1 (foto)  ·  espelha o Motor de Design
//
// Gera o HTML animado (window.seek(t)) do Reel do cliente: mídia em
// tela cheia (Ken Burns) + degradê que garante leitura + tipografia
// ancorada + palavra-chave no acento + fecho com CTA e @ do cliente.
// Renderizado frame a frame (Playwright) → ffmpeg → .mp4 1080×1920.
//
// Os 11 ESTILOS usam a MESMA paleta/fontes do Motor de Design (FALLBACK),
// e cada um tem CARÁTER DE MOVIMENTO próprio (corte seco x fade, snap x
// rise, intensidade de Ken Burns). Cores do cliente entram via C (Ag2);
// estilo POSTÔ é o único de paleta fixa.
//
// ENTRADA: buildReelStage({ tela, media, C, estiloSlug, handle, fontCss })
//   tela  = { kicker, hook, beats:[{texto, hi}], cta }   (texto curto p/ tela)
//   media = [url, url, ...]  (fotos do briefing; distribui sem repetir)
//   C     = { bg, primary, secondary, text, accent, tFont, bFont, escuro }
// ═══════════════════════════════════════════════════════════════════

// FALLBACK premium dos 11 estilos (idêntico ao Motor de Design v6.2)
const FALLBACK = {
  "sereno":      { bg:"#F2EDE3", primary:"#9B7E4F", secondary:"#C9A86A", text:"#1F1B16", accent:"#9B7E4F", tFont:"Cormorant Garamond", bFont:"Inter",        escuro:false },
  "bold":        { bg:"#0A0A0A", primary:"#FF3D24", secondary:"#FFFFFF", text:"#FFFFFF", accent:"#FF3D24", tFont:"Anton",             bFont:"Inter",        escuro:true, upper:true },
  "magazine":    { bg:"#181410", primary:"#D4B069", secondary:"#FAF6EC", text:"#FAF6EC", accent:"#D4B069", tFont:"Cormorant Garamond", bFont:"Lato",         escuro:true },
  "botanico":    { bg:"#E8DFCD", primary:"#5E7A5E", secondary:"#3D2E1F", text:"#3D2E1F", accent:"#5E7A5E", tFont:"Cormorant Garamond", bFont:"Karla",        escuro:false },
  "clinico":     { bg:"#FAFAFB", primary:"#3D7DCA", secondary:"#1A2942", text:"#1A2942", accent:"#3D7DCA", tFont:"Inter",             bFont:"DM Mono",      escuro:false },
  "solar":       { bg:"#FFD93D", primary:"#6B2FBE", secondary:"#1A1A1A", text:"#1A1A1A", accent:"#6B2FBE", tFont:"Inter",             bFont:"Inter",        escuro:false },
  "arquitetura": { bg:"#1A1F2E", primary:"#E8B860", secondary:"#F0F0F0", text:"#F0F0F0", accent:"#E8B860", tFont:"DM Mono",           bFont:"Inter",        escuro:true },
  "romantico":   { bg:"#FBF6F0", primary:"#B98088", secondary:"#5C3A4A", text:"#5C3A4A", accent:"#C9A876", tFont:"Cormorant Garamond", bFont:"Quicksand",    escuro:false },
  "noir-tech":   { bg:"#1C1C20", primary:"#00E5FF", secondary:"#E8E8EC", text:"#E8E8EC", accent:"#00E5FF", tFont:"Space Grotesk",     bFont:"DM Mono",      escuro:true },
  "inspirador":  { bg:"#2D1B3D", primary:"#FF6B9D", secondary:"#FFA45C", text:"#FFFFFF", accent:"#FF6B9D", tFont:"Cormorant Garamond", bFont:"Quicksand",    escuro:true },
  "posto":       { bg:"#08080C", primary:"#C9A84C", secondary:"#F5F0E8", text:"#F5F0E8", accent:"#C9A84C", tFont:"Cormorant Garamond", bFont:"DM Sans",      escuro:true },
};

// CARÁTER DE MOVIMENTO por estilo (ritmo, transição, entrada do texto, Ken Burns)
const MOTION = {
  "bold":        { dur:2.6, trans:'cut',  textIn:'snap', kb:0.10, upper:true },
  "noir-tech":   { dur:2.7, trans:'cut',  textIn:'snap', kb:0.08 },
  "solar":       { dur:2.8, trans:'cut',  textIn:'snap', kb:0.09, upper:true },
  "arquitetura": { dur:3.0, trans:'fade', textIn:'snap', kb:0.07, upper:true },
  "clinico":     { dur:3.0, trans:'fade', textIn:'rise', kb:0.06 },
  "magazine":    { dur:3.4, trans:'fade', textIn:'rise', kb:0.08 },
  "sereno":      { dur:3.3, trans:'fade', textIn:'rise', kb:0.07 },
  "botanico":    { dur:3.2, trans:'fade', textIn:'rise', kb:0.07 },
  "romantico":   { dur:3.5, trans:'fade', textIn:'rise', kb:0.08 },
  "inspirador":  { dur:3.1, trans:'fade', textIn:'rise', kb:0.09 },
  "posto":       { dur:3.2, trans:'fade', textIn:'rise', kb:0.08 },
};

function slugEstilo(s){
  return String(s||'sereno').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z]/g,'').replace('postoexclusivo','posto').replace('noirtech','noir-tech');
}
const esc = t => String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── contraste (luminância) — garante texto/acento legível, igual ao motor ──
function hexRgb(h){ h=String(h).replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function lum(h){ const c=hexRgb(h).map(v=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; }
function textoSobre(bg){ return lum(bg)>0.5?'#141414':'#FFFFFF'; }
function accentSobre(bg, accent){ return Math.abs(lum(bg)-lum(accent))>0.16 ? accent : textoSobre(bg); }

function buildReelStage({ tela, media, C, estiloSlug, handle, fontCss }){
  const slug = (estiloSlug ? slugEstilo(estiloSlug) : 'sereno');
  const FB = FALLBACK[slug] || FALLBACK['sereno'];
  const M  = MOTION[slug]   || MOTION['sereno'];
  // C (cores do cliente/Ag2) com fallback do estilo
  C = C || {};
  const col = {
    bg:     C.bg     || FB.bg,
    text:   C.text   || FB.text,
    accent: C.accent || FB.accent,
    tFont:  C.tFont  || FB.tFont,
    bFont:  C.bFont  || FB.bFont,
    escuro: (C.escuro != null ? C.escuro : FB.escuro),
  };
  const UPPER = !!(M.upper || FB.upper);
  const accentCol = accentSobre(col.bg, col.accent);
  const textCol   = col.text;
  const fotos = (media || []).filter(Boolean);
  let fi = 0; const proxFoto = () => fotos.length ? fotos[fi++ % fotos.length] : '';

  const t = tela || {};
  const beats = (t.beats || []).filter(b => b && String(b.texto||'').trim());

  // ── timeline ──
  const D = M.dur, DHOOK = D + 0.6, DEND = D + 1.0;
  const seq = [];
  seq.push({ type:'hook', dur:DHOOK, foto:proxFoto(), txt:t.hook||'', hi:t.hookHi||'', kicker:t.kicker||'' });
  beats.forEach(b => seq.push({ type:'beat', dur:D, foto:proxFoto(), txt:b.texto, hi:b.hi||'' }));
  seq.push({ type:'end', dur:DEND, txt:t.cta||'', handle:handle||'' });
  let acc=0; seq.forEach(s=>{ s.start=acc; acc+=s.dur; }); const total=acc;

  const up = s => UPPER ? String(s).toUpperCase() : s;
  function frag(txt, hi){
    txt = String(txt||'');
    if (hi && txt.toLowerCase().includes(String(hi).toLowerCase())){
      const i = txt.toLowerCase().indexOf(String(hi).toLowerCase());
      const a = txt.slice(0,i), b = txt.slice(i, i+hi.length), c = txt.slice(i+hi.length);
      return `${esc(up(a))}<span class="hi">${esc(up(b))}</span>${esc(up(c))}`;
    }
    return esc(up(txt));
  }

  const html = seq.map((s, idx) => {
    if (s.type === 'end'){
      return `<div class="fr end" id="f${idx}"><div class="ein">
        <div class="cta">${frag(s.txt, t.ctaHi)}</div><div class="rule"></div>
        ${s.handle?`<div class="hd">@${esc(String(s.handle).replace(/^@/,''))}</div>`:''}
      </div></div>`;
    }
    const photo = s.foto ? `<div class="ph" id="ph${idx}" style="background-image:url('${s.foto}')"></div>` : `<div class="ph solidph"></div>`;
    const kicker = s.type==='hook' && s.kicker ? `<div class="kicker">${esc(up(s.kicker))}</div>` : '';
    const cls = s.type==='hook' ? 'big' : 'mid';
    return `<div class="fr media" id="f${idx}">
      ${photo}<div class="scrim"></div>${kicker}
      <div class="tx ${cls}"><span class="in">${frag(s.txt, s.hi)}</span></div>
    </div>`;
  }).join('\n');

  const scrimDir = `linear-gradient(to top, ${col.bg} 3%, ${col.escuro?'rgba(0,0,0,.5)':'rgba(255,255,255,.32)'} 26%, rgba(0,0,0,0) 60%)`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden;background:${col.bg}}
.stage{width:1080px;height:1920px;position:relative;font-family:'${col.bFont}',sans-serif}
.fr{position:absolute;inset:0;opacity:0;background:${col.bg}}
.ph{position:absolute;inset:0;background-size:cover;background-position:center 30%;transform:scale(1)}
.solidph{background:${col.bg}}
.scrim{position:absolute;inset:0;background:${scrimDir}}
.kicker{position:absolute;top:118px;left:96px;right:96px;font-family:'${col.bFont}',sans-serif;font-weight:700;font-size:34px;letter-spacing:.2em;color:${accentCol};text-transform:uppercase}
.tx{position:absolute;left:96px;right:120px;bottom:236px;font-family:'${col.tFont}',serif;color:${textCol};font-weight:600}
.tx.big{font-size:${UPPER?168:128}px;line-height:${UPPER?0.98:1.06}}
.tx.mid{font-size:${UPPER?108:96}px;line-height:${UPPER?1.0:1.1}}
.tx .in{display:inline-block;will-change:transform,opacity}
.hi{color:${accentCol}}
.romantico .hi,.magazine .hi,.sereno .hi,.inspirador .hi,.posto .hi,.botanico .hi{font-style:italic}
.end{display:flex;align-items:center;justify-content:center;background:${col.bg}}
.ein{display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 130px}
.cta{font-family:'${col.tFont}',serif;font-weight:600;font-size:${UPPER?100:96}px;line-height:1.1;color:${textCol}}
.rule{width:80px;height:5px;background:${accentCol};border-radius:3px;margin:42px 0 30px}
.hd{font-family:'${col.bFont}',sans-serif;font-weight:700;font-size:42px;letter-spacing:.14em;color:${accentCol};text-transform:uppercase}
.vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(135% 95% at 50% 30%, rgba(0,0,0,0) 42%, ${col.escuro?'rgba(0,0,0,.34)':'rgba(0,0,0,.10)'} 100%)}
</style></head><body class="${slug}">
<div class="stage">
${html}
<div class="vig"></div>
</div>
<script>
const SEQ=${JSON.stringify(seq.map(s=>({start:s.start,dur:s.dur,type:s.type})))};
const TRANS='${M.trans}', TEXTIN='${M.textIn}', KB=${M.kb};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const ease=t=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
const easeOut=t=>1-Math.pow(1-t,3);
function fade(t,a,b,f){ if(t<a||t>b) return 0; if(t<a+f) return (t-a)/f; if(t>b-f) return (b-t)/f; return 1; }
window.seek=function(t){
  for(let i=0;i<SEQ.length;i++){
    const s=SEQ[i], fr=document.getElementById('f'+i);
    const last=i===SEQ.length-1;
    let o;
    if(last){ o=clamp((t-s.start)/0.4,0,1); }
    else if(TRANS==='cut'){ // corte seco: troca quase instantânea, sem sumir no meio
      const end=s.start+s.dur; o=(t>=s.start-0.04 && t<end-0.04)?1:0;
      if(t>=s.start-0.04 && t<s.start+0.09) o=clamp((t-(s.start-0.04))/0.13,0,1);
    } else { o=fade(t, s.start, s.start+s.dur, 0.40); }
    fr.style.opacity=o;
    const inner=fr.querySelector('.in');
    if(inner){
      const p=clamp((t-s.start-0.04)/(TEXTIN==='snap'?0.20:0.55),0,1);
      if(TEXTIN==='snap'){ const e=easeOut(p); inner.style.transform='translateY('+((1-e)*18)+'px) scale('+(0.94+0.06*e)+')'; inner.style.opacity=p<0.05?0:1; }
      else { const e=ease(p); inner.style.transform='translateY('+((1-e)*40)+'px)'; inner.style.opacity=e; }
    }
    const ph=document.getElementById('ph'+i);
    if(ph){ const k=clamp((t-s.start)/s.dur,0,1); ph.style.transform='scale('+(1+KB*k)+') translateY('+(-k*14)+'px)'; }
    const kk=fr.querySelector('.kicker');
    if(kk){ kk.style.opacity=clamp((t-s.start-0.15)/0.4,0,1); }
  }
};
seek(0); window.__TOTAL__=${total.toFixed(3)}; window.__SEQ__=SEQ;
</script></body></html>`;
}

module.exports = { buildReelStage, FALLBACK, slugEstilo };
