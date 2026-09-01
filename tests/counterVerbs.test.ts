/**
 * The three verbs a counter has, and what they do all the way to the file.
 *
 *     registrar cantidad   add(qty)     «encontré 8»
 *     registrar cero       add(0)       «fui al estante, está vacío»
 *     nota                 note(texto)  «3 cajas sin código arriba»
 *
 * plus scoped `retract` from Mis registros. That is the whole vocabulary
 * (P2.3), and this file is about the second one, because `add(0)` is the
 * primitive whose correctness is not obvious.
 *
 * It folds to `(current ?? 0) + 0`. First entry on an untouched article →
 * `counted` at 0, which writes `0` to `toma`, which zeroes the balance
 * (DOMAIN.md §7.4) — correct, and what the counter meant. A later entry on an
 * article already at 5 → still 5, also correct: *this other location* is empty
 * and adds nothing. The counter cannot tell which case they are in and does not
 * need to; both are right, which is why the copy on the screen says «este
 * lugar» and not «este artículo».
 *
 * `unchanged` is the one that is gone. A waiver asserts the book figure is
 * right without counting, and the counter has never seen the book figure — so
 * the sentence has no referent on their tablet. It is still written by the P1
 * app and by the supervisor's bulk waiver, and both still resolve to
 * `existencia`; what changed is who may say it.
 */
import { describe, expect, it } from 'vitest';

import { exportAdjustment, importZeusFile } from '../src/app';
import { resolve, type CountEvent, type Session } from '../src/domain';
import { decodeCp850, parseXls } from '../src/zeus';
import { COL } from '../src/zeus/types';
import { SAMPLE_XLS, readSample } from './helpers';

const SOURCE = parseXls(readSample(SAMPLE_XLS));
const SESSION = 'session-verbs';

/** MELON / KILO — booked at zero. PANCETA SV / KILO — booked at 97.5. */
const MELON = 77;
const PANCETA = 1181;

function newSession(): Session {
  return importZeusFile(SOURCE, { id: SESSION, createdAt: '2026-08-25T09:00:00.000Z' });
}

const EPOCH = Date.UTC(2026, 7, 31, 10, 0, 0);
let seq = 0;

function add(idarticulo: number, qty: number): CountEvent {
  const n = seq++;
  return {
    id: `ev-${n}`,
    sessionId: SESSION,
    counterId: 'counter-ana',
    idarticulo,
    usuario: 'ana',
    zona: 'Cuarto frío proteínas',
    at: new Date(EPOCH + n * 1000).toISOString(),
    deviceId: 'tablet-1',
    seq: n + 1,
    kind: 'add',
    qty,
  };
}

describe('add(0) is «this location is empty»', () => {
  it('on an untouched article, resolves to a counted zero', () => {
    // Not `untouched`, which blocks a post, and not a fourth state. A quantity
    // of zero is a quantity (§2).
    expect(resolve([add(MELON, 0)])).toEqual({ state: 'counted', qty: 0 });
  });

  it('on an article already at 5, leaves it at 5', () => {
    expect(resolve([add(PANCETA, 5), add(PANCETA, 0)])).toEqual({ state: 'counted', qty: 5 });
    // And the order does not matter, which is the whole of P2's fold argument.
    expect(resolve([add(PANCETA, 0), add(PANCETA, 5)])).toEqual({ state: 'counted', qty: 5 });
  });

  it('writes 0 into toma, which is what zeroes the balance in Zeus', () => {
    const session = newSession();
    // Everything else waived by the supervisor, so the file can be generated at
    // all — `uncountedPolicy: 'reject'` refuses a hole (§7.4).
    const events: CountEvent[] = [add(MELON, 0), add(PANCETA, 0)];
    for (const item of session.items) {
      if (item.idarticulo === MELON || item.idarticulo === PANCETA) continue;
      const n = seq++;
      events.push({
        id: `w-${n}`,
        sessionId: SESSION,
        idarticulo: item.idarticulo,
        usuario: 'marta',
        zona: '',
        at: new Date(EPOCH + n * 1000).toISOString(),
        deviceId: 'tablet-1',
        seq: n + 1,
        kind: 'unchanged',
        motivo: 'revisión de escritorio',
      });
    }

    const after = decodeCp850(exportAdjustment(session, events, { file: SOURCE })).split('\r\n');
    const row = (idarticulo: number) =>
      after[SOURCE.items.findIndex((item) => item.idarticulo === idarticulo)].split('\t');

    // MELON is booked at zero, so a counted zero is no variance at all.
    expect(row(MELON)[COL.toma]).toBe('0');
    expect(row(MELON)[COL.diferencia]).toBe('0');
    // PANCETA is booked at 97.5, so a counted zero is the whole balance gone —
    // which is exactly why the screen asks twice before writing one.
    expect(row(PANCETA)[COL.toma]).toBe('0');
    expect(row(PANCETA)[COL.diferencia]).toBe('-97.5');
  });
});
