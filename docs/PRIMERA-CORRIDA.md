# Primera corrida — la lista, no el párrafo

**Estado: ninguna de las dos opciones se ha ejecutado todavía.** Este documento
existe porque una de ellas tiene que ejecutarse **antes de la primera sesión
real**, y porque «lo revisamos con cuidado» no es un control: un control es una
lista que alguien recorre y firma.

> **Actualizado 2026-09-30.** La política vigente es `uncountedPolicy: 'zero'`
> (decisión de 2026-09, `migrations/0006`, `VERIFIED_PARAMETERS`). Esta lista se
> escribió para `'existencia'` y esperaba que una fila sin tocar **no moviera su
> saldo**; con `'zero'` esa fila sale con `toma = 0` y **se espera que quede en
> cero**. Lo que la política deja con su saldo es una fila **exonerada** en la
> revisión. La prueba ahora tiene cuatro filas y no tres.
>
> **Una sesión de práctica o de capacitación nunca se sube a Zeus.** Con
> `'zero'`, cada artículo que nadie contó ni exoneró va en el archivo como
> vacío, y subirlo pone en cero su saldo. Capacitar sobre la bodega de prueba de
> la opción 1, o no generar el archivo, o generarlo y no subirlo: las tres
> sirven. Subir el de una práctica no.

---

## Qué está abierto, exactamente

Dos comportamientos de Zeus sobre los que se apoya todo el archivo, y ninguno
observado:

**Que `toma = 0` borre el saldo** (ZEUS_FORMAT.md §7.4). Con `'zero'` no es un
caso raro: es la rama que escribe la mayoría de las líneas. En una bodega de
2 400 artículos donde se alcanzaron 600, las otras 1 800 salen de ahí, y todas
son bajas de inventario. §7.4 es un **recuerdo** de lo que el hotel cuenta que
hace Zeus, no una fila del archivo de evidencia: la corrida verificada del
2026-08-28 tenía dos filas, las dos contadas, ninguna en cero.

**Que `toma = existencia` no mueva nada.** Es lo que escribe una fila
**exonerada** — la única manera que deja la política de que un artículo no
contado conserve su saldo, con nombre y motivo detrás. Tampoco se ha ejercido:
si Zeus tratara «toma igual a existencia» de otra forma que «sin cambio», cada
exoneración movería un saldo que nadie tocó.

---

## Opción 1 — la prueba de cuatro filas (preferida)

Más barata y más concluyente que la opción 2, y **no requiere código**. Cierra
`uncountedPolicy` y §7.4 en una sola subida.

Se hace sobre una **bodega desechable**, nunca sobre una real.

- [ ] **Elegir la bodega de prueba.** Una cuyo saldo no le importe a nadie.
      Anotar el código: `____`
- [ ] **Exportar el `.xls` desde Zeus** para esa bodega y guardarlo tal cual.
      Nombre del archivo: `________________`
- [ ] **Anotar los saldos de partida** de las cuatro filas, leídos en Zeus antes de
      tocar nada. No de memoria: una captura o un reporte impreso.

      | fila | `idarticulo` | `nombre` | `existencia` antes |
      |---|---|---|---|
      | A — se cuenta distinto | | | |
      | B — nadie la toca | | | |
      | C — se cuenta en cero, con existencia > 0 | | | |
      | D — se exonera en la revisión, con existencia > 0 | | | |

- [ ] **Importar el `.xls` en la aplicación**, despachar un contador, contar
      **solo** A y C:
      - A con una cantidad distinta de su existencia;
      - C con `0` («Está vacío»);
      - B **sin tocar** — ni contarla ni exonerarla. Tiene que llegar al archivo
        por la política, que es lo que se está probando;
      - D **exonerada** por el administrador en Revisión, con un motivo.
- [ ] **Sellar y generar el archivo.** Anotar `fileHash` (los primeros ocho van
      en el nombre): `________`
- [ ] **Comprobar el archivo antes de subirlo**: abrir `tools/verificador.html`,
      darle el `sesion_<id>.json` y el `.txt`, y confirmar que todo dice OK.
- [ ] **Subir el `.txt` a Zeus** y revisar dentro de Zeus, **antes de fusionar**,
      que el documento propuesto dice lo que se espera.
- [ ] **Fusionar y leer los saldos de nuevo.**

      | fila | esperado (con `'zero'`) | observado |
      |---|---|---|
      | A | el saldo pasa a la cantidad contada | |
      | B | el saldo queda en `0` — la política | |
      | C | el saldo queda en `0` — el conteo | |
      | D | **el saldo no se mueve** | |

- [ ] **Si D se movió, parar.** Exonerar no significa lo que este proyecto cree
      y ninguna sesión real puede correr hasta entenderlo.
- [ ] **Si B o C no quedaron en `0`, parar.** §7.4 es falso: un cero no borra el
      saldo, y la política `'zero'` no hace lo que se decidió que hiciera.
      En los dos casos, registrar qué pasó y abrir el asunto en ZEUS_FORMAT.md
      §7 como una pregunta, no como una nota.
- [ ] **Registrar el resultado en ZEUS_FORMAT.md §7.6**, con la fecha, quién lo
      hizo, la bodega y las cuatro filas. Un resultado que solo vive en la memoria
      de quien lo hizo es la misma clase de vacío que este documento existe para
      cerrar.

---

## Opción 2 — la primera corrida supervisada

Aceptable si la opción 1 no se pudo hacer. **Es más débil**: prueba lo mismo pero
sobre datos reales, con un solo intento y sin manera de repetirlo, y la revisión
tiene que hacerse sobre miles de filas en vez de cuatro.

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
- [ ] **Elegir cinco filas exoneradas**, de familias distintas, y comprobar una
      por una que el documento propuesto **no mueve su saldo**. Anotarlas:
      `____________________________________________`
- [ ] **Elegir cinco filas que nadie contó ni exoneró** y comprobar que el
      documento propuesto las lleva a `0`. Con `'zero'` eso es lo esperado, y
      son bajas de inventario: el acta dice cuántas son y cuánto valen
      («sin contar»). Si ese número sorprende a alguien, parar antes de fusionar.
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
