/**
 * The pilot's only instrumentation.
 *
 * These assert the shape rather than the numbers, because the numbers are the
 * point: the export exists so that questions nobody has thought of yet can be
 * asked of a real count. What has to hold is that every event survives, that
 * the columns mean what they say, and that a name with a comma or a quote in it
 * does not silently shift every field after it by one.
 */
import { describe, expect, it } from 'vitest';
import { addCount, markUnchanged, retract, setCount } from '../domain/factory';
import type { Item } from '../../src/domain';
import type { BuildStamp } from '../../src/ui/build';
import {
  debugExportName,
  encodeCsv,
  eventLogCsv,
  type SessionLog,
} from '../../src/ui/debugExport';
import { ID, sampleSession } from './harness';

const BUILD: BuildStamp = { commit: 'a1b2c3d', at: '2026-08-27T09:00:00.000Z' };

const SESSION = sampleSession();

function log(events: SessionLog['events'], items: readonly Item[] = SESSION.items): SessionLog {
  return {
    sessionId: SESSION.id,
    bodega: SESSION.bodega,
    fechaCorte: SESSION.fechaCorte,
    items,
    events,
  };
}

/** Split a CSV the way a parser would, honouring the quoting. */
function rows(csv: string): string[][] {
  return csv
    .trimEnd()
    .split('\r\n')
    .map((line) => {
      const fields: string[] = [];
      let field = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
          if (c === '"' && line[i + 1] === '"') {
            field += '"';
            i++;
          } else if (c === '"') quoted = false;
          else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') {
          fields.push(field);
          field = '';
        } else field += c;
      }
      fields.push(field);
      return fields;
    });
}

const column = (csv: string, name: string): string[] => {
  const table = rows(csv);
  const at = table[0].indexOf(name);
  expect(at, `column ${name}`).toBeGreaterThanOrEqual(0);
  return table.slice(1).map((row) => row[at]);
};

describe('the event log as a spreadsheet', () => {
  it('writes one row per event, whatever its kind', () => {
    const csv = eventLogCsv(
      [
        log([
          setCount(ID.melon, 12, { sessionId: SESSION.id }),
          addCount(ID.melon, 1, { sessionId: SESSION.id }),
          retract(ID.melon, { sessionId: SESSION.id }),
          markUnchanged(ID.panTajado, { sessionId: SESSION.id, motivo: 'sellado' }),
        ]),
      ],
      BUILD,
    );
    expect(rows(csv)).toHaveLength(5); // header + four events
    expect(column(csv, 'kind')).toEqual(['set', 'add', 'retract', 'unchanged']);
  });

  it('names the article, so a reader never has to join against the catalogue', () => {
    const csv = eventLogCsv([log([setCount(ID.melon, 12, { sessionId: SESSION.id })])], BUILD);
    const melon = SESSION.items.find((item) => item.idarticulo === ID.melon)!;
    expect(column(csv, 'codigo')).toEqual([melon.codigo]);
    expect(column(csv, 'nombre')).toEqual([melon.nombre]);
  });

  /**
   * A waiver carries no quantity, and the column has to stay empty rather than
   * printing a zero. `0` in this column would read as "somebody counted
   * nothing", which is a different thing from "somebody declined to count"
   * (DOMAIN.md §2) — and the difference is the whole reason the two kinds are
   * separate events.
   */
  it('leaves qty empty on the events that carry none, rather than writing zero', () => {
    const csv = eventLogCsv(
      [
        log([
          markUnchanged(ID.melon, { sessionId: SESSION.id }),
          retract(ID.melon, { sessionId: SESSION.id }),
          setCount(ID.melon, 0, { sessionId: SESSION.id }),
        ]),
      ],
      BUILD,
    );
    expect(column(csv, 'qty')).toEqual(['', '', '0']);
  });

  it('carries the motivo of a waiver and nothing else', () => {
    const csv = eventLogCsv(
      [
        log([
          markUnchanged(ID.melon, { sessionId: SESSION.id, motivo: 'caja sellada' }),
          markUnchanged(ID.panTajado, { sessionId: SESSION.id }),
        ]),
      ],
      BUILD,
    );
    expect(column(csv, 'motivo')).toEqual(['caja sellada', '']);
  });

  it('orders rows the way the fold orders them, not the way they arrived', () => {
    // Handed over out of order, and from two devices stamping the same instant.
    const later = setCount(ID.melon, 2, {
      sessionId: SESSION.id,
      at: '2026-08-25T11:00:00.000Z',
      deviceId: 'tablet-b',
      seq: 0,
    });
    const earlier = setCount(ID.melon, 1, {
      sessionId: SESSION.id,
      at: '2026-08-25T10:00:00.000Z',
      deviceId: 'tablet-a',
      seq: 0,
    });
    const csv = eventLogCsv([log([later, earlier])], BUILD);
    expect(column(csv, 'at')).toEqual([
      '2026-08-25T10:00:00.000Z',
      '2026-08-25T11:00:00.000Z',
    ]);
  });

  it('stamps every row with the build that wrote it', () => {
    const csv = eventLogCsv([log([setCount(ID.melon, 1, { sessionId: SESSION.id })])], BUILD);
    expect(column(csv, 'buildCommit')).toEqual(['a1b2c3d']);
    expect(column(csv, 'buildTime')).toEqual(['2026-08-27T09:00:00.000Z']);
    expect(column(csv, 'sessionId')).toEqual([SESSION.id]);
  });

  it('covers every session on the tablet, because the comparisons are across counts', () => {
    const other: SessionLog = {
      ...log([setCount(ID.melon, 5, { sessionId: 'otra' })]),
      sessionId: 'otra',
      bodega: '0002',
    };
    const csv = eventLogCsv(
      [log([setCount(ID.panTajado, 3, { sessionId: SESSION.id })]), other],
      BUILD,
    );
    expect(column(csv, 'sessionId')).toEqual([SESSION.id, 'otra']);
    expect(column(csv, 'bodega')).toEqual([SESSION.bodega, '0002']);
  });

  /**
   * The one way a CSV goes silently wrong: a field containing the separator
   * shifts every column after it, and nothing complains — the file opens, the
   * numbers are just in the wrong columns.
   */
  it('quotes a name that carries a comma or a quote', () => {
    const awkward: Item = {
      ...SESSION.items[0],
      idarticulo: 999_001,
      codigo: '9990001',
      nombre: 'AJI, CHIPOTLE "AMAZON"',
    };
    const csv = eventLogCsv(
      [log([setCount(999_001, 1, { sessionId: SESSION.id })], [awkward])],
      BUILD,
    );
    expect(csv).toContain('"AJI, CHIPOTLE ""AMAZON"""');
    expect(column(csv, 'nombre')).toEqual(['AJI, CHIPOTLE "AMAZON"']);
    // And the columns after it are still the columns after it.
    expect(column(csv, 'kind')).toEqual(['set']);
  });

  /**
   * A re-import makes a new session (DOMAIN.md §6), and a log can outlive the
   * item list it was taken against. Losing the rows would lose exactly the
   * history somebody is trying to reconstruct.
   */
  it('keeps an event whose article is no longer in the session', () => {
    const csv = eventLogCsv([log([setCount(999_999, 4, { sessionId: SESSION.id })])], BUILD);
    expect(column(csv, 'idarticulo')).toEqual(['999999']);
    expect(column(csv, 'nombre')).toEqual(['']);
    expect(column(csv, 'qty')).toEqual(['4']);
  });

  it('writes a header even when nothing has been counted', () => {
    const csv = eventLogCsv([log([])], BUILD);
    expect(rows(csv)).toHaveLength(1);
    expect(rows(csv)[0]).toContain('idarticulo');
  });

  /**
   * Machine decimals, not Colombian ones — the opposite of every other number
   * in the product. `1,5` in a comma-separated file is two fields.
   */
  it('writes quantities with a dot, not the separator the screens use', () => {
    const csv = eventLogCsv([log([setCount(ID.melon, 234.8, { sessionId: SESSION.id })])], BUILD);
    expect(column(csv, 'qty')).toEqual(['234.8']);
  });
});

describe('the bytes handed to the browser', () => {
  it('leads with a UTF-8 BOM, so Excel does not mangle every Ñ', () => {
    const bytes = encodeCsv('nombre\r\nÑAME\r\n');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('nombre\r\nÑAME\r\n');
  });

  it('names the file by the day and the build that wrote it', () => {
    expect(debugExportName('2026-08-27', BUILD)).toBe('conteo-log-2026-08-27-a1b2c3d.csv');
  });
});
