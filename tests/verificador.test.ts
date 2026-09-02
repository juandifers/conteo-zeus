/**
 * The verifier — P2.5 §4b, and the tests that make it real.
 *
 * `tools/verificador.html` is a single self-contained file with no imports. It
 * duplicates the SHA-256, the canonicalisation, the chaining and the fold, on
 * purpose: if it imported the code that produced the hashes it would agree with
 * them by construction and would prove nothing.
 *
 * **That duplication is exactly what these tests are for.** A second
 * implementation is worth having only while it is known to agree, and the way
 * to know is to build a bundle with `src/domain/` and hand it to the verifier's
 * own functions — the ones the browser runs, read out of the file, not a copy
 * kept beside it.
 *
 * A round trip is the easy half. The half that matters is the four mutations: a
 * verifier that says «no coincide» without saying *where* is not producing a
 * finding, it is producing an accusation.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  actionGenesisHash,
  chainActionHash,
  chainHash,
  codigoSello,
  genesisHash,
  sessionHash,
  type CountEvent,
} from '../src/domain';
import {
  parseZeusBytes,
  sourceHashOf,
  writeAdjustment,
  type SessionBundle,
} from '../src/app';
import { parseXls, reencode } from '../src/zeus';
import { readSample, SAMPLE_XLS } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFICADOR = join(HERE, '..', 'tools', 'verificador.html');

interface Check {
  ok: boolean;
  titulo: string;
  where: string;
}

interface Verificador {
  verify(bundle: unknown, txtBytes: Uint8Array | null): Check[];
  sha256Hex(bytes: Uint8Array): string;
  codigoSello(sessionHash: string): string;
}

/**
 * Load the verifier's script out of the HTML and run it.
 *
 * The script, not a re-export: what is under test is the file somebody opens in
 * a browser in 2029, and a test that exercised anything else would be testing a
 * copy. `runInNewContext` gives it a global object with no `document`, which is
 * why the page-wiring half of the file is guarded on `getElementById`.
 */
function loadVerificador(): Verificador {
  const html = readFileSync(VERIFICADOR, 'utf8');
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('tools/verificador.html has no <script> block');
  const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder, console };
  sandbox.globalThis = sandbox;
  runInNewContext(match[1], sandbox, { filename: 'verificador.html' });
  const api = sandbox.__verificador as Verificador | undefined;
  if (!api) throw new Error('verificador.html did not expose __verificador');
  return api;
}

// --- A sealed session, built with the real domain ---------------------------

const SESSION = 'ff000001-0000-4000-8000-000000000000';
const ANA = 'aa000001-0000-4000-8000-000000000000';
const LUIS = 'bb000001-0000-4000-8000-000000000000';
const EPOCH = Date.UTC(2026, 8, 1, 14, 0, 0);

interface WireEvent {
  id: string;
  sessionId: string;
  counterId: string;
  seq: number;
  kind: string;
  idarticulo: number | null;
  cantidad: string | null;
  retractsEventId: string | null;
  motivo: string | null;
  texto: string | null;
  finalSeq: number | null;
  headHash: string | null;
  usuario: string;
  zona: string;
  clientAt: string;
  deviceId: string;
  prevHash: string;
  hash: string;
}

let nextEvent = 0;
const eventId = () => `e${String(++nextEvent).padStart(7, '0')}-0000-4000-8000-000000000000`;

/**
 * Chain one counter's events the way the device and the server both do, and
 * hand back the wire rows the bundle carries.
 *
 * Built through `src/domain/chain.ts` — the implementation the verifier is
 * being held against. Writing the hashes by hand here would test the fixture.
 */
function chainOf(
  counterId: string,
  zona: string,
  specs: readonly { kind: CountEvent['kind']; idarticulo?: number; qty?: number; texto?: string }[],
): WireEvent[] {
  let prev = genesisHash(SESSION, counterId);
  const rows: WireEvent[] = [];
  for (const [index, spec] of specs.entries()) {
    const seq = index + 1;
    const base = {
      id: eventId(),
      sessionId: SESSION,
      counterId,
      usuario: counterId === ANA ? 'Ana' : 'Luis',
      zona,
      at: new Date(EPOCH + seq * 1000).toISOString(),
      deviceId: 'tablet-a',
      seq,
    };
    const event = {
      ...base,
      kind: spec.kind,
      idarticulo: spec.idarticulo ?? null,
      ...(spec.qty === undefined ? {} : { qty: spec.qty }),
      ...(spec.texto === undefined ? {} : { texto: spec.texto }),
    } as CountEvent;
    const hash = chainHash(prev, event);
    rows.push({
      id: base.id,
      sessionId: SESSION,
      counterId,
      seq,
      kind: spec.kind,
      idarticulo: spec.idarticulo ?? null,
      cantidad: spec.qty === undefined ? null : String(spec.qty),
      retractsEventId: null,
      motivo: null,
      texto: spec.texto ?? null,
      finalSeq: null,
      headHash: null,
      usuario: base.usuario,
      zona,
      clientAt: base.at,
      deviceId: base.deviceId,
      prevHash: prev,
      hash,
    });
    prev = hash;
  }
  return rows;
}

interface Sealed {
  bundle: SessionBundle;
  txt: Uint8Array;
  counted: Map<number, number>;
}

/** A whole sealed session: catalogue, two chains, one waiver, and the file. */
function sealedSession(): Sealed {
  nextEvent = 0;
  const bytes = reencode(parseXls(readSample(SAMPLE_XLS)));
  const file = parseZeusBytes(bytes);
  const sourceHash = sourceHashOf(file);
  const ids = file.items.map((item) => item.idarticulo);

  const ana = chainOf(ANA, 'ALMACEN', [
    { kind: 'add', idarticulo: ids[0], qty: 7 },
    { kind: 'add', idarticulo: ids[0], qty: 0.5 },
    { kind: 'add', idarticulo: ids[1], qty: 0 },
    { kind: 'note', idarticulo: ids[2], texto: 'hay una caja sin marcar' },
  ]);
  const luis = chainOf(LUIS, 'BAR', [{ kind: 'add', idarticulo: ids[200], qty: 3 }]);
  const eventos = [...ana, ...luis];

  // One waiver, on a row nobody counted. It projects to `unchanged`, which under
  // the verified triple writes the same bytes as an untouched row — the file
  // cannot tell them apart, and the bundle can.
  const waivedId = ids[50];
  const action = {
    id: 'cc000001-0000-4000-8000-000000000000',
    sessionId: SESSION,
    seq: 1,
    kind: 'waiver',
    payload: { idarticulo: [waivedId], motivo: 'no alcanzó el turno' },
    usuario: 'Marta',
    at: new Date(EPOCH + 9000).toISOString(),
  };
  const actionHead = chainActionHash(actionGenesisHash(SESSION), action);

  const counted = new Map<number, number>([
    [ids[0], 7.5],
    [ids[1], 0],
    [ids[200], 3],
    // The waived row resolves to `unchanged`, which the export writes as the
    // book figure.
    [waivedId, file.items.find((item) => item.idarticulo === waivedId)!.existencia],
  ]);
  const written = writeAdjustment(file, new Map(counted), {
    countTargetColumn: 'toma',
    uncountedPolicy: 'existencia',
    differenceColumn: 'computed',
  });

  const counters = [
    { id: ANA, nombre: 'Ana', maxSeq: ana.length, headHash: ana[ana.length - 1].hash },
    { id: LUIS, nombre: 'Luis', maxSeq: luis.length, headHash: luis[luis.length - 1].hash },
  ];

  const bundle: SessionBundle = {
    formato: 'conteo-zeus/bundle/v1',
    sesion: {
      id: SESSION,
      bodega: file.bodega ?? '22',
      fechaCorte: file.fecha ?? '2026/08/28',
      nombre: null,
      estado: 'cerrado',
      sourceName: 'COMESTIBLES ALMACEN.xls',
      sourceHash,
      createdAt: new Date(EPOCH).toISOString(),
      dispatchedAt: new Date(EPOCH).toISOString(),
      sealedAt: new Date(EPOCH + 10_000).toISOString(),
      exportedAt: new Date(EPOCH + 11_000).toISOString(),
      parameters: {
        countTargetColumn: 'toma',
        uncountedPolicy: 'existencia',
        differenceColumn: 'computed',
      },
    },
    catalogo: file.items.map((item) => ({
      idarticulo: item.idarticulo,
      codigo: item.codigo,
      nombre: item.nombre,
      presentacion: item.presentacion,
      existencia: String(item.existencia),
      costo: String(item.costo),
      ultimoConteo: null,
      rawRow: item.rawRow,
    })),
    contadores: counters.map((counter) => ({
      id: counter.id,
      nombre: counter.nombre,
      estado: 'terminado_confirmado',
      finalSeq: counter.maxSeq,
      headHash: counter.headHash,
      finishReason: null,
      fetchedAt: new Date(EPOCH).toISOString(),
      lastServerAt: new Date(EPOCH + 5000).toISOString(),
      deviceIds: ['tablet-a'],
      clockSkewMs: 0,
      forked: false,
    })),
    eventos,
    acciones: [
      {
        ...action,
        serverAt: action.at,
        prevHash: actionGenesisHash(SESSION),
        hash: actionHead,
      },
    ],
    sellos: {
      sessionHash: sessionHash({
        sessionId: SESSION,
        sourceHash,
        counters: counters.map((counter) => ({
          counterId: counter.id,
          maxSeq: counter.maxSeq,
          headHash: counter.headHash,
        })),
        actionHead,
        actionMaxSeq: 1,
      }),
      fileHash: written.fileHash,
      contadores: counters.map((counter) => ({
        counterId: counter.id,
        maxSeq: counter.maxSeq,
        headHash: counter.headHash,
      })),
      actionHead,
      actionMaxSeq: 1,
    },
  };

  return { bundle, txt: written.bytes, counted };
}

/** A deep copy, so a mutation in one test cannot leak into the next. */
const copy = (bundle: SessionBundle): SessionBundle =>
  JSON.parse(JSON.stringify(bundle)) as SessionBundle;

const failures = (checks: Check[]) => checks.filter((check) => !check.ok);
const said = (checks: Check[]) =>
  failures(checks)
    .map((check) => `${check.titulo} ${check.where}`)
    .join(' | ');

let verificador: Verificador;
let sealed: Sealed;

beforeAll(() => {
  verificador = loadVerificador();
  sealed = sealedSession();
});

describe('the round trip', () => {
  it('verifies a sealed session and its file, end to end', () => {
    const checks = verificador.verify(copy(sealed.bundle), sealed.txt);
    expect(said(checks)).toBe('');
    // The five things it claims to check, each of them present as a yes.
    const titles = checks.map((check) => check.titulo).join(' | ');
    expect(titles).toMatch(/Cadena de Ana/);
    expect(titles).toMatch(/Cadena de decisiones/);
    expect(titles).toMatch(/sessionHash/);
    expect(titles).toMatch(/fileHash/);
    expect(titles).toMatch(/representación correcta/);
  });

  it('reaches the same digests as `src/domain/`, which is the point of duplicating them', () => {
    // If the two ever disagree, one of them is wrong and the disagreement is
    // the finding. This is that check, run on every commit rather than
    // discovered in three years by somebody holding a printout.
    expect(verificador.sha256Hex(sealed.txt)).toBe(sealed.bundle.sellos.fileHash);
  });

  it('derives the same código de verificación the acta prints', () => {
    // The one thing a non-technical reader compares: eight characters, on the
    // paper and on the green verdict. Both sides derive it from `sessionHash`,
    // and this is the assertion that they derive the same one.
    const hash = sealed.bundle.sellos.sessionHash;
    expect(verificador.codigoSello(hash)).toBe(codigoSello(hash));
    // Crockford base32: no I, L, O or U to misread, grouped for the phone.
    expect(verificador.codigoSello(hash)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('folds the same counts the file carries, waiver and all', () => {
    const checks = verificador.verify(copy(sealed.bundle), sealed.txt);
    const fold = checks.find((check) => check.titulo.startsWith('Plegado'))!;
    // Three counted articles, one waived, and the sentence about what the other
    // rows will claim — because a verifier that reported only hashes would let
    // somebody believe the file says «we did not look».
    expect(fold.titulo).toMatch(/3 filas contadas, 1 exoneradas/);
    expect(fold.where).toMatch(/como si se hubieran contado y coincidido/);
  });

  it('verifies the bundle alone, without the .txt', () => {
    expect(said(verificador.verify(copy(sealed.bundle), null))).toBe('');
  });
});

describe('every mutation class fails, and says where', () => {
  it('a changed quantity: names the counter and the seq', () => {
    const bundle = copy(sealed.bundle);
    const target = bundle.eventos[0];
    target.cantidad = '70';

    const checks = verificador.verify(bundle, sealed.txt);
    const broken = failures(checks);
    expect(broken.length).toBeGreaterThan(0);
    const first = broken[0];
    expect(first.titulo).toMatch(/Cadena de Ana/);
    expect(first.where).toMatch(new RegExp(`seq ${target.seq}\\b`));
    expect(first.where).toContain(target.id);
    // And the seal fails with it, because the recomputed head is not the sealed
    // one — a tampered event cannot be hidden by leaving the digests alone.
    expect(said(checks)).toMatch(/sessionHash/);
  });

  it('a changed byte in the .txt: names the offset', () => {
    const tampered = new Uint8Array(sealed.txt);
    // The first digit of the first row's `toma` — column index 4, so the byte
    // after the fifth tab. One digit is enough to move a balance in an ERP.
    let offset = -1;
    for (let tabs = 0; tabs < 4; tabs++) offset = tampered.indexOf(0x09, offset + 1);
    offset += 1;
    tampered[offset] = tampered[offset] === 0x39 ? 0x38 : tampered[offset] + 1;

    const checks = verificador.verify(copy(sealed.bundle), tampered);
    const broken = failures(checks);
    expect(broken.some((check) => check.titulo.startsWith('fileHash'))).toBe(true);
    // The hash says «not this file». The rendering check says which byte, which
    // is the difference between a refusal and a finding.
    const located = broken.find((check) => check.where.includes('byte'));
    expect(located).toBeTruthy();
    expect(located!.where).toMatch(/fila 1\b/);
  });

  it('two events with their hashes swapped', () => {
    const bundle = copy(sealed.bundle);
    const a = bundle.eventos[0];
    const b = bundle.eventos[1];
    const held = a.hash;
    a.hash = b.hash;
    b.hash = held;

    const broken = failures(verificador.verify(bundle, sealed.txt));
    expect(broken[0].titulo).toMatch(/Cadena de Ana/);
    expect(broken[0].where).toMatch(/seq 1\b/);
  });

  it('a truncated chain: names the gap', () => {
    const bundle = copy(sealed.bundle);
    // Ana's seq 2 disappears. The remaining links are individually well formed,
    // which is exactly why the check has to be about the sequence and not only
    // about each hash.
    bundle.eventos = bundle.eventos.filter(
      (event) => !(event.counterId === ANA && event.seq === 2),
    );

    const broken = failures(verificador.verify(bundle, sealed.txt));
    const gap = broken.find((check) => check.titulo.includes('falta un tramo'));
    expect(gap).toBeTruthy();
    expect(gap!.where).toMatch(/se esperaba seq 2/);
  });

  it('a tail cut off the end: caught by the length in the seal', () => {
    const bundle = copy(sealed.bundle);
    bundle.eventos = bundle.eventos.filter(
      (event) => !(event.counterId === ANA && event.seq === 4),
    );
    const broken = failures(verificador.verify(bundle, sealed.txt));
    // No gap — the chain 1..3 is contiguous and every link verifies. What
    // catches it is `maxSeq` being inside `sessionHash`.
    expect(broken.some((check) => check.titulo.includes('otra longitud'))).toBe(true);
    expect(broken.some((check) => check.titulo.startsWith('sessionHash'))).toBe(true);
  });

  it('a changed `sourceHash`: the seal no longer matches the catalogue', () => {
    const bundle = copy(sealed.bundle);
    bundle.sesion.sourceHash = 'f'.repeat(64);
    const broken = failures(verificador.verify(bundle, sealed.txt));
    expect(broken.some((check) => check.titulo.startsWith('sessionHash'))).toBe(true);
  });

  it('a changed action payload: the decision chain says which seq', () => {
    const bundle = copy(sealed.bundle);
    (bundle.acciones[0].payload as { motivo: string }).motivo = 'otra cosa';
    const broken = failures(verificador.verify(bundle, sealed.txt));
    expect(broken[0].titulo).toMatch(/Cadena de decisiones/);
    expect(broken[0].where).toMatch(/seq 1\b/);
  });

  it('a reordered .txt: names the row and the article it found there', () => {
    const bundle = copy(sealed.bundle);
    // The catalogue's order is swapped rather than the file's, which is the same
    // disagreement seen from the other side — and the side an auditor would hit
    // if somebody re-sorted the export in Excel (ZEUS_FORMAT.md §5).
    const held = bundle.catalogo[0];
    bundle.catalogo[0] = bundle.catalogo[1];
    bundle.catalogo[1] = held;

    const broken = failures(verificador.verify(bundle, sealed.txt));
    const order = broken.find((check) => check.titulo.includes('otro orden'));
    expect(order).toBeTruthy();
    expect(order!.where).toMatch(/fila 1 · byte \d+/);
  });

  it('a file that is not a bundle at all', () => {
    const checks = verificador.verify({ hola: true }, null);
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].titulo).toMatch(/no es un paquete/);
  });
});

describe('what the file itself must be', () => {
  const html = readFileSync(VERIFICADOR, 'utf8');
  /**
   * The file with its prose removed.
   *
   * Asserted on the code and not on the text, because the text is *supposed* to
   * name `src/domain/chain.ts` and `crypto.subtle` — it explains why it
   * duplicates the first and refuses the second. A structural rule that fired
   * on an explanation of itself would be a rule nobody could document.
   */
  const code = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('is standalone: no imports, no network, no build step', () => {
    // The situation in which somebody reaches for this is the situation in
    // which the application may be gone. Anything it has to fetch is a
    // dependency on a world that no longer exists.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(code).not.toMatch(/\bimport\s|\brequire\(|\bfetch\(|XMLHttpRequest|WebSocket/);
  });

  it('shares no code with `src/domain/`, which is what makes it evidence', () => {
    // Structural, not a review comment: if the verifier imported the module
    // that produced the hashes it would agree with it by construction. A
    // duplicate here is correct.
    expect(code).not.toContain('src/domain');
    expect(code).not.toContain('../src');
  });

  it('carries its own SHA-256 rather than `crypto.subtle`', () => {
    // `crypto.subtle` is async and only exists in secure contexts, and this file
    // is opened over `file://`. A verifier that needs HTTPS needs a server.
    expect(code).not.toContain('crypto.subtle');
    expect(code).toContain('function sha256Hex');
  });

  it('is small enough to read, which is the only real audit of a verifier', () => {
    expect(html.length).toBeLessThan(80_000);
  });
});
