// ═══════════════════════════════════════════════════════════════════
// POSTÔ · SERVIÇO DE RENDER — v2.0
// Três endpoints que o n8n chama:
//   POST /render            → reel de FOTOS (motor_reel) → .mp4 1080×1920
//   POST /render-video-reel → reel de VÍDEOS do cliente (motor_reel_video)
//   POST /pdf               → HTML da Edição → PDF
//
// /render-video-reel  header: x-api-token: <RENDER_TOKEN>
//   body JSON: {
//     clipes: ["https://...", ...]  ou  [{ n, url }, ...],   // vídeos do cliente (Drive)
//     roteiro: { kicker, hook, hookHi, beats:[{texto,hi}], cta:{titulo}, ctaHi },
//     C: { bg, text, accent, tFont, bFont, escuro },          // cores do CLIENTE (Ag2)
//     estiloSlug, handle
//   }
//   resposta: video/mp4 (binário). ?format=base64 → JSON {ok, duration, avisos, mp4_base64}
//   ÁUDIO: mudo por definição (o cliente adiciona o áudio em alta no app).
//
// GET /health → { ok:true }
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { buildReelStage } = require('./motor_reel');
const { renderReelVideo } = require('./motor_reel_video');
const { fontCss } = require('./fonts');

const PORT  = process.env.PORT || 8080;
const TOKEN = process.env.RENDER_TOKEN || '';
const MAX_FRAMES = 1400;            // trava do reel de fotos (~46s a 30fps)
const MAX_CLIPES = 12;              // trava do reel de vídeos
const MAX_CLIPE_MB = 120;           // por clipe baixado
const CHROME = process.env.CHROME_PATH || undefined;

const app = express();
app.use(express.json({ limit: '8mb' }));

let browser = null;
async function getBrowser(){
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox','--disable-dev-shm-usage','--force-color-profile=srgb'] });
  return browser;
}

// baixa cada mídia e embute como data URI (reel de fotos)
async function midiaDataURI(url){
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    let mime = (r.headers.get('content-type') || '').split(';')[0];
    if (!/^image\//.test(mime)) mime = 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e){ return ''; }
}

// baixa um CLIPE direto para o disco (nunca o vídeo inteiro em memória)
async function baixarClipe(url, destino){
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error('falha ao baixar clipe ('+r.status+'): '+url.slice(0,80));
  const len = parseInt(r.headers.get('content-length')||'0',10);
  if (len && len > MAX_CLIPE_MB*1024*1024) throw new Error('clipe acima de '+MAX_CLIPE_MB+'MB');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(destino));
  const st = fs.statSync(destino);
  if (!st.size) throw new Error('clipe vazio: '+url.slice(0,80));
  if (st.size > MAX_CLIPE_MB*1024*1024){ fs.rmSync(destino); throw new Error('clipe acima de '+MAX_CLIPE_MB+'MB'); }
  return destino;
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'posto-reel-render', version: '2.0' }));

// ─── REEL DE FOTOS (v1, intacto) ─────────────────────────────────────
app.post('/render', async (req, res) => {
  if (TOKEN && req.get('x-api-token') !== TOKEN) return res.status(401).json({ ok:false, error:'token inválido' });

  const body = req.body || {};
  const tela = body.tela || {};
  const C = body.C || {};
  const estiloSlug = body.estiloSlug || 'sereno';
  const handle = body.handle || '';
  const fps = Math.min(Math.max(parseInt(body.fps || 30, 10), 12), 60);

  let work = '';
  try {
    const urls = Array.isArray(body.media) ? body.media : [];
    const media = (await Promise.all(urls.map(midiaDataURI))).filter(Boolean);

    const html = buildReelStage({ tela, media, C, estiloSlug, handle, fontCss });

    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width:1080, height:1920 }, deviceScaleFactor:1 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const total = await page.evaluate(() => window.__TOTAL__);
    const frames = Math.min(Math.round(total * fps), MAX_FRAMES);

    work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
    for (let i = 0; i < frames; i++){
      await page.evaluate(t => window.seek(t), i / fps);
      await page.screenshot({ path: path.join(work, `f${String(i).padStart(5,'0')}.jpg`), type:'jpeg', quality:90 });
    }
    await page.close();

    const out = path.join(work, 'reel.mp4');
    execFileSync('ffmpeg', ['-y','-loglevel','error','-framerate', String(fps),
      '-i', path.join(work, 'f%05d.jpg'),
      '-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-preset','medium','-movflags','+faststart', out],
      { stdio:'ignore' });

    const mp4 = fs.readFileSync(out);
    if (req.query.format === 'base64'){
      res.json({ ok:true, duration: total, frames, mp4_base64: mp4.toString('base64') });
    } else {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline; filename="reel.mp4"');
      res.send(mp4);
    }
  } catch (err){
    res.status(500).json({ ok:false, error: String(err && err.message || err) });
  } finally {
    if (work) { try { fs.rmSync(work, { recursive:true, force:true }); } catch(e){} }
  }
});

// ─── REEL DE VÍDEOS DO CLIENTE (v2) ──────────────────────────────────
// Clipes → plano determinístico → segmentos normalizados 1080×1920 →
// overlays na marca do cliente → .mp4 mudo, H.264 yuv420p faststart.
// ─── Reel de VÍDEO do cliente (Motor v2) ─────────────────────────────
// O proxy do Render/Cloudflare corta requisições em ~100s, e este render
// leva mais que isso. Por isso existe o modo assíncrono (padrão job):
//   POST /render-video-reel?mode=async      → { ok, job_id }  (responde na hora)
//   GET  /render-video-reel/status/:id      → { status: processing|done|error }
//   GET  /render-video-reel/result/:id      → o .mp4 (e limpa o job)
// O modo síncrono original continua existindo para clipes curtos.

const RV_JOBS = new Map(); // job_id → { status, error, file, work, duration, avisos, criado }

async function executarReelVideo(body){
  const roteiro = body.roteiro || {};
  const C = body.C || {};
  const estiloSlug = body.estiloSlug || 'sereno';
  const handle = body.handle || '';
  const brutos = Array.isArray(body.clipes) ? body.clipes.slice(0, MAX_CLIPES) : [];
  if (!brutos.length) throw new Error('envie clipes (urls dos vídeos do cliente)');
  if (!String(roteiro.hook||'').trim()) throw new Error('roteiro sem hook');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reelv2-'));
  try {
    // 1) baixa os clipes para o disco (um a um, streaming)
    const clipes = [];
    for (let i = 0; i < brutos.length; i++){
      const item = brutos[i];
      const url = typeof item === 'string' ? item : (item && item.url);
      if (!url) continue;
      const destino = path.join(work, `clipe${String(i+1).padStart(2,'0')}.mp4`);
      try {
        await baixarClipe(url, destino);
        clipes.push({ n: (item && item.n) != null ? item.n : i+1, src: destino });
      } catch (e){
        console.log('clipe ignorado:', String(e.message||e));   // degradação graciosa
      }
    }
    if (!clipes.length) throw new Error('nenhum clipe pôde ser baixado');

    // 2) motor (usa o browser persistente do serviço para os overlays)
    const b = await getBrowser();
    const out = path.join(work, 'reel_video.mp4');
    const avisosLog = [];
    const r = await renderReelVideo({
      clipes, roteiro, C, estiloSlug, handle, fontCss,
      out, browser: b, workDir: work,
      log: m => { avisosLog.push(m); console.log('[video-reel]', m); },
    });
    return { out, work, duration: r.plan.total, segmentos: r.plan.segmentos.length, avisos: r.plan._porque.avisos };
  } catch (err){
    try { fs.rmSync(work, { recursive:true, force:true }); } catch(e){}
    throw err;
  }
}

app.post('/render-video-reel', async (req, res) => {
  if (TOKEN && req.get('x-api-token') !== TOKEN) return res.status(401).json({ ok:false, error:'token inválido' });
  const body = req.body || {};

  // ── modo assíncrono: responde o ticket na hora, renderiza em segundo plano ──
  if (req.query.mode === 'async'){
    const job_id = 'rv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    RV_JOBS.set(job_id, { status:'processing', criado: Date.now() });
    executarReelVideo(body)
      .then(r => RV_JOBS.set(job_id, { status:'done', file:r.out, work:r.work, duration:r.duration, avisos:r.avisos, criado: Date.now() }))
      .catch(e => RV_JOBS.set(job_id, { status:'error', error:String(e && e.message || e), criado: Date.now() }));
    return res.json({ ok:true, job_id });
  }

  // ── modo síncrono (comportamento original; use só para clipes curtos) ──
  try {
    const r = await executarReelVideo(body);
    const mp4 = fs.readFileSync(r.out);
    try { fs.rmSync(r.work, { recursive:true, force:true }); } catch(e){}
    if (req.query.format === 'base64'){
      res.json({ ok:true, duration:r.duration, segmentos:r.segmentos, avisos:r.avisos, mp4_base64: mp4.toString('base64') });
    } else {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline; filename="reel_video.mp4"');
      res.send(mp4);
    }
  } catch (err){
    const msg = String(err && err.message || err);
    const code = /envie clipes|roteiro sem hook|nenhum clipe/.test(msg) ? 400 : 500;
    res.status(code).json({ ok:false, error: msg });
  }
});

app.get('/render-video-reel/status/:id', (req, res) => {
  if (TOKEN && req.get('x-api-token') !== TOKEN) return res.status(401).json({ ok:false, error:'token inválido' });
  const j = RV_JOBS.get(req.params.id);
  if (!j) return res.status(404).json({ ok:false, status:'desconhecido', error:'job não encontrado (o serviço pode ter reiniciado; peça o render de novo)' });
  res.json({ ok:true, status:j.status, error:j.error || null, duration:j.duration || null, avisos:j.avisos || [] });
});

app.get('/render-video-reel/result/:id', (req, res) => {
  if (TOKEN && req.get('x-api-token') !== TOKEN) return res.status(401).json({ ok:false, error:'token inválido' });
  const j = RV_JOBS.get(req.params.id);
  if (!j || j.status !== 'done' || !j.file) return res.status(404).json({ ok:false, error:'resultado indisponível' });
  let mp4;
  try { mp4 = fs.readFileSync(j.file); } catch(e){ return res.status(404).json({ ok:false, error:'arquivo do job não existe mais' }); }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'inline; filename="reel_video.mp4"');
  res.send(mp4);
  try { fs.rmSync(j.work, { recursive:true, force:true }); } catch(e){}
  RV_JOBS.delete(req.params.id);
});

// ─── PDF da Edição (v1, intacto) ─────────────────────────────────────
app.post('/pdf', async (req, res) => {
  if (TOKEN && req.get('x-api-token') !== TOKEN) return res.status(401).json({ ok:false, error:'token inválido' });

  const body = req.body || {};
  const html = String(body.html || '');
  const url  = String(body.url || '');
  const format = body.format || 'A4';
  if (!html && !url) return res.status(400).json({ ok:false, error:'envie html ou url' });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    if (url){
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } else {
      await page.setContent(html, { waitUntil: 'networkidle' });
    }
    await page.waitForTimeout(400);

    const pdf = await page.pdf({
      printBackground: true,
      format: format,
      preferCSSPageSize: false,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' }
    });
    await page.close(); page = null;

    if (req.query.format === 'base64'){
      res.json({ ok:true, pdf_base64: Buffer.from(pdf).toString('base64') });
    } else {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="edicao.pdf"');
      res.send(pdf);
    }
  } catch (err){
    res.status(500).json({ ok:false, error: String(err && err.message || err) });
  } finally {
    if (page) { try { await page.close(); } catch(e){} }
  }
});

const server = // ─── PNG de cada arte ───────────────────────────────────────
// Recebe o HTML+CSS de UMA arte (Motor de Design) e devolve o PNG.
// Mesmo Chromium/Playwright dos reels e do PDF — sem cota, ilimitado.
// As fontes de cada um dos 11 estilos entram pelo <link> do Google Fonts
// que JÁ vem embutido no HTML da arte; o container tem internet, então
// a tipografia de cada estilo renderiza corretamente.
//   body JSON: { html, css, width, height, device_scale }
//   ?format=base64 → JSON { ok, png_base64, width, height, scale }
//   sem ?format   → image/png (binário)
app.post('/png', async (req, res) => {
  if (TOKEN && req.get('x-api-token') !== TOKEN) return res.status(401).json({ ok:false, error:'token inv\u00e1lido' });

  const body = req.body || {};
  const html   = String(body.html || '');
  const css    = String(body.css || '');
  const width  = Math.max(parseInt(body.width  || body.viewport_width  || 1080, 10), 1);
  const height = Math.max(parseInt(body.height || body.viewport_height || 1350, 10), 1);
  const scale  = Math.min(Math.max(parseInt(body.device_scale || 2, 10), 1), 3);
  if (!html) return res.status(400).json({ ok:false, error:'envie html' });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle' });
    if (css) { try { await page.addStyleTag({ content: css }); } catch (e) {} }
    // garante que as webfonts do estilo carregaram antes de fotografar
    try { await page.evaluate(() => (document.fonts && document.fonts.ready) || true); } catch (e) {}
    await page.waitForTimeout(500);

    const png = await page.screenshot({ type: 'png', clip: { x:0, y:0, width, height } });
    await page.close(); page = null;

    if (req.query.format === 'base64'){
      res.json({ ok:true, png_base64: Buffer.from(png).toString('base64'), width, height, scale });
    } else {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'inline; filename="arte.png"');
      res.send(png);
    }
  } catch (err){
    res.status(500).json({ ok:false, error: String(err && err.message || err) });
  } finally {
    if (page) { try { await page.close(); } catch(e){} }
  }
});

app.listen(PORT, () => console.log('POSTÔ reel-render v2 na porta ' + PORT));
// renders longos: o Node nunca derruba a request por conta própria
server.requestTimeout   = 0;         // sem teto interno de request
server.keepAliveTimeout = 620000;    // recomendação Render p/ Node
server.headersTimeout   = 630000;
