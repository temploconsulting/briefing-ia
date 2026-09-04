# gold.jsonl — conjunto de referencia

Una linea JSON por titular real, etiquetada **a mano por el lector**:

```json
{"titular": "texto literal del titular", "fecha_hecho": "2026-09-01", "etiqueta": "entra", "por_que": "opcional"}
```

`etiqueta` es `entra` o `no_entra`. Nada mas.

## Para que sirve

El dia 1 de cada mes el agente pasa estos titulares por su filtro de entrada
y compara su decision con la tuya. No importa el numero absoluto: importa **el
cambio**. Si un mes coincide en el 85% y al siguiente en el 70%, el criterio
se ha movido solo, y eso hay que verlo antes de que se note en el briefing.

## Como se rellena

Sin prisa y sin inventar. Segun vayan llegando briefings, coge titulares reales
—los que se publicaron y los que aparecen en "considerado y descartado"— y
etiquetalos como los habrias etiquetado tu. **Con menos de 20 no se ejecuta el
filtro.** El objetivo son 40, mitad y mitad, pero es un fichero que crece con
el tiempo: no hay que sentarse una tarde a rellenarlo.

Una vez etiquetado, un titular **no se cambia**. Si cambias el criterio, se
anota como un gold set nuevo. Mover la referencia para que el agente apruebe
es como mover la porteria: el resultado deja de significar nada.
