// ═══════════════════════════════════════════════════════════════════════
// POSTÔ · MONTAR REEL VÍDEO — plano determinístico (irmão do montar_reel_plan)
//
// Entra: clipes do cliente (com metadados do ffprobe) + roteiro (hook,
// beats, cta) + estilo. A IA escreve o roteiro; a MONTAGEM é determinística:
//   • RITMO: hook 1.2–1.8s, 4–7 segmentos de 1.5–3.0s, total 15–30s
//     (o caráter de movimento do estilo dita a velocidade: cut = rápido)
//   • QUAL clipe em cada segmento (vertical primeiro, mais longo primeiro;
//     reuso só quando faltam clipes — e com offset diferente a cada uso)
//   • ONDE cortar dentro do clipe (janela útil, fora das bordas trêmulas)
//   • COMO enquadrar no 9:16 (crop central; se o corte destruir o
//     enquadramento — retém <42% da largura — fallback blur-pad)
// Nunca falha: degrada com o que existe e registra o porquê em _porque.
// ═══════════════════════════════════════════════════════════════════════

// Caráter de movimento por estilo (idêntico ao motor_reel — fonte canônica)
const MOTION = {
  "bold":        { dur:2.6, trans:'cut',  textIn:'snap', upper:true },
  "noir-tech":   { dur:2.7, trans:'cut',  textIn:'snap' },
  "solar":       { dur:2.8, trans:'cut',  textIn:'snap', upper:true },
  "arquitetura": { dur:3.0, trans:'fade', textIn:'snap', upper:true },
  "clinico":     { dur:3.0, trans:'fade', textIn:'rise' },
  "magazine":    { dur:3.4, trans:'fade', textIn:'rise' },
  "sereno":      { dur:3.3, trans:'fade', textIn:'rise' },
  "botanico":    { dur:3.2, trans:'fade', textIn:'rise' },
  "romantico":   { dur:3.5, trans:'fade', textIn:'rise' },
  "inspirador":  { dur:3.1, trans:'fade', textIn:'rise' },
  "posto":       { dur:3.2, trans:'fade', textIn:'rise' },
};

function slugEstilo(s){
  return String(s||'sereno').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z]/g,'').replace('postoexclusivo','posto').replace('noirtech','noir-tech');
}
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const r2 = x => Math.round(x*100)/100;

// margem que descartamos nas pontas do clipe (começo/fim costumam tremer)
const BORDA = 0.30;
// abaixo disto de janela útil, o clipe não serve nem para o hook
const MIN_UTIL = 1.2;
// crop central que retém menos que isto da largura destrói o enquadramento
const LIMIAR_CROP = 0.42;

// aplica a rotação do metadado: 90/270 trocam w/h
function dimensoesReais(c){
  const rot = Math.abs(Number(c.rotation||0)) % 180;
  return rot === 90 ? { w:c.h, h:c.w } : { w:c.w, h:c.h };
}

// crop central 9:16 ou blur-pad, decidido pela fração retida
function modoEnquadre(c){
  const { w, h } = dimensoesReais(c);
  const alvo = 9/16;
  const ar = w/h;
  if (ar <= alvo + 0.001) return { modo:'crop', retem:1 };      // vertical: cobre
  const retem = (h*alvo)/w;                                      // fração da largura que sobra
  return retem < LIMIAR_CROP ? { modo:'blurpad', retem:r2(retem) }
                             : { modo:'crop',    retem:r2(retem) };
}

function montarPlanoVideo({ clipes, roteiro, estiloSlug }){
  const slug = slugEstilo(estiloSlug);
  const M = MOTION[slug] || MOTION['sereno'];
  const avisos = [];

  // ── 1) pool de clipes utilizáveis ────────────────────────────────────
  const pool = (clipes||[]).map((c,i)=>{
    const dim = dimensoesReais(c);
    return {
      i, n: c.n!=null?c.n:i+1, src: c.src,
      dur: Number(c.dur)||0, w: dim.w, h: dim.h,
      vertical: dim.h > dim.w,
      util: Math.max(0, (Number(c.dur)||0) - 2*BORDA),
      usos: 0,
      enquadre: modoEnquadre(c),
    };
  }).filter(c=>{
    if (c.util >= MIN_UTIL) return true;
    avisos.push(`clipe ${c.n} descartado: janela útil ${r2(c.util)}s < ${MIN_UTIL}s`);
    return false;
  });
  if (!pool.length) throw new Error('nenhum clipe utilizável (todos abaixo de '+MIN_UTIL+'s de janela útil)');

  // ── 2) ritmo pelo caráter do estilo ──────────────────────────────────
  let hookDur = clamp(M.dur*0.50, 1.2, 1.8);
  let beatDur = clamp(M.dur*0.78, 1.5, 3.0);
  const CARD_DUR = 2.4;

  const beats = (roteiro.beats||[]).filter(b=>b && String(b.texto||'').trim());
  let nBeats = Math.min(beats.length, 7);
  if (nBeats < 4) avisos.push(`roteiro tem só ${nBeats} beats (ideal 4–7); plano segue com o que existe`);
  const beatsUsados = beats.slice(0, nBeats);

  // total alvo 15–30s: estica/encolhe beatDur deterministicamente se preciso
  const totalCom = d => hookDur + nBeats*d + CARD_DUR;
  if (totalCom(beatDur) < 15) beatDur = clamp((15 - hookDur - CARD_DUR)/Math.max(nBeats,1), beatDur, 3.0);
  if (totalCom(beatDur) > 30) beatDur = clamp((30 - hookDur - CARD_DUR)/nBeats, 1.5, beatDur);
  hookDur = r2(hookDur); beatDur = r2(beatDur);

  // ── 3) seleção de clipe por segmento ─────────────────────────────────
  // ordem de preferência: vertical primeiro, depois mais longo (mais janela)
  const ordem = [...pool].sort((a,b)=> (b.vertical-a.vertical) || (b.util-a.util));

  // FASE 1 — atribuição de clipe + duração base (offsets só no fim)
  function atribuir(c, durDesejada){
    const dur = r2(Math.min(durDesejada, c.util));              // clipe curto encolhe o segmento
    c.usos++;
    return { clipe:c, clipeN:c.n, src:c.src, dur,
             modo:c.enquadre.modo, retem:c.enquadre.retem, w:c.w, h:c.h };
  }

  const segmentos = [];
  const hookClip = ordem[0];                                    // melhor clipe (vertical + longo)
  segmentos.push({ idx:0, tipo:'hook', ...atribuir(hookClip, hookDur),
    legenda:{ kicker:roteiro.kicker||'', texto:roteiro.hook||'', hi:roteiro.hookHi||'' } });

  // beats: começa do 2º da ordem para não repetir o hook logo em seguida
  let cursor = ordem.length > 1 ? 1 : 0;
  beatsUsados.forEach((b, k)=>{
    let c = null;
    for (let t=0; t<ordem.length; t++){
      const cand = ordem[(cursor+t)%ordem.length];
      if (cand.usos===0){ c=cand; cursor=(cursor+t+1)%ordem.length; break; }
    }
    if (!c){
      c = [...ordem].sort((a,b2)=>a.usos-b2.usos || b2.util-a.util)[0];
      cursor = (ordem.indexOf(c)+1)%ordem.length;
    }
    segmentos.push({ idx:k+1, tipo:'beat', ...atribuir(c, beatDur),
      legenda:{ texto:b.texto, hi:b.hi||'' } });
  });

  if (pool.length < segmentos.length)
    avisos.push(`${pool.length} clipes para ${segmentos.length} segmentos: houve reuso com offsets diferentes`);

  // FASE 2 — esticamento: se clipes curtos derrubaram o total abaixo de 15s,
  // redistribui a diferença entre segmentos com folga (limite 3.0s / hook 1.8s)
  const somaSegs = () => segmentos.reduce((a,s)=>a+s.dur, 0);
  let deficit = r2(15 - (somaSegs() + CARD_DUR));
  // tier 1: cresce sem sobrepor fatias do mesmo clipe; tier 2: permite sobreposição
  for (const permiteSobrepor of [false, true]){
    for (let rodada=0; rodada<8 && deficit>0.01; rodada++){
      const comFolga = segmentos.filter(s=>{
        const teto  = s.tipo==='hook' ? 1.8 : 3.0;
        const fatia = permiteSobrepor ? s.clipe.util : s.clipe.util / s.clipe.usos;
        return s.dur < Math.min(teto, fatia) - 0.01;
      });
      if (!comFolga.length) break;
      const passo = Math.max(0.05, r2(deficit / comFolga.length));
      comFolga.forEach(s=>{
        if (deficit <= 0.01) return;
        const teto  = s.tipo==='hook' ? 1.8 : 3.0;
        const fatia = permiteSobrepor ? s.clipe.util : s.clipe.util / s.clipe.usos;
        const novo  = r2(Math.min(s.dur + passo, teto, fatia));
        deficit = r2(deficit - (novo - s.dur));
        s.dur = novo;
      });
    }
    if (deficit <= 0.01) break;
    if (permiteSobrepor && deficit > 0.01)
      avisos.push(`clipes curtos: total ficou ${r2(somaSegs()+CARD_DUR)}s (<15s). Regra do briefing: 5–8 clipes de 5s+`);
    else if (!permiteSobrepor && deficit > 0.01)
      avisos.push('material curto: houve sobreposição parcial de trechos reusados para chegar aos 15s');
  }

  // FASE 3 — offsets dentro de cada clipe (com as durações finais)
  const usoAtual = new Map();
  segmentos.forEach(s=>{
    const c = s.clipe;
    const uso = usoAtual.get(c.n) || 0;
    usoAtual.set(c.n, uso+1);
    const folga = Math.max(0, c.util - s.dur);
    if (c.usos === 1)      s.in = r2(BORDA + folga*0.35);       // uso único: antes do meio
    else {                                                       // multiusos: fatias sequenciais
      const fatia = c.util / c.usos;
      const dentro = Math.max(0, fatia - s.dur);
      s.in = r2(BORDA + uso*fatia + dentro*0.5);
    }
    // trava dura: nunca passar da janela útil
    s.in = r2(Math.min(s.in, BORDA + Math.max(0, c.util - s.dur)));
    delete s.clipe;
  });

  // ── 4) timeline ──────────────────────────────────────────────────────
  let acc = 0;
  segmentos.forEach(s=>{ s.start = r2(acc); acc = r2(acc + s.dur); });
  const cartao = { start:r2(acc), dur:CARD_DUR,
                   titulo:(roteiro.cta&&roteiro.cta.titulo)||roteiro.cta||'',
                   hi:roteiro.ctaHi||'', };
  const total = r2(acc + CARD_DUR);

  return {
    estilo: slug, fps: 30, total,
    ritmo: { hookDur, beatDur, trans:M.trans, textIn:M.textIn, upper:!!M.upper },
    segmentos, cartao,
    _porque: {
      clipes_uteis: pool.map(c=>({ n:c.n, dur:c.dur, dim:`${c.w}x${c.h}`, vertical:c.vertical,
                                   enquadre:c.enquadre.modo, retem:c.enquadre.retem, usos:c.usos })),
      avisos,
    },
  };
}

module.exports = { montarPlanoVideo, slugEstilo, MOTION };
