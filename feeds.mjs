#!/usr/bin/env node
// feeds.mjs — descarga las fuentes, normaliza y vuelca el corpus de la noche.
// Sin dependencias: solo Node 18+.
//
// Salidas:
//   estado/corpus/<fecha>.jsonl   una linea por item dentro de la ventana
//   estado/salud.json             estado de cada feed en esta ejecucion
// Codigo de salida:
//   0  ok
//   1  menos del 50% de los feeds respondieron (no se debe publicar briefing)

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const UA = 'Mozilla/5.0 (compatible; TemploBriefingBot/1.0; +https://github.com/temploconsulting/briefing-ia)';
const VENTANA_DIAS = 7;
const TIMEOUT_MS = 20000;
const REINTENTOS = 2;
const CONCURRENCIA = 8;

// Foco: que herramientas salen, quien las usa, que esta ganando adopcion, y como
// cambian los procesos de un profesional digital (programacion, marketing, publicidad, SEO).
// NO se cubre mercado inmobiliario ni normativa de Madrid: eso es de otro agente.
const FEEDS = [
  // --- laboratorios y fabricantes: que sale y que capacidades trae ---
  ['primaria', 'OpenAI',             'https://openai.com/news/rss.xml'],
  ['primaria', 'Google DeepMind',    'https://deepmind.google/blog/rss.xml'],
  ['primaria', 'Google AI',          'https://blog.google/technology/ai/rss/'],
  ['primaria', 'Hugging Face',       'https://huggingface.co/blog/feed.xml'],
  ['primaria', 'Mistral',            'https://mistral.ai/rss.xml'],
  ['primaria', 'GitHub AI',          'https://github.blog/ai-and-ml/feed/'],
  ['primaria', 'Microsoft AI',       'https://www.microsoft.com/en-us/ai/blog/feed/'],
  ['primaria', 'NVIDIA gen AI',      'https://blogs.nvidia.com/blog/tag/generative-ai/feed/'],
  ['primaria', 'AWS machine learning','https://aws.amazon.com/blogs/machine-learning/feed/'],
  ['primaria', 'Together AI',        'https://www.together.ai/blog/rss.xml'],
  ['primaria', 'Allen AI',           'https://allenai.org/rss.xml'],
  ['primaria', 'PyTorch',            'https://pytorch.org/blog/feed.xml'],
  // espejos horarios: estos no publican RSS propio. No son fuente primaria: desconfiar.
  ['espejo',   'Anthropic (espejo)', 'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_anthropic_news.xml'],
  ['espejo',   'Claude (espejo)',    'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_claude.xml'],
  ['espejo',   'Meta AI (espejo)',   'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_meta_ai.xml'],
  ['espejo',   'xAI (espejo)',       'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_xainews.xml'],
  ['espejo',   'Perplexity (espejo)','https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_perplexity_hub.xml'],
  ['espejo',   'Cursor (espejo)',    'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_cursor.xml'],
  ['espejo',   'Ollama (espejo)',    'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_ollama.xml'],
  ['espejo',   'The Batch (espejo)', 'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_the_batch.xml'],

  // --- practica: como se usa, que funciona, como cambia el trabajo ---
  ['insider',  'Simon Willison',     'https://simonwillison.net/atom/everything/'],
  ['insider',  'Latent Space',       'https://www.latent.space/feed'],
  ['insider',  'Interconnects',      'https://www.interconnects.ai/feed'],
  ['insider',  'One Useful Thing',   'https://www.oneusefulthing.org/feed'],
  ['insider',  'Import AI',          'https://jack-clark.net/feed/'],
  ['insider',  'Zvi',                'https://thezvi.substack.com/feed'],
  ['insider',  'Ben Bites',          'https://bensbites.com/feed'],
  ['insider',  'TLDR AI',            'https://tldr.tech/api/rss/ai'],
  ['insider',  'AlphaSignal',        'https://alphasignal.ai/feed.xml'],
  ['insider',  'The Sequence',       'https://thesequence.substack.com/feed'],
  ['insider',  'Last Week in AI',    'https://lastweekin.ai/feed'],
  ['insider',  'Eugene Yan',         'https://eugeneyan.com/rss/'],
  ['insider',  'Hamel Husain',       'https://hamel.dev/index.xml'],
  ['insider',  'Sebastian Raschka',  'https://magazine.sebastianraschka.com/feed'],
  ['insider',  'Lilian Weng',        'https://lilianweng.github.io/index.xml'],
  ['insider',  'Karpathy',           'https://karpathy.github.io/feed.xml'],
  ['insider',  'Chain of Thought',   'https://every.to/chain-of-thought/feed'],
  ['insider',  'Pragmatic Engineer', 'https://newsletter.pragmaticengineer.com/feed'],

  // --- marketing digital, publicidad y SEO con IA ---
  ['aplicacion','Search Engine Land',    'https://searchengineland.com/feed'],
  ['aplicacion','Search Engine Journal', 'https://www.searchenginejournal.com/feed/'],
  ['aplicacion','Google Search Central',  'https://developers.google.com/search/blog/feed.xml'],
  ['aplicacion','Google Ads y comercio',  'https://blog.google/products/ads-commerce/rss/'],
  ['aplicacion','HubSpot marketing',      'https://blog.hubspot.com/marketing/rss.xml'],

  // --- automatizacion y herramientas de trabajo ---
  ['herramienta','n8n',              'https://blog.n8n.io/rss/'],
  ['herramienta','Zapier',           'https://zapier.com/blog/feeds/latest/'],
  ['herramienta','Notion',           'https://www.notion.so/blog/rss.xml'],
  ['herramienta','Figma',            'https://www.figma.com/blog/feed/atom.xml'],
  ['herramienta','Vercel',           'https://vercel.com/atom'],

  // --- comunidad: lo que funciona de verdad frente a lo que funciona en la demo ---
  ['comunidad', 'Hacker News 300+',  'https://hnrss.org/frontpage?points=300'],
  ['comunidad', 'r/LocalLLaMA',      'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=week'],
  ['comunidad', 'r/ClaudeAI',        'https://www.reddit.com/r/ClaudeAI/top/.rss?t=week'],
  ['comunidad', 'r/AI_Agents',       'https://www.reddit.com/r/AI_Agents/top/.rss?t=week'],

  // --- datos duros de adopcion: la vía B vive de aqui ---
  ['datos',     'Stack Overflow blog','https://stackoverflow.blog/feed/'],
  ['datos',     'a16z',               'https://a16z.com/feed/'],

  // --- prensa tecnologica, filtrada ---
  ['prensa',    'TechCrunch AI',     'https://techcrunch.com/category/artificial-intelligence/feed/'],
  ['prensa',    'The Verge AI',      'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'],
  ['prensa',    'The Decoder',       'https://the-decoder.com/feed/'],
  ['prensa',    'VentureBeat AI',    'https://venturebeat.com/category/ai/feed/'],
  ['prensa',    'MIT Tech Review',   'https://www.technologyreview.com/topic/artificial-intelligence/feed/'],
];

const hoy = new Date();

// La fecha del corpus es la de Madrid, no la UTC: tiene que coincidir con la que
// validar.mjs deduce del nombre del briefing, o no encuentra el corpus.
const fechaISO = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(hoy);

// Ventana anclada a la medianoche de Madrid, no al instante de ejecucion. Antes se
// restaban 7x24h desde las 02:00 UTC, asi que el lunes se perdian las primeras horas
// del lunes anterior — y eso no se recupera: el corpus es la unica fuente valida de
// URLs. Se resta ademas el desfase maximo de Madrid (UTC+2): incluir una hora de mas
// es inofensivo porque el agente filtra por fecha del hecho, perder una es definitivo.
const limite = new Date(Date.parse(fechaISO + 'T00:00:00Z') - VENTANA_DIAS * 864e5 - 2 * 3600e3);

function canonica(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|fbclid|gclid|mc_cid|mc_eid)/i.test(p)) u.searchParams.delete(p);
    }
    let s = u.toString().toLowerCase();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch { return String(url).trim().toLowerCase(); }
}

const idDe = (url) => createHash('sha1').update(canonica(url)).digest('hex').slice(0, 12);

function desescapa(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#3[49];/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}

const etiqueta = (bloque, nombre) => {
  const m = bloque.match(new RegExp(`<${nombre}[^>]*>([\\s\\S]*?)</${nombre}>`, 'i'));
  return m ? desescapa(m[1]) : '';
};

function enlaceDe(bloque) {
  const rss = etiqueta(bloque, 'link');
  if (rss && !rss.startsWith('<')) return rss;
  const atom = bloque.match(/<link[^>]*rel=["']?alternate["']?[^>]*href=["']([^"']+)["']/i)
            || bloque.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? desescapa(atom[1]) : '';
}

function fechaDe(bloque) {
  for (const t of ['pubDate', 'published', 'updated', 'dc:date']) {
    const v = etiqueta(bloque, t);
    if (v) { const d = new Date(v); if (!isNaN(d)) return d; }
  }
  return null;
}

function parsea(xml) {
  const bloques = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return bloques.map((b) => {
    const url = enlaceDe(b);
    const fecha = fechaDe(b);
    if (!url || !fecha) return null;
    const cuerpo = etiqueta(b, 'content:encoded') || etiqueta(b, 'content')
                || etiqueta(b, 'description')     || etiqueta(b, 'summary');
    return {
      id: idDe(url),
      url: canonica(url),
      url_original: url,
      titulo: etiqueta(b, 'title'),
      fecha_pub: fecha.toISOString(),
      // Solo el arranque del articulo. Suficiente para triar y decidir si merece
      // abrir la fuente completa; el resto seria pagar tokens por material que se descarta.
      texto: cuerpo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200),
    };
  }).filter(Boolean);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function baja(url) {
  let ultimo = '';
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    // Backoff antes de reintentar. Reintentar a los 0 ms de un timeout no funciona nunca.
    if (intento > 0) await espera(1000 * intento * intento);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
      // La allowlist del entorno se delata aqui: no es que la fuente este caida.
      const denegado = r.headers.get('x-deny-reason');
      if (denegado) return { ok: false, status: r.status, motivo: `red_bloqueada:${denegado}` };
      if (!r.ok) {
        ultimo = `http_${r.status}`;
        // 429 es "vas demasiado deprisa", no "no existe": hay que esperar y repetir.
        // Antes caia en el `< 500` y se abandonaba al primer intento.
        if (r.status === 429) {
          const ra = Number(r.headers.get('retry-after'));
          await espera(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000, 15000));
          continue;
        }
        if (r.status < 500) break;
        continue;
      }
      return { ok: true, status: r.status, xml: await r.text() };
    } catch (e) {
      ultimo = e.name === 'TimeoutError' ? 'timeout' : `error:${e.message.slice(0, 80)}`;
    }
  }
  return { ok: false, status: 0, motivo: ultimo || 'desconocido' };
}

// Descarga por tandas. 61 peticiones a la vez saturan la salida del contenedor y
// provocan timeouts que no son culpa de la fuente; y si caen 31, el script aborta
// la noche entera por un problema de red propio. Con 8 en paralelo tarda unos
// segundos mas y no se autolesiona.
async function enTandas(lista, n, fn) {
  const cola = [...lista];
  await Promise.all([...Array(Math.min(n, cola.length))].map(async () => {
    while (cola.length) await fn(cola.shift());
  }));
}

const salud = [];
const items = [];

await enTandas(FEEDS, CONCURRENCIA, async ([tier, nombre, url]) => {
  const r = await baja(url);
  if (!r.ok) { salud.push({ tier, nombre, url, ok: false, motivo: r.motivo }); return; }
  let dentro = 0, total = 0;
  for (const it of parsea(r.xml)) {
    total++;
    if (new Date(it.fecha_pub) >= limite) { items.push({ ...it, tier, fuente: nombre }); dentro++; }
  }
  // Regla 15 de AGENTE.md: un feed que parsea sin ninguna entrada esta caido.
  // Antes se contaba como vivo, asi que un feed roto inflaba el ratio del 50%.
  if (total === 0) { salud.push({ tier, nombre, url, ok: false, motivo: 'sin_entradas' }); return; }
  salud.push({ tier, nombre, url, ok: true, items_totales: total, items_en_ventana: dentro });
});

const vivos = salud.filter((s) => s.ok).length;
const bloqueados = salud.filter((s) => !s.ok && s.motivo?.startsWith('red_bloqueada')).length;
const ratio = vivos / FEEDS.length;

// Deduplica por id conservando el item mas antiguo (la primera aparicion es la noticia).
const porId = new Map();
for (const it of items.sort((a, b) => a.fecha_pub.localeCompare(b.fecha_pub))) {
  if (!porId.has(it.id)) porId.set(it.id, it);
}
const corpus = [...porId.values()];

const rutaCorpus = `estado/corpus/${fechaISO}.jsonl`;
await mkdir(dirname(rutaCorpus), { recursive: true });
await writeFile(rutaCorpus, corpus.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
await writeFile('estado/salud.json', JSON.stringify({
  fecha: fechaISO,
  generado: new Date().toISOString(),
  feeds_totales: FEEDS.length,
  feeds_vivos: vivos,
  feeds_bloqueados_por_red: bloqueados,
  ratio_vivos: Number(ratio.toFixed(3)),
  items_en_ventana: corpus.length,
  detalle: salud.sort((a, b) => Number(a.ok) - Number(b.ok)),
}, null, 2) + '\n', 'utf8');

console.log(`feeds vivos: ${vivos}/${FEEDS.length}  ·  items en ventana: ${corpus.length}  ·  corpus: ${rutaCorpus}`);
for (const s of salud.filter((x) => !x.ok)) console.log(`  CAIDO  ${s.nombre.padEnd(20)} ${s.motivo}`);
if (bloqueados > 0) {
  console.log(`\n  AVISO: ${bloqueados} feed(s) bloqueados por la allowlist del entorno, no por la fuente.`);
  console.log('  Se arregla en la configuracion de red de la routine (Custom), no en AGENTE.md.');
}

if (ratio < 0.5) {
  console.error(`\nFALLO: solo ${vivos} de ${FEEDS.length} feeds respondieron (${(ratio * 100).toFixed(0)}%). No se publica briefing.`);
  process.exit(1);
}
