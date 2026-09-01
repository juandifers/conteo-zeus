# Primera corrida — la lista, no el párrafo

**Estado: ninguna de las dos opciones se ha ejecutado todavía.** Este documento
existe porque una de ellas tiene que ejecutarse **antes de la primera sesión
real**, y porque «lo revisamos con cuidado» no es un control: un control es una
lista que alguien recorre y firma.

---

## Qué está abierto, exactamente

`uncountedPolicy: 'existencia'` **nunca se ha ejercido contra Zeus.**

La corrida verificada del 2026-08-28 (ZEUS_FORMAT.md §7.1) tenía **dos filas y
las dos estaban contadas**. La política de filas sin contar fue, en esa corrida,
código que no se ejecutó. En una sesión real es lo contrario: en una bodega de
2 400 artículos la mayoría de las líneas del archivo salen de esa rama, no de un
conteo.

La inferencia a favor es decente y está escrita en §9: la exportación del propio
hotel trae `toma = existencia` en las 298 filas, así que la *forma* del archivo
es la que Zeus ya recibe hoy. Pero inferencia decente es exactamente lo que §7.1
existe para distinguir de observación, y este es el punto del proceso donde la
distinción cuesta dinero: si Zeus tratara «toma igual a existencia» de alguna
manera que no sea «sin cambio», el ajuste movería saldos en miles de filas que
nadie tocó.

Y hay una segunda cosa abierta que la misma prueba cierra: **§7.4 es un
recuerdo**, no una observación comprometida. Que escribir `0` en `toma` borre el
saldo está registrado a partir de lo que el hotel cuenta que hace Zeus, no de una
fila del archivo de evidencia. Toda la lista de conteos en cero del acta (P2.4
§3c) está construida sobre que eso sea cierto.

---

## Opción 1 — la prueba de tres filas (preferida)

Más barata y más concluyente que la opción 2, y **no requiere código**. Cierra
`uncountedPolicy` y §7.4 en una sola subida.

Se hace sobre una **bodega desechable**, nunca sobre una real.

- [ ] **Elegir la bodega de prueba.** Una cuyo saldo no le importe a nadie.
      Anotar el código: `____`
- [ ] **Exportar el `.xls` desde Zeus** para esa bodega y guardarlo tal cual.
      Nombre del archivo: `________________`
- [ ] **Anotar los saldos de partida** de las tres filas, leídos en Zeus antes de
      tocar nada. No de memoria: una captura o un reporte impreso.

      | fila | `idarticulo` | `nombre` | `existencia` antes |
      |---|---|---|---|
      | A — se cuenta distinto | | | |
      | B — nadie la toca | | | |
      | C — se cuenta en cero, con existencia > 0 | | | |

- [ ] **Importar el `.xls` en la aplicación**, despachar un contador, contar
      **solo** A y C:
      - A con una cantidad distinta de su existencia;
      - C con `0`;
      - B **sin tocar** — no exonerarla tampoco. Tiene que llegar al archivo por
        la política, que es lo que se está probando.
- [ ] **Sellar y generar el archivo.** Anotar `fileHash` (los primeros ocho van
      en el nombre): `________`
- [ ] **Comprobar el archivo antes de subirlo**: abrir `tools/verificador.html`,
      darle el `sesion_<id>.json` y el `.txt`, y confirmar que todo dice OK.
- [ ] **Subir el `.txt` a Zeus** y revisar dentro de Zeus, **antes de fusionar**,
      que el documento propuesto dice lo que se espera.
- [ ] **Fusionar y leer los saldos de nuevo.**

      | fila | esperado | observado |
      |---|---|---|
      | A | el saldo pasa a la cantidad contada | |
      | B | **el saldo no se mueve** | |
      | C | el saldo queda en `0` | |

- [ ] **Si B se movió, parar.** `uncountedPolicy: 'existencia'` no significa lo
      que este proyecto cree que significa y ninguna sesión real puede correr
      hasta entenderlo. Registrar qué pasó y abrir el asunto en
      ZEUS_FORMAT.md §7 como una pregunta, no como una nota.
- [ ] **Registrar el resultado en ZEUS_FORMAT.md §7.6**, con la fecha, quién lo
      hizo, la bodega y las tres filas. Un resultado que solo vive en la memoria
      de quien lo hizo es la misma clase de vacío que este documento existe para
      cerrar.

---

## Opción 2 — la primera corrida supervisada

Aceptable si la opción 1 no se pudo hacer. **Es más débil**: prueba lo mismo pero
sobre datos reales, con un solo intento y sin manera de repetirlo, y la revisión
tiene que hacerse sobre miles de filas en vez de tres.

La puerta de revisión dentro de Zeus, antes de fusionar, existe y es lo que hace
esta opción viable. Es también carga: hay que usarla de verdad.

- [ ] **Antes de subir**, imprimir o guardar el acta y anotar de ella:
      - filas del catálogo: `____`
      - contadas: `____`
      - contadas en cero: `____`
      - exoneradas: `____`
      - sin contar: `____`
      - `sin verificar`: `____________` COP
- [ ] **Comprobar el archivo** con `tools/verificador.html` antes de subirlo.
- [ ] **Subir el `.txt` y detenerse en la revisión de Zeus.** No fusionar
      todavía.
- [ ] **Elegir cinco filas que nadie contó**, de familias distintas, y comprobar
      una por una que el documento propuesto **no mueve su saldo**. Anotarlas:
      `____________________________________________`
- [ ] **Elegir cada fila contada en cero** — están itemizadas en el acta §4.1 —
      y comprobar que el documento propuesto **sí** las lleva a `0`. Son bajas de
      inventario: si aparece una que no se esperaba, parar.
- [ ] **Comprobar el total del documento** contra la diferencia neta del acta.
      No tienen por qué coincidir peso a peso si Zeus valora distinto, pero un
      orden de magnitud de diferencia es una señal, no un redondeo.
- [ ] **Si algo no cuadra, abortar la fusión.** El conteo no se pierde: el `.txt`
      y el paquete de auditoría siguen guardados y el archivo se puede volver a
      descargar byte por byte idéntico.
- [ ] **Registrar el resultado en ZEUS_FORMAT.md §7.6.**

---

## Lo que ninguna de las dos cierra

- **Qué hace Zeus con `conteo1`.** Sigue implementado y sin probar. No debe
  volverse un valor por defecto.
- **`differenceColumn: 'zero'`.** Igual.
- **Una bodega cuya exportación difiera estructuralmente** de los dos archivos
  contra los que se ha corrido esto. Cada una necesita su propia primera corrida.
