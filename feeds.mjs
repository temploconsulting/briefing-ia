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

const FEEDS = [
  // --- primarias ---
  ['primaria', 'OpenAI',            'https://openai.com/news/rss.xml'],
  ['primaria', 'Google DeepMind',   'https://deepmind.google/blog/rss.xml'],
  ['primaria', 'Google AI',         'https://blog.google/technology/ai/rss/'],
  ['primaria', 'Hugging Face',      'https://huggingface.co/blog/feed.xml'],
  ['primaria', 'Mistral',           'https://mistral.ai/rss.xml'],
  ['primaria', 'GitHub AI',         'https://github.blog/ai-and-ml/feed/'],
  // espejos: Anthropic y Meta no publican RSS propio
  ['primaria', 'Anthropic (espejo)', 'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_anthropic_news.xml'],
  ['primaria', 'Claude (espejo)',    'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_claude.xml'],
  ['primaria', 'Meta AI (espejo)',   'https://raw.githubusercontent.com/Olshansk/rss-feeds/refs/heads/main/feeds/feed_meta_ai.xml'],
  // --- insiders ---
  ['insider',  'Simon Willison',    'https://simonwillison.net/atom/everything/'],
  ['insider',  'Zvi',               'https://thezvi.substack.com/feed'],
  ['insider',  'Import AI',         'https://jack-clark.net/feed/'],
  ['insider',  'One Useful Thing',  'https://www.oneusefulthing.org/feed'],
  ['insider',  'Interconnects',     'https://www.interconnects.ai/feed'],
  ['insider',  'Latent Space',      'https://www.latent.space/feed'],
  ['insider',  'AINews',            'https://news.smol.ai/rss.xml'],
  // --- comunidad y prensa ---
  ['comunidad', 'Hacker News 300+', 'https://hnrss.org/frontpage?points=300'],
  ['prensa',    'TechCrunch AI',    'https://techcrunch.com/category/artificial-intelligence/feed/'],
  ['prensa',    'The Verge AI',     'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'],
];

const hoy = new Date();
const fechaISO = hoy.toISOString().slice(0, 10);
const limite = new Date(hoy.getTime() - VENTANA_DIAS * 864e5);

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
      texto: cuerpo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
    };
  }).filter(Boolean);
}

async function baja(url) {
  let ultimo = '';
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
      // La allowlist del entorno se delata aqui: no es que la fuente este caida.
      const denegado = r.headers.get('x-deny-reason');
      if (denegado) return { ok: false, status: r.status, motivo: `red_bloqueada:${denegado}` };
      if (!r.ok) { ultimo = `http_${r.status}`; if (r.status < 500) break; continue; }
      return { ok: true, status: r.status, xml: await r.text() };
    } catch (e) {
      ultimo = e.name === 'TimeoutError' ? 'timeout' : `error:${e.message.slice(0, 80)}`;
    }
  }
  return { ok: false, status: 0, motivo: ultimo || 'desconocido' };
}

const salud = [];
const items = [];

await Promise.all(FEEDS.map(async ([tier, nombre, url]) => {
  const r = await baja(url);
  if (!r.ok) { salud.push({ tier, nombre, url, ok: false, motivo: r.motivo }); return; }
  let dentro = 0, total = 0;
  for (const it of parsea(r.xml)) {
    total++;
    if (new Date(it.fecha_pub) >= limite) { items.push({ ...it, tier, fuente: nombre }); dentro++; }
  }
  salud.push({ tier, nombre, url, ok: true, items_totales: total, items_en_ventana: dentro });
}));

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
