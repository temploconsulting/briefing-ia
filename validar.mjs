#!/usr/bin/env node
// validar.mjs — puerta determinista. Si esto no pasa, no hay commit.
//
//   node validar.mjs briefings/2026-09-04.html
//   node validar.mjs --ultimo
//
// Codigo de salida:  0 = publicable   ·   2 = bloqueado
//
// El briefing debe marcar cada item para que esto sea comprobable:
//   <article class="item" data-id="a1b2c3d4e5f6" data-fecha="2026-09-04"> ... </article>
// y cada termino de glosario:
//   <dt data-termino="routing-de-modelos">Routing de modelos</dt>

import { readFile, readdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const VENTANA_DIAS = 7;
const SECCIONES_OBLIGATORIAS = ['titular', 'items', 'cobertura'];

const fallos = [];
const avisos = [];
const fallo = (m) => fallos.push(m);
const aviso = (m) => avisos.push(m);

async function leerJSON(ruta, pordefecto) {
  try { return JSON.parse(await readFile(ruta, 'utf8')); } catch { return pordefecto; }
}

// --- localizar el briefing ---
let ruta = process.argv[2];
if (!ruta || ruta === '--ultimo') {
  const ficheros = (await readdir('briefings').catch(() => []))
    .filter((f) => f.endsWith('.html')).sort();
  if (!ficheros.length) { console.error('BLOQUEADO: no hay ningun briefing en briefings/'); process.exit(2); }
  ruta = `briefings/${ficheros.at(-1)}`;
}
if (!existsSync(ruta)) { console.error(`BLOQUEADO: no existe ${ruta}`); process.exit(2); }

const html = await readFile(ruta, 'utf8');
const fechaBriefing = ruta.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);

const estado = await leerJSON('estado/estado.json', { historias: [] });
const glosario = await leerJSON('estado/glosario.json', { terminos: [] });

// --- corpus de la VENTANA: unica fuente valida de URLs ---
// No solo el de esta noche. En modo vigilancia los candidatos se acumulan durante
// seis dias: su URL esta en el corpus del dia en que se leyo, y para el lunes la
// mayoria de feeds ya no la listan. Leer un solo dia tiraba la semana entera.
const diasVentana = [...Array(VENTANA_DIAS + 1).keys()].map((i) =>
  new Date(Date.parse(fechaBriefing + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10));

let corpus = [];
let diasConCorpus = 0;
for (const dia of diasVentana) {
  try {
    corpus.push(...(await readFile(`estado/corpus/${dia}.jsonl`, 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    diasConCorpus++;
  } catch { /* un dia sin corpus no es un fallo: esa noche pudo no ejecutarse */ }
}
if (!diasConCorpus) {
  fallo(`no hay ningun corpus en los ultimos ${VENTANA_DIAS} dias — no se puede verificar ninguna URL`);
} else if (diasConCorpus < 3) {
  aviso(`solo ${diasConCorpus} dia(s) de corpus en la ventana: la vigilancia no esta corriendo`);
}
const urlsCorpus = new Set(corpus.flatMap((c) => [c.url, c.url_original].filter(Boolean).map((u) => u.toLowerCase())));
const dominiosCorpus = new Set([...urlsCorpus].map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean));

// ============ 1 · items: id y fecha visible dentro de ventana ============
const items = html.match(/<article[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>/gi) || [];
if (!items.length) aviso('el briefing no tiene ningun item (dia de cero items: valido si es deliberado)');

const limite = new Date(new Date(fechaBriefing).getTime() - VENTANA_DIAS * 864e5);
const idsPublicados = [];

for (const [i, tag] of items.entries()) {
  const id = tag.match(/data-id=["']([^"']+)["']/i)?.[1];
  const fecha = tag.match(/data-fecha=["']([^"']+)["']/i)?.[1];
  if (!id) { fallo(`item ${i + 1}: falta data-id`); continue; }
  idsPublicados.push(id);
  if (!fecha) { fallo(`item ${i + 1} (${id}): falta data-fecha`); continue; }
  const d = new Date(fecha);
  if (isNaN(d)) { fallo(`item ${i + 1} (${id}): data-fecha "${fecha}" no es una fecha valida`); continue; }
  if (d < limite) fallo(`item ${i + 1} (${id}): fecha ${fecha} fuera de la ventana de ${VENTANA_DIAS} dias`);
  if (d > new Date(fechaBriefing + 'T23:59:59Z')) fallo(`item ${i + 1} (${id}): fecha ${fecha} en el futuro`);
}

// ============ 2 · toda URL publicada tiene que venir del corpus Y de un dominio permitido ============
// Doble condicion deliberada. La regla del corpus impide URLs inventadas; la lista blanca
// impide que una URL plantada por un tercero en un feed acabe publicada solo por estar "leida".
let permitidos = new Set();
try {
  permitidos = new Set((await readFile('dominios.txt', 'utf8'))
    .split('\n').map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')));
} catch { fallo('falta dominios.txt: no se puede verificar ninguna URL'); }

const enListaBlanca = (host) => permitidos.has(host) || [...permitidos].some((d) => host.endsWith('.' + d));

const propias = /(^|\.)(temploconsulting\.com|github\.io)$/i;
for (const url of new Set((html.match(/(?:href|src)=["'](https?:\/\/[^"']+)["']/gi) || [])
  .map((h) => h.match(/(?:href|src)=["'](https?:\/\/[^"']+)["']/i)[1]))) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { fallo(`URL malformada: ${url}`); continue; }
  if (propias.test(host)) continue;
  if (!enListaBlanca(host)) { fallo(`dominio fuera de dominios.txt: ${host} (${url})`); continue; }
  if (urlsCorpus.has(url.toLowerCase())) continue;
  // Esto era un aviso cuando el dominio se habia leido esa noche, y un aviso no bloquea.
  // Era el agujero exacto del briefing piloto: una URL inventada de un dominio conocido
  // pasaba el validador. Ahora bloquea siempre; el dominio leido solo mejora el mensaje.
  fallo(dominiosCorpus.has(host)
    ? `URL no presente en el corpus (${host} si se leyo, esta URL no: probable invencion): ${url}`
    : `URL no presente en el corpus de la ventana: ${url}`);
}

// ============ 2b · nada ejecutable en la pagina ============
// El renderizador ya escapa, pero esto es la segunda linea: si algun dia alguien
// genera HTML a mano o el renderizador cambia, esto lo detiene igual.
// El <style> de la plantilla es legitimo; lo excluimos antes de buscar.
const sinEstilo = html.replace(/<style[\s\S]*?<\/style>/gi, '');

// Etiquetas prohibidas. Solo casan si son etiquetas REALES: el texto escapado
// llega como &lt;script&gt; y no coincide, que es justo lo que queremos.
for (const [re, nombre] of [
  [/<script[\s>]/i, '<script>'], [/<iframe[\s>]/i, '<iframe>'],
  [/<object[\s>]/i, '<object>'], [/<embed[\s>]/i, '<embed>'],
  [/<form[\s>]/i, '<form>'], [/<link[^>]+rel=["']?import/i, 'HTML import'],
]) {
  if (re.test(sinEstilo)) fallo(`el briefing contiene ${nombre}: el renderizador deberia haberlo escapado`);
}

// Manejadores de evento y protocolos peligrosos: hay que mirarlos DENTRO de etiquetas
// reales. Buscarlos en el documento entero da falsos positivos, porque un titular
// citado que mencione onerror= sale escapado y es texto inofensivo.
for (const tag of sinEstilo.match(/<[a-z][^>]*>/gi) || []) {
  if (/\son[a-z]+\s*=/i.test(tag)) fallo(`manejador de evento en una etiqueta real: ${tag.slice(0, 80)}`);
  if (/javascript:/i.test(tag)) fallo(`protocolo javascript: en una etiqueta real: ${tag.slice(0, 80)}`);
  if (/data:text\/html/i.test(tag)) fallo(`data:text/html en una etiqueta real: ${tag.slice(0, 80)}`);
}

// ============ 3 · nada marcado como repetido ============
const repetidos = new Set((estado.historias || []).filter((h) => h.estado === 'repetido').map((h) => h.id));
for (const id of idsPublicados) if (repetidos.has(id)) fallo(`item ${id} esta marcado como "repetido" en estado.json`);

// ============ 4 · glosario sin repeticiones ============
const yaExplicados = new Set((glosario.terminos || []).map((t) => (t.slug || t.termino || t).toString().toLowerCase()));
for (const m of html.matchAll(/<dt[^>]*data-termino=["']([^"']+)["']/gi)) {
  const slug = m[1].toLowerCase();
  if (yaExplicados.has(slug)) fallo(`el termino "${slug}" ya estaba explicado en glosario.json`);
}

// ============ 5 · integridad del HTML ============
for (const t of ['html', 'head', 'body']) {
  if (new RegExp(`<${t}[\\s>]`, 'i').test(html) && !new RegExp(`</${t}>`, 'i').test(html)) fallo(`<${t}> sin cerrar`);
}
for (const t of ['div', 'article', 'section', 'dl', 'table']) {
  const abre = (html.match(new RegExp(`<${t}[\\s>]`, 'gi')) || []).length;
  const cierra = (html.match(new RegExp(`</${t}>`, 'gi')) || []).length;
  if (abre !== cierra) fallo(`etiquetas <${t}> descuadradas: ${abre} abren, ${cierra} cierran`);
}
if (!/<title>[^<]+<\/title>/i.test(html)) fallo('falta <title> con contenido');
for (const sec of SECCIONES_OBLIGATORIAS) {
  const bloque = html.match(new RegExp(`data-seccion=["']${sec}["'][^>]*>([\\s\\S]*?)<!--\\s*/${sec}\\s*-->`, 'i'));
  if (!bloque) { fallo(`falta la seccion obligatoria "${sec}" (marcala con data-seccion y cierra con <!-- /${sec} -->)`); continue; }
  if (bloque[1].replace(/<[^>]+>/g, '').trim().length < 40) fallo(`la seccion "${sec}" esta practicamente vacia`);
}
if (/lorem ipsum|TODO|FIXME|XXXX|\[pendiente\]/i.test(html)) fallo('el briefing contiene texto de relleno o marcadores sin resolver');

// ============ 6 · index.html apunta a algo que existe ============
if (!existsSync('index.html')) fallo('no existe index.html');
else {
  const index = await readFile('index.html', 'utf8');
  const enlaces = [...index.matchAll(/href=["'](briefings\/[^"']+\.html)["']/gi)].map((m) => m[1]);
  if (!enlaces.length) fallo('index.html no enlaza a ningun briefing');
  for (const e of new Set(enlaces)) {
    try { await access(e); } catch { fallo(`index.html enlaza a ${e}, que no existe`); }
  }
  if (!enlaces.includes(ruta)) fallo(`index.html no enlaza al briefing de hoy (${ruta})`);
}

// ============ 7 · latido de hoy ============
// Un solo nombre para este fichero: estado/latido.jsonl. Antes el codigo leia uno,
// el mensaje nombraba otro y en el repositorio habia un tercero, asi que este
// bloque fallaba siempre y no se publicaba nunca.
try {
  const latido = await readFile('estado/latido.jsonl', 'utf8');
  if (!latido.includes(fechaBriefing)) fallo(`estado/latido.jsonl no tiene ninguna linea de ${fechaBriefing}`);
} catch { fallo('no existe estado/latido.jsonl'); }

// ============ 8 · regla 13: nada del contexto interno se publica en bruto ============
// Estaba marcada [V] en AGENTE.md y no la comprobaba nadie. Comprueba que ninguna
// frase larga de contexto_negocio.json aparezca literal en el briefing.
const contexto = await leerJSON('contexto_negocio.json', null);
if (contexto) {
  // Comparar en crudo no sirve: en la pagina el texto ya paso por el escapado, asi que
  // una comilla se convirtio en &#39; y la frase deja de coincidir consigo misma. Se
  // normalizan los dos lados a minusculas, sin entidades y sin puntuacion.
  const norm = (s) => String(s).toLowerCase()
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, ' ')
    .replace(/[^a-z0-9áéíóúüñç ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const pagina = norm(html.replace(/<[^>]+>/g, ' '));
  const frases = [];
  (function recorre(v) {
    if (typeof v === 'string') { const n = norm(v); if (n.length >= 40) frases.push(n); }
    else if (Array.isArray(v)) v.forEach(recorre);
    else if (v && typeof v === 'object') Object.values(v).forEach(recorre);
  })(contexto);
  for (const f of new Set(frases)) {
    if (pagina.includes(f)) fallo(`frase literal de contexto_negocio.json en el briefing: "${f.slice(0, 70)}..."`);
  }
} else {
  aviso('no se pudo leer contexto_negocio.json: no se comprueba la fuga de contexto interno');
}

// ============ 9 · el markdown, que es lo que se entrega en Drive ============
// El HTML se queda en el repositorio; el .md es el que ve una persona. Validar
// solo el HTML dejaba sin revisar justo el fichero que se publica.
const rutaMd = ruta.replace(/\.html$/, '.md');
if (!existsSync(rutaMd)) fallo(`no existe ${rutaMd}: es el fichero que se entrega en Drive`);
else {
  const md = await readFile(rutaMd, 'utf8');
  const itemsMd = (md.match(/^### \d\d · /gm) || []).length;
  if (itemsMd !== items.length) fallo(`el markdown tiene ${itemsMd} items y el HTML ${items.length}: no son el mismo briefing`);
  for (const url of new Set((md.match(/\]\((https?:\/\/[^)]+)\)/g) || []).map((m) => m.slice(2, -1)))) {
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { fallo(`URL malformada en el markdown: ${url}`); continue; }
    if (propias.test(host)) continue;
    if (!enListaBlanca(host)) fallo(`markdown: dominio fuera de dominios.txt: ${host}`);
    else if (!urlsCorpus.has(url.toLowerCase())) fallo(`markdown: URL no presente en el corpus: ${url}`);
  }
}

// ============ salida ============
for (const a of avisos) console.log(`  aviso  ${a}`);
if (fallos.length) {
  console.error(`\nBLOQUEADO · ${fallos.length} fallo(s) en ${ruta}:\n`);
  for (const f of fallos) console.error(`  - ${f}`);
  console.error('\nCorrige y vuelve a ejecutar. No hagas commit hasta que esto salga limpio.');
  process.exit(2);
}
console.log(`OK · ${ruta} publicable · ${items.length} item(s) · ${avisos.length} aviso(s)`);
