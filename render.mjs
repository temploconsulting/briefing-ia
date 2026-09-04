#!/usr/bin/env node
// render.mjs — convierte el JSON del agente en la pagina publicada.
//
//   node render.mjs briefings/2026-09-04.json
//   node render.mjs --ultimo
//
// El agente NUNCA escribe HTML. Escribe JSON, y esto lo renderiza escapando
// todo el texto de terceros. Un titular con <script> sale visible como texto,
// no se ejecuta. Es la unica razon por la que existe este fichero.
//
// Codigo de salida: 0 ok · 2 el JSON no cumple el esquema

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const errores = [];
const avisos = [];

// ---------- escapado: la cerradura ----------
const E = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------- lista blanca de dominios ----------
let DOMINIOS = new Set();
try {
  DOMINIOS = new Set((await readFile('dominios.txt', 'utf8'))
    .split('\n').map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')));
} catch { errores.push('falta dominios.txt'); }

function dominioPermitido(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return false; }
  if (DOMINIOS.has(host)) return true;
  return [...DOMINIOS].some((d) => host.endsWith('.' + d));
}

// Un enlace no permitido pierde el href y conserva el texto. Nunca se cuela.
function enlace(url, texto) {
  if (!dominioPermitido(url)) {
    avisos.push(`enlace descartado (dominio no permitido): ${url}`);
    return `${E(texto)} <span class="src">[enlace omitido]</span>`;
  }
  return `<a href="${E(url)}" rel="noopener nofollow">${E(texto)}</a>`;
}

// ---------- entrada ----------
let ruta = process.argv[2];
if (!ruta || ruta === '--ultimo') {
  const f = (await readdir('briefings').catch(() => [])).filter((x) => x.endsWith('.json')).sort();
  if (!f.length) { console.error('BLOQUEADO: no hay ningun briefings/*.json'); process.exit(2); }
  ruta = `briefings/${f.at(-1)}`;
}
let b;
try { b = JSON.parse(await readFile(ruta, 'utf8')); }
catch (e) { console.error(`BLOQUEADO: ${ruta} no es JSON valido — ${e.message}`); process.exit(2); }

// ---------- validacion de esquema ----------
if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '')) errores.push('falta "fecha" en formato AAAA-MM-DD');
const ESTADOS = ['publicado', 'alerta', 'semana_floja', 'fuentes_caidas', 'incidencia'];
if (!ESTADOS.includes(b.estado)) errores.push(`"estado" debe ser uno de: ${ESTADOS.join(', ')}`);
if (b.estado !== 'fuentes_caidas' && !b.titular) errores.push('falta "titular"');

b.items ??= [];
// 4 a 8, igual que AGENTE.md. Antes esto decia 3 y el esquema decia otra cosa:
// con exactamente 3 items el agente no sabia si era "publicado" o "semana_floja".
if (b.estado === 'publicado' && (b.items.length < 4 || b.items.length > 8)) {
  errores.push(`estado "publicado" exige entre 4 y 8 items, hay ${b.items.length}. Con menos de 4, el estado es "semana_floja".`);
}
if (b.estado === 'semana_floja' && (b.items.length < 1 || b.items.length > 3)) {
  errores.push(`estado "semana_floja" lleva entre 1 y 3 items, hay ${b.items.length}. Con 4 o mas, el estado es "publicado".`);
}
if (b.estado === 'alerta' && b.items.length !== 1) {
  errores.push(`una alerta lleva exactamente 1 item, hay ${b.items.length}. No es un briefing corto: es un aviso.`);
}
if (b.estado === 'alerta' && !b.motivo_urgencia) {
  errores.push('una alerta debe declarar "motivo_urgencia": cuál de los cuatro supuestos del listón cumple');
}

for (const [i, it] of b.items.entries()) {
  const n = `item ${i + 1}`;
  if (!/^[0-9a-f]{12}$/.test(it.id || '')) errores.push(`${n}: "id" debe ser 12 caracteres hex`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.fecha_hecho || '')) errores.push(`${n}: falta "fecha_hecho"`);
  if (!['A', 'B'].includes(it.via)) errores.push(`${n}: "via" debe ser "A" (cambia una decision) o "B" (mueve el panorama)`);
  for (const c of ['titulo', 'hecho', 'por_que', 'que_haces']) if (!it[c]) errores.push(`${n}: falta "${c}"`);
  if (!Array.isArray(it.fuentes) || !it.fuentes.length) errores.push(`${n}: necesita al menos una fuente`);
}

// Cupo de la via B: no mas de 2, y nunca mas de la mitad del briefing.
const viaB = b.items.filter((it) => it.via === 'B').length;
if (viaB > 2) errores.push(`hay ${viaB} items de via B; el cupo es 2`);
if (b.items.length && viaB > b.items.length / 2) {
  errores.push(`la via B no puede ser mas de la mitad del briefing (${viaB} de ${b.items.length})`);
}
if (b.estado === 'alerta' && viaB > 0) {
  errores.push('una alerta nunca es de via B: una tendencia que se ve en un dia no es una tendencia');
}
const slugs = new Set();
for (const g of b.glosario ?? []) {
  if (!g.slug || !g.termino || !g.definicion) errores.push('entrada de glosario incompleta');
  if (slugs.has(g.slug)) errores.push(`glosario: "${g.slug}" duplicado dentro del mismo briefing`);
  slugs.add(g.slug);
}
if (errores.length) {
  console.error(`\nBLOQUEADO · ${ruta} no cumple el esquema:\n`);
  for (const e of errores) console.error(`  - ${e}`);
  process.exit(2);
}

// ---------- helpers de plantilla ----------
// La leccion y el analisis solo salen en el briefing semanal, nunca en una alerta.
const esBriefing = b.estado === 'publicado' || b.estado === 'semana_floja';
const parrafos = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean).map((p) => `<p>${E(p)}</p>`).join('\n');
const seccion = (id, titulo, nota, cuerpo) => !cuerpo ? '' : `
  <div class="sec-head"><h2>${E(titulo)}</h2><span class="rule"></span>${nota ? `<span class="sec-note">${E(nota)}</span>` : ''}</div>
  <div data-seccion="${id}">
${cuerpo}
  </div><!-- /${id} -->`;

const fmtFecha = (f) => new Date(f + 'T12:00:00Z')
  .toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });

// ---------- bloques ----------
const bloqueItem = (it, i) => `
    <article class="item" data-id="${E(it.id)}" data-fecha="${E(it.fecha_hecho)}">
      <div class="item-rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="item-body">
        ${it.etiquetas?.length || it.nivel ? `<div class="tags">${
          (it.nivel ? [`<span class="tag primaria">${E(it.nivel)}</span>`] : [])
            .concat((it.etiquetas ?? []).map((t) => `<span class="tag">${E(t)}</span>`)).join('')
        }</div>` : ''}
        <span class="fecha">${E(fmtFecha(it.fecha_hecho))}</span>
        <h3>${E(it.titulo)}</h3>
        ${it.situarte?.length ? `<div class="ficha"><span class="lbl">Para situarte</span>${parrafos(it.situarte)}</div>` : ''}
        ${parrafos(it.hecho)}
        <p class="why"><span class="lbl">Por que importa</span>${E(it.por_que)}</p>
        ${it.ensena ? `<div class="ficha"><span class="lbl">Lo que esto te ensena como profesional</span><p>${E(it.ensena)}</p></div>` : ''}
        ${it.cuesta ? `<div class="ficha"><span class="lbl">Cuesta dinero?</span><p>${E(it.cuesta)}</p></div>` : ''}
        <div class="do"><span class="lbl">Que haces tu</span><p>${E(it.que_haces)}</p></div>
        ${it.cautela ? `<div class="alerta"><span class="lbl">Cautela</span><p>${E(it.cautela)}</p></div>` : ''}
        <p class="src">Fuentes: ${it.fuentes.map((f) => enlace(f.url, f.titulo)).join(' &middot; ')}</p>
      </div>
    </article>`;

const bloqueLeccion = (l) => `
  <div class="leccion">
    <span class="lbl">Fundamento de diseno</span>
    <h3>${E(l.titulo)}</h3>
    ${parrafos(l.entrada)}
    ${l.regla ? `<div class="regla"><span class="lbl">La regla</span><p>${E(l.regla)}</p></div>` : ''}
    ${l.columnas?.length ? `<div class="split">${l.columnas.map((c) => `
      <div class="side"><h4>${E(c.titulo)}</h4><p class="def">${E(c.definicion)}</p>
      <ul>${(c.ejemplos ?? []).map((e) => `<li>${E(e)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
    ${l.error_caro ? `<div class="trampa"><span class="lbl">El error caro</span><p>${E(l.error_caro)}</p></div>` : ''}
    ${l.pitch ? `<div class="pitch"><span class="lbl">Como lo cuentas a direccion</span><p>${E(l.pitch)}</p></div>` : ''}
  </div>`;

const css = existsSync('estilo.css') ? await readFile('estilo.css', 'utf8') : '';
if (!css) avisos.push('no se encontro estilo.css: la pagina saldra sin estilo');

const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Briefing IA · ${E(fmtFecha(b.fecha))}</title>
<style>
${css}</style></head><body>
<div class="sheet">

  <header class="masthead">
    <div class="badges"><span class="pilot">Edicion ${E(b.edicion ?? '')}</span>${
      b.estado !== 'publicado' ? `<span class="fixed">${E(b.estado.replace(/_/g, ' '))}</span>` : ''}</div>
    <h1>Briefing Semanal de IA</h1>
    <p class="standfirst">Herramientas, adopcion y formas de trabajar con IA. Para el equipo de Templo Consulting.</p>
    <div class="stamp">
      <span><b>${E(fmtFecha(b.fecha))}</b></span>
      ${b.ventana ? `<span>Ventana <b>${E(fmtFecha(b.ventana.desde))} - ${E(fmtFecha(b.ventana.hasta))}</b></span>` : ''}
      <span>Items <b>${b.items.length}</b></span>
    </div>
  </header>

  ${b.aviso ? `<div class="alerta"><span class="lbl">Aviso</span><p>${E(b.aviso)}</p></div>` : ''}

  ${b.titular ? `<div class="lede" data-seccion="titular"><span class="kicker">Titular de la semana</span><p>${E(b.titular)}</p></div><!-- /titular -->` : ''}

  ${seccion('items', 'Lo que importa', 'por impacto', b.items.length
    ? `    <div class="items">${b.items.map(bloqueItem).join('')}</div>` : '')}

  ${esBriefing && b.leccion ? seccion('leccion', 'Leccion de la semana', 'un concepto que no caduca', bloqueLeccion(b.leccion)) : ''}

  ${esBriefing && b.analisis ? seccion('analisis', 'Analisis de la semana', null,
    `  <div class="leccion"><h3>${E(b.analisis.titulo)}</h3>${parrafos(b.analisis.parrafos)}</div>`) : ''}

  ${b.candidatos?.length ? seccion('candidatos', 'Candidatos a automatizar', 'lista viva',
    `  <div class="tablewrap"><table><thead><tr><th>Proceso</th><th>Tipo</th><th>Dificultad</th><th>Por donde empezar</th></tr></thead><tbody>${
      b.candidatos.map((c) => `<tr><td class="proc">${E(c.proceso)}</td><td><span class="chip c-tipo">${E(c.tipo)}</span></td>` +
      `<td><span class="chip c-${E(String(c.dificultad).toLowerCase())}">${E(c.dificultad)}</span></td><td class="first">${E(c.primer_paso)}</td></tr>`).join('')
    }</tbody></table></div>`) : ''}

  ${b.hilos?.length ? seccion('hilos', 'Hilos en seguimiento', 'se arrastran hasta cerrarse',
    `  <div class="threads">${b.hilos.map((h) => `<div class="thread"><span class="lbl">${E(h.estado)}</span><b>${E(h.titulo)}</b><p>${E(h.texto)}</p></div>`).join('')}</div>`) : ''}

  ${b.radar?.length ? seccion('radar', 'Radar 90 dias', 'para no ir a remolque',
    `  <ul class="radar">${b.radar.map((r) => `<li><span class="when">${E(r.cuando)}</span><p>${E(r.texto)}</p></li>`).join('')}</ul>`) : ''}

  ${b.glosario?.length ? seccion('glosario', 'Glosario acumulado', 'no se repite',
    `  <dl class="glos">${b.glosario.map((g) => `<div class="glos-row"><dt data-termino="${E(g.slug)}">${E(g.termino)}</dt><dd>${E(g.definicion)}</dd></div>`).join('')}</dl>`) : ''}

  ${b.descartados?.length ? seccion('descartados', 'Considerado y descartado', 'para que se vea que el filtro funciono',
    `  <ul class="radar">${b.descartados.map((d) => `<li><span class="when">descartado</span><p>${E(d.titular)} &mdash; ${E(d.motivo)}</p></li>`).join('')}</ul>`) : ''}

  ${seccion('cobertura', 'Cobertura', null,
    `  <div class="sources">${(b.cobertura ?? []).map((c) => `<div class="tier"><span class="name">${E(c.nivel)}</span><p>${E(c.texto)}</p></div>`).join('')}</div>` +
    (b.ids_para_feedback?.length ? `\n  <p class="src">Items de hoy: ${b.ids_para_feedback.map(E).join(' &middot; ')}. Anota "sirvio" o "sobraba" en feedback.json.</p>` : ''))}

  <div class="colophon">
    Solo entra lo que cambia una decision. Una semana floja es un briefing de dos items, no de cinco rellenos.<br>
    Toda afirmacion lleva enlace a su fuente y fecha visible. Lo que no se verifica, no se publica.<br>
    Generado automaticamente. El texto de terceros se publica escapado.
  </div>

</div></body></html>
`;

// ---------- markdown: ESTE es el fichero que se entrega en Drive ----------
// Tiene que llevar lo mismo que el HTML. Cuando solo llevaba items, hilos y glosario,
// el lector recibia el briefing sin la leccion ni el analisis, que es el contenido
// perenne y el que mas le sirve. El HTML se queda en el repositorio; esto es lo que lee.
//
// Los corchetes en texto de terceros rompen la sintaxis de enlace de markdown.
const M = (s) => String(s ?? '').replace(/([[\]])/g, '\\$1');

const fuentesMd = (fuentes) => {
  const ok = (fuentes ?? []).filter((f) => dominioPermitido(f.url));
  if (!ok.length) return 'Fuentes: _ninguna con dominio permitido_';
  return `Fuentes: ${ok.map((f) => `[${M(f.titulo)}](${f.url})`).join(' · ')}`;
};

const md = [
  `# Briefing IA · ${fmtFecha(b.fecha)}`,
  `*Edicion ${b.edicion ?? '—'}${b.ventana ? ` · ventana ${fmtFecha(b.ventana.desde)} a ${fmtFecha(b.ventana.hasta)}` : ''}${b.estado !== 'publicado' ? ` · ${b.estado.replace(/_/g, ' ')}` : ''}*`, '',
  b.aviso ? `> **Aviso.** ${b.aviso}\n` : null,
  b.motivo_urgencia ? `> **Motivo de la alerta.** ${b.motivo_urgencia}\n` : null,
  b.titular ? `**${b.titular}**\n` : null,

  b.items.length ? '## Lo que importa' : null,
  ...b.items.flatMap((it, i) => [
    `### ${String(i + 1).padStart(2, '0')} · ${it.titulo}`,
    `*${fmtFecha(it.fecha_hecho)} · via ${it.via}${it.nivel ? ' · ' + it.nivel : ''}${it.etiquetas?.length ? ' · ' + it.etiquetas.join(', ') : ''}*`, '',
    ...(it.situarte ?? []).map((p) => `> ${p}`), (it.situarte?.length ? '' : null),
    it.hecho, '',
    `**Por que importa.** ${it.por_que}`, '',
    it.ensena ? `**Lo que te ensena.** ${it.ensena}\n` : null,
    it.cuesta ? `**Cuesta dinero.** ${it.cuesta}\n` : null,
    `**Que haces tu.** ${it.que_haces}`, '',
    it.cautela ? `⚠️ **Cautela.** ${it.cautela}\n` : null,
    fuentesMd(it.fuentes), '',
  ]),

  esBriefing && b.leccion ? [
    `## Leccion de la semana`, '', `### ${b.leccion.titulo}`, '',
    b.leccion.entrada, '',
    b.leccion.regla ? `**La regla.** ${b.leccion.regla}\n` : null,
    ...(b.leccion.columnas ?? []).flatMap((c) => [
      `**${c.titulo}** — ${c.definicion}`,
      ...(c.ejemplos ?? []).map((e) => `- ${e}`), '',
    ]),
    b.leccion.error_caro ? `**El error caro.** ${b.leccion.error_caro}\n` : null,
    b.leccion.pitch ? `**Como lo cuentas a direccion.** ${b.leccion.pitch}\n` : null,
  ].filter((l) => l !== null).join('\n') : null,

  esBriefing && b.analisis ? [
    `## Analisis de la semana`, '', `### ${b.analisis.titulo}`, '',
    ...(b.analisis.parrafos ?? []), '',
  ].join('\n') : null,

  b.candidatos?.length ? [
    '## Candidatos a automatizar', '',
    '| Proceso | Tipo | Dificultad | Por donde empezar |',
    '|---|---|---|---|',
    ...b.candidatos.map((c) => `| ${c.proceso} | ${c.tipo} | ${c.dificultad} | ${c.primer_paso} |`), '',
  ].join('\n') : null,

  b.hilos?.length ? '## Hilos en seguimiento\n\n' + b.hilos.map((h) => `- **${h.titulo}** (${h.estado}) — ${h.texto}`).join('\n') + '\n' : null,
  b.radar?.length ? '## Radar 90 dias\n\n' + b.radar.map((r) => `- **${r.cuando}** — ${r.texto}`).join('\n') + '\n' : null,
  b.glosario?.length ? '## Glosario\n\n' + b.glosario.map((g) => `- **${g.termino}** — ${g.definicion}`).join('\n') + '\n' : null,
  b.descartados?.length ? '## Considerado y descartado\n\n' + b.descartados.map((d) => `- ${d.titular} — ${d.motivo}${d.dominio ? ` (${d.dominio})` : ''}`).join('\n') + '\n' : null,
  b.cobertura?.length ? '## Cobertura\n\n' + b.cobertura.map((c) => `- **${c.nivel}** — ${c.texto}`).join('\n') + '\n' : null,
  b.ids_para_feedback?.length ? `---\n\nItems de hoy: ${b.ids_para_feedback.join(' · ')}.\nAnota "sirvio" o "sobraba" en cada uno.\n` : null,
].filter((l) => l !== null && l !== undefined).join('\n');

await mkdir('briefings', { recursive: true });
await writeFile(`briefings/${b.fecha}.html`, html, 'utf8');
await writeFile(`briefings/${b.fecha}.md`, md, 'utf8');

// ---------- portada ----------
const ediciones = (await readdir('briefings')).filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort().reverse();
await writeFile('index.html', `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Briefing Semanal de IA</title>
<style>${css}</style></head><body><div class="sheet">
<header class="masthead"><h1>Briefing Semanal de IA</h1>
<p class="standfirst">Herramientas, adopcion y formas de trabajar con IA. Para el equipo de Templo Consulting.</p>
<div class="stamp"><span>Ultima edicion <b>${E(fmtFecha(b.fecha))}</b></span><span>Ediciones <b>${ediciones.length}</b></span></div></header>
${b.aviso ? `<div class="alerta"><span class="lbl">Aviso</span><p>${E(b.aviso)}</p></div>` : ''}
<div class="sec-head"><h2>Historico</h2><span class="rule"></span></div>
<ul class="radar">${ediciones.map((f) => {
  const d = f.replace('.html', '');
  return `<li><span class="when">${E(fmtFecha(d))}</span><p><a href="briefings/${E(f)}">Briefing del ${E(fmtFecha(d))}</a></p></li>`;
}).join('')}</ul>
</div></body></html>
`, 'utf8');

for (const a of avisos) console.log(`  aviso  ${a}`);
console.log(`OK · briefings/${b.fecha}.html · briefings/${b.fecha}.md · index.html (${ediciones.length} ediciones)`);
