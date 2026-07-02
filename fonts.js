// ═══════════════════════════════════════════════════════════════════
// POSTÔ · fonts.js v2 — bloco @font-face (base64) dos 11 estilos
//
// PRIORIDADE: TTFs COMPLETOS na pasta ./fonts do repo (google/fonts).
// Motivo: o subset latin do @fontsource tem o glifo "ê" quebrado em
// todos os pesos — inaceitável para texto em português.
// FALLBACK: se um TTF não estiver na pasta, cai no @fontsource antigo
// (o serviço nunca sobe sem fonte).
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const DIR = __dirname;                       // fontes na RAIZ do repo (mesmo nível do fonts.js)
const DIR_ALT = path.join(__dirname, 'fonts'); // fallback: subpasta fonts/
function ttf(fam, file, w, s){
  let b64 = '';
  try { b64 = fs.readFileSync(path.join(DIR, file)).toString('base64'); }
  catch (e){
    try { b64 = fs.readFileSync(path.join(DIR_ALT, file)).toString('base64'); }
    catch (e2){ return ''; }
  }
  return `@font-face{font-family:'${fam}';font-weight:${w};font-style:${s||'normal'};font-display:block;src:url(data:font/ttf;base64,${b64}) format('truetype')}`;
}

let FF = '';
try { FF = require.resolve('@fontsource/inter/package.json').replace(/inter\/package\.json$/, ''); } catch(e){}
function face(fam, w, s, file){
  try {
    const b64 = fs.readFileSync(FF + file).toString('base64');
    return `@font-face{font-family:'${fam}';font-weight:${w};font-style:${s};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  } catch (e){ return ''; }
}

// TTFs variáveis/estáticos completos (pasta ./fonts)
const ttfs = [
  ttf('Cormorant Garamond','CormorantGaramond.ttf','300 700'),
  ttf('Cormorant Garamond','CormorantGaramond-Italic.ttf','300 700','italic'),
  ttf('Inter','Inter.ttf','100 900'),
  ttf('Anton','Anton.ttf','400'),
  ttf('Lato','Lato-Regular.ttf','400'),
  ttf('Lato','Lato-Bold.ttf','700'),
  ttf('Karla','Karla.ttf','200 800'),
  ttf('DM Mono','DMMono-Regular.ttf','400'),
  ttf('DM Mono','DMMono-Medium.ttf','500'),
  ttf('Quicksand','Quicksand.ttf','300 700'),
  ttf('Space Grotesk','SpaceGrotesk.ttf','300 700'),
  ttf('DM Sans','DMSans.ttf','100 900'),
].filter(Boolean);

// famílias cobertas pelos TTFs não caem no fallback
const cobertas = new Set();
ttfs.forEach(f=>{ const m=f.match(/font-family:'([^']+)'/); if(m) cobertas.add(m[1]); });
const fb = (fam,w,s,file)=> cobertas.has(fam) ? '' : face(fam,w,s,file);

const fallback = [
  fb('Cormorant Garamond',600,'normal','cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2'),
  fb('Cormorant Garamond',600,'italic','cormorant-garamond/files/cormorant-garamond-latin-600-italic.woff2'),
  fb('Cormorant Garamond',500,'normal','cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2'),
  fb('Inter',700,'normal','inter/files/inter-latin-700-normal.woff2'),
  fb('Inter',800,'normal','inter/files/inter-latin-800-normal.woff2'),
  fb('Anton',400,'normal','anton/files/anton-latin-400-normal.woff2'),
  fb('Lato',700,'normal','lato/files/lato-latin-700-normal.woff2'),
  fb('Lato',400,'normal','lato/files/lato-latin-400-normal.woff2'),
  fb('Karla',700,'normal','karla/files/karla-latin-700-normal.woff2'),
  fb('Karla',400,'normal','karla/files/karla-latin-400-normal.woff2'),
  fb('DM Mono',500,'normal','dm-mono/files/dm-mono-latin-500-normal.woff2'),
  fb('DM Mono',400,'normal','dm-mono/files/dm-mono-latin-400-normal.woff2'),
  fb('Quicksand',700,'normal','quicksand/files/quicksand-latin-700-normal.woff2'),
  fb('Quicksand',500,'normal','quicksand/files/quicksand-latin-500-normal.woff2'),
  fb('Space Grotesk',700,'normal','space-grotesk/files/space-grotesk-latin-700-normal.woff2'),
  fb('Space Grotesk',500,'normal','space-grotesk/files/space-grotesk-latin-500-normal.woff2'),
  fb('DM Sans',600,'normal','dm-sans/files/dm-sans-latin-600-normal.woff2'),
].filter(Boolean);

const fontCss = [...ttfs, ...fallback].join('\n');
module.exports = { fontCss };
