// ═══════════════════════════════════════════════════════════════════
// POSTÔ · SERVIÇO DE RENDER DE REEL — v1
// Um endpoint que o n8n chama por cliente. Recebe o conteúdo + estilo +
// cores + fotos do cliente, monta o HTML (motor_reel), renderiza frame a
// frame com Playwright e devolve o .mp4 (1080×1920). As fontes dos 11
// estilos vêm empacotadas no container.
//
// POST /render   header: x-api-token: <RENDER_TOKEN>
//   body JSON:
//   {
//     "tela":  { "kicker","hook","hookHi","beats":[{"texto","hi"}],"cta","ctaHi" },
//     "media": ["https://.../foto1","https://.../foto2", ...],
//     "C":     { "bg","text","accent","tFont","bFont","escuro" },   // cores do cliente (Ag2)
//     "estiloSlug": "bold",         // 1 dos 11
//     "handle": "isley.pilates",
//     "fps": 30                      // opcional (default 30)
//   }
//   resposta: video/mp4 (binário). Com ?format=base64 → JSON {ok,mp4_base64,...}
//
// GET /health → { ok:true }
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { buildReelStage } = require('./motor_reel');
const { fontCss } = require('./fonts');

const PORT  = process.env.PORT || 8080;
const TOKEN = process.env.RENDER_TOKEN || '';
const MAX_FRAMES = 1400;          // trava de segurança (~46s a 30fps)
const CHROME = process.env.CHROME_PATH || undefined; // a imagem do Playwright resolve sozinho

const app = express();
app.use(express.json({ limit: '4mb' }));

let browser = null;
async function getBrowser(){
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox','--disable-dev-shm-usage','--force-color-profile=srgb'] });
  return browser;
}

// baixa cada mídia e embute como data URI (render não depende de rede externa)
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'posto-reel-render' }));

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
    // 1) mídia → data URIs
    const urls = Array.isArray(body.media) ? body.media : [];
    const media = (await Promise.all(urls.map(midiaDataURI))).filter(Boolean);

    // 2) HTML do motor
    const html = buildReelStage({ tela, media, C, estiloSlug, handle, fontCss });

    // 3) captura de frames
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

    // 4) ffmpeg → mp4
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

app.listen(PORT, () => console.log('POSTÔ reel-render na porta ' + PORT));
