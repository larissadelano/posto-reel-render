// ═══════════════════════════════════════════════════════════════════
// POSTÔ · MOTOR DE REEL VÍDEO — v2 (clipes do cliente)
//
// Transforma clipes curtos gravados pelo cliente em reel .mp4 premium
// na marca dele: cortes ritmados (plano do montar_reel_video_plan),
// legendas-beat na tipografia/cores do cliente, cartão final com CTA e @.
//
// PROCESSO (segmento a segmento — nunca o vídeo inteiro em memória):
//   1. ffprobe em cada clipe (duração, dimensão, rotação)
//   2. plano determinístico (montar_reel_video_plan)
//   3. normalização por segmento: 1080×1920, 30fps, sar 1:1
//      · crop central  · fallback blur-pad quando o corte destrói o quadro
//   4. Playwright gera overlays PNG com ALFA (hook, legendas, cartão)
//      na tipografia do estilo + cores do cliente, com protetor de
//      contraste (degradê para o bg do estilo) embutido no PNG
//   5. ffmpeg: concat dos segmentos + cartão → passe único de overlay
//      com fade/rise por caráter do estilo → H.264 yuv420p faststart
//   6. ÁUDIO: MUDO POR DEFINIÇÃO (regra de marca: o áudio em alta é
//      adicionado no app pelo cliente) → -an em todas as etapas
//
// Mesmo sistema de estilos do motor_reel (FALLBACK + caráter de movimento).
// Cores do cliente entram via C (Ag2); estilo POSTÔ é o único de paleta fixa.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { montarPlanoVideo, slugEstilo } = require('./montar_reel_video_plan');

// FALLBACK premium dos 11 estilos (idêntico ao Motor de Design / motor_reel)
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

const esc = t => String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function hexRgb(h){ h=String(h).replace('#',''); if(h.length===3) h=h.split('').map(c=>c+c).join(''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function lum(h){ const c=hexRgb(h).map(v=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; }
function textoSobre(bg){ return lum(bg)>0.5?'#141414':'#FFFFFF'; }
function accentSobre(bg, accent){ return Math.abs(lum(bg)-lum(accent))>0.16 ? accent : textoSobre(bg); }
function rgba(hex, a){ const [r,g,b]=hexRgb(hex); return `rgba(${r},${g},${b},${a})`; }

// ── ffprobe: metadados do clipe ──────────────────────────────────────
function probeClip(file){
  const out = execFileSync('ffprobe', ['-v','error','-select_streams','v:0',
    '-show_entries','stream=width,height,duration,side_data_list:stream_tags=rotate:format=duration',
    '-of','json', file], { encoding:'utf8' });
  const j = JSON.parse(out);
  const st = (j.streams&&j.streams[0])||{};
  let rotation = 0;
  if (st.tags && st.tags.rotate) rotation = parseInt(st.tags.rotate,10)||0;
  (st.side_data_list||[]).forEach(sd=>{ if (sd.rotation!=null) rotation = Math.abs(parseInt(sd.rotation,10))||rotation; });
  const dur = parseFloat(st.duration) || parseFloat(j.format&&j.format.duration) || 0;
  return { w: st.width||0, h: st.height||0, dur, rotation };
}

// ── normalização de UM segmento: 1080×1920 · 30fps · sar 1:1 · mudo ──
function normalizarSegmento(seg, outFile, fps){
  const base = 'fps='+fps+',setsar=1,format=yuv420p';
  let vf;
  if (seg.modo === 'blurpad'){
    // fundo: o próprio clipe esticado + blur + leve escurecida · frente: clipe inteiro fit
    vf = `split[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=32:4,eq=brightness=-0.07[bg2];`+
         `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2];`+
         `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,${base}`;
  } else {
    vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${base}`;
  }
  execFileSync('ffmpeg', ['-y','-loglevel','error',
    '-ss', String(seg.in), '-t', String(seg.dur), '-i', seg.src,
    '-vf', vf, '-an','-c:v','libx264','-crf','17','-preset','veryfast', outFile], { stdio:'inherit' });
}

// ── HTML dos overlays (Playwright fotografa cada um com alfa) ────────
// Overlays de legenda: transparentes, com protetor de contraste embutido
// (degradê para o bg do estilo na zona do texto). Cartão: opaco, na marca.
function buildOverlaysHTML({ plan, C, fontCss }){
  const slug = plan.estilo;
  const FB = FALLBACK[slug] || FALLBACK['sereno'];
  C = C || {};
  const col = {
    bg:     C.bg     || FB.bg,
    text:   C.text   || FB.text,
    accent: C.accent || FB.accent,
    tFont:  C.tFont  || FB.tFont,
    bFont:  C.bFont  || FB.bFont,
    escuro: (C.escuro != null ? C.escuro : FB.escuro),
  };
  const UPPER = !!plan.ritmo.upper;
  const accentCol = accentSobre(col.bg, col.accent);
  const up = s => UPPER ? String(s).toUpperCase() : s;
  function frag(txt, hi){
    txt = String(txt||'');
    if (hi && txt.toLowerCase().includes(String(hi).toLowerCase())){
      const i = txt.toLowerCase().indexOf(String(hi).toLowerCase());
      return `${esc(up(txt.slice(0,i)))}<span class="hi">${esc(up(txt.slice(i,i+hi.length)))}</span>${esc(up(txt.slice(i+hi.length)))}`;
    }
    return esc(up(txt));
  }
  // protetor de contraste: degradê para o bg do estilo (linguagem do motor v1,
  // reforçado para vídeo, que é mais "vivo" que foto)
  const scrim = `linear-gradient(to top, ${col.bg} 4%, ${rgba(col.bg,0.62)} 26%, ${rgba(col.bg,0)} 58%)`;

  const ovs = plan.segmentos.map((s,idx)=>{
    const kicker = s.tipo==='hook' && s.legenda.kicker
      ? `<div class="kicker">${esc(up(s.legenda.kicker))}</div>` : '';
    const cls = s.tipo==='hook' ? 'big' : 'mid';
    return `<div class="ov" id="ov${idx}">
      <div class="scrim"></div>${kicker}
      <div class="tx ${cls}">${frag(s.legenda.texto, s.legenda.hi)}</div>
    </div>`;
  }).join('\n');

  const hd = plan.cartao.handle ? `<div class="hd">@${esc(String(plan.cartao.handle).replace(/^@/,''))}</div>` : '';
  const card = `<div class="ov card" id="card">
    <div class="ein"><div class="cta">${frag(plan.cartao.titulo, plan.cartao.hi)}</div>
    <div class="rule"></div>${hd}</div>
  </div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1920px;overflow:hidden;background:transparent}
.ov{position:absolute;inset:0;display:none;font-family:'${col.bFont}',sans-serif}
.ov.on{display:block}
.scrim{position:absolute;inset:0;background:${scrim}}
.kicker{position:absolute;top:118px;left:96px;right:96px;font-family:'${col.bFont}',sans-serif;font-weight:700;font-size:34px;letter-spacing:.2em;color:${accentCol};text-transform:uppercase;text-shadow:0 2px 18px ${rgba(col.bg,0.85)}}
.tx{position:absolute;left:96px;right:120px;bottom:236px;font-family:'${col.tFont}',serif;color:${col.text};font-weight:600}
.tx.big{font-size:${UPPER?150:118}px;line-height:${UPPER?0.98:1.06}}
.tx.mid{font-size:${UPPER?96:86}px;line-height:${UPPER?1.0:1.12}}
.hi{color:${accentCol}}
.romantico .hi,.magazine .hi,.sereno .hi,.inspirador .hi,.posto .hi,.botanico .hi{font-style:italic}
.card{display:none;background:${col.bg};align-items:center;justify-content:center}
.card.on{display:flex}
.ein{display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 130px}
.cta{font-family:'${col.tFont}',serif;font-weight:600;font-size:${UPPER?100:96}px;line-height:1.1;color:${col.text}}
.rule{width:80px;height:5px;background:${accentCol};border-radius:3px;margin:42px 0 30px}
.hd{font-family:'${col.bFont}',sans-serif;font-weight:700;font-size:42px;letter-spacing:.14em;color:${accentCol};text-transform:uppercase}
</style></head><body class="${slug}">
${ovs}
${card}
<script>
window.show=function(id){document.querySelectorAll('.ov').forEach(e=>e.classList.remove('on'));
  const el=document.getElementById(id); if(el) el.classList.add('on'); return !!el;};
</script></body></html>`;
}

// ── Playwright: fotografa overlays (alfa) e o cartão (opaco) ─────────
async function gerarOverlays({ plan, C, fontCss, workDir, chromium, executablePath, browser }){
  const proprio = !browser;
  if (proprio) browser = await chromium.launch({ executablePath,
    args:['--no-sandbox','--disable-dev-shm-usage','--force-color-profile=srgb'] });
  try {
    const page = await browser.newPage({ viewport:{width:1080,height:1920}, deviceScaleFactor:1 });
    await page.setContent(buildOverlaysHTML({ plan, C, fontCss }), { waitUntil:'networkidle' });
    await page.evaluate(()=>document.fonts.ready);
    await page.waitForTimeout(250);
    const arquivos = { legendas:[], card:'' };
    for (let i=0;i<plan.segmentos.length;i++){
      await page.evaluate(id=>window.show(id), 'ov'+i);
      const f = path.join(workDir, `ov${String(i).padStart(2,'0')}.png`);
      await page.screenshot({ path:f, omitBackground:true });     // alfa preservado
      arquivos.legendas.push(f);
    }
    await page.evaluate(id=>window.show(id), 'card');
    arquivos.card = path.join(workDir, 'card.png');
    await page.screenshot({ path:arquivos.card });                 // opaco (bg do estilo)
    await page.close();
    return arquivos;
  } finally { if (proprio) await browser.close(); }
}

// ── passe final: concat + overlays com fade/rise por caráter ─────────
function montarFinal({ plan, segFiles, cardSeg, ovFiles, out, workDir, fps }){
  // concat (mesmos parâmetros → stream copy)
  const lista = path.join(workDir, 'lista.txt');
  fs.writeFileSync(lista, [...segFiles, cardSeg].map(f=>`file '${f}'`).join('\n'));
  const baseMp4 = path.join(workDir, 'base.mp4');
  execFileSync('ffmpeg', ['-y','-loglevel','error','-f','concat','-safe','0','-i',lista,'-c','copy', baseMp4], { stdio:'inherit' });

  // cada overlay é um stream curto (-t dur do segmento): fade em tempo LOCAL,
  // depois setpts desloca para a janela absoluta. Decode mínimo, alfa correto.
  const cut = plan.ritmo.trans === 'cut';
  const inD  = cut ? 0.10 : 0.30;                       // entrada do texto
  const outD = cut ? 0    : 0.30;                       // saída (cut some com o corte)
  const inputs = [];
  plan.segmentos.forEach((s, i)=>{
    inputs.push('-loop','1','-framerate', String(fps), '-t', s.dur.toFixed(2), '-i', ovFiles[i]);
  });
  const fc = [];
  let prev = '[0:v]';
  plan.segmentos.forEach((s, i)=>{
    const st = s.start, en = s.start + s.dur;
    let cadeia = `[${i+1}:v]format=rgba,fade=t=in:st=0:d=${inD}:alpha=1`;
    if (outD>0) cadeia += `,fade=t=out:st=${(s.dur-outD).toFixed(2)}:d=${outD}:alpha=1`;
    cadeia += `,setpts=PTS-STARTPTS+${st.toFixed(2)}/TB[o${i}]`;
    fc.push(cadeia);
    // rise: só nos estilos fade/rise — o overlay sobe 34px com ease-out
    const rise = (!cut && plan.ritmo.textIn==='rise')
      ? `'34*pow(1-min(max(t-${st.toFixed(2)}\\,0)/0.45\\,1)\\,2)'` : '0';
    fc.push(`${prev}[o${i}]overlay=x=0:y=${rise}:enable='between(t,${st.toFixed(2)},${en.toFixed(2)})'[v${i}]`);
    prev = `[v${i}]`;
  });
  execFileSync('ffmpeg', ['-y','-loglevel','error','-i', baseMp4, ...inputs,
    '-filter_complex', fc.join(';'), '-map', prev,
    '-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-preset','fast',
    '-movflags','+faststart','-an','-r', String(fps), out], { stdio:'inherit' });
}

// ── orquestrador ─────────────────────────────────────────────────────
// clipes: [{ n, src }] com paths LOCAIS (o server baixa do Drive antes)
async function renderReelVideo({ clipes, roteiro, C, estiloSlug, handle, fontCss, out,
                                 chromium, executablePath, browser, workDir, log }){
  log = log || (()=>{});
  const wd = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'reelv2-'));
  // 1) probe
  const comMeta = clipes.map(c=>{ const m = probeClip(c.src); return { ...c, ...m }; });
  log('probe: ' + comMeta.map(c=>`clipe${c.n} ${c.w}x${c.h} ${c.dur.toFixed(1)}s rot${c.rotation}`).join(' | '));
  // 2) plano
  const plan = montarPlanoVideo({ clipes: comMeta, roteiro, estiloSlug });
  plan.cartao.handle = handle || '';
  log(`plano: ${plan.segmentos.length} segs + cartão · total ${plan.total}s · ${plan.ritmo.trans}/${plan.ritmo.textIn}`);
  plan._porque.avisos.forEach(a=>log('aviso: '+a));
  // 3) normalização segmento a segmento
  const segFiles = plan.segmentos.map((s,i)=>{
    const f = path.join(wd, `seg${String(i).padStart(2,'0')}.mp4`);
    normalizarSegmento(s, f, plan.fps);
    return f;
  });
  log('segmentos normalizados: '+segFiles.length);
  // 4) overlays + cartão
  const ov = await gerarOverlays({ plan, C, fontCss, workDir:wd, chromium, executablePath, browser });
  const cardSeg = path.join(wd, 'segcard.mp4');
  execFileSync('ffmpeg', ['-y','-loglevel','error','-loop','1','-t', String(plan.cartao.dur),
    '-i', ov.card, '-vf', `fps=${plan.fps},setsar=1,format=yuv420p`,
    '-an','-c:v','libx264','-crf','17','-preset','veryfast', cardSeg], { stdio:'inherit' });
  log('overlays + cartão prontos');
  // 5) montagem final
  montarFinal({ plan, segFiles, cardSeg, ovFiles:ov.legendas, out, workDir:wd, fps:plan.fps });
  log('mp4 final: '+out);
  return { plan, out, workDir:wd };
}

module.exports = { renderReelVideo, probeClip, buildOverlaysHTML, montarPlanoVideo, FALLBACK, slugEstilo };
