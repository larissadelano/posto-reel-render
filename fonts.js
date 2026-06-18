// Monta o bloco @font-face (base64) com TODAS as fontes dos 11 estilos.
// As fontes vêm empacotadas no container (@fontsource), então o n8n não
// precisa enviar nada de fonte — só conteúdo, estilo, cores e mídia.
const fs = require('fs');
const FF = require.resolve('@fontsource/inter/package.json').replace(/inter\/package\.json$/, '');

function face(fam, w, s, file){
  try {
    const b64 = fs.readFileSync(FF + file).toString('base64');
    return `@font-face{font-family:'${fam}';font-weight:${w};font-style:${s};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  } catch (e){ return ''; }
}

const fontCss = [
  face('Cormorant Garamond',600,'normal','cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2'),
  face('Cormorant Garamond',600,'italic','cormorant-garamond/files/cormorant-garamond-latin-600-italic.woff2'),
  face('Cormorant Garamond',500,'normal','cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2'),
  face('Inter',700,'normal','inter/files/inter-latin-700-normal.woff2'),
  face('Inter',800,'normal','inter/files/inter-latin-800-normal.woff2'),
  face('Anton',400,'normal','anton/files/anton-latin-400-normal.woff2'),
  face('Lato',700,'normal','lato/files/lato-latin-700-normal.woff2'),
  face('Lato',400,'normal','lato/files/lato-latin-400-normal.woff2'),
  face('Karla',700,'normal','karla/files/karla-latin-700-normal.woff2'),
  face('Karla',400,'normal','karla/files/karla-latin-400-normal.woff2'),
  face('DM Mono',500,'normal','dm-mono/files/dm-mono-latin-500-normal.woff2'),
  face('DM Mono',400,'normal','dm-mono/files/dm-mono-latin-400-normal.woff2'),
  face('Quicksand',700,'normal','quicksand/files/quicksand-latin-700-normal.woff2'),
  face('Quicksand',500,'normal','quicksand/files/quicksand-latin-500-normal.woff2'),
  face('Space Grotesk',700,'normal','space-grotesk/files/space-grotesk-latin-700-normal.woff2'),
  face('Space Grotesk',500,'normal','space-grotesk/files/space-grotesk-latin-500-normal.woff2'),
  face('DM Sans',600,'normal','dm-sans/files/dm-sans-latin-600-normal.woff2'),
].filter(Boolean).join('\n');

module.exports = { fontCss };
