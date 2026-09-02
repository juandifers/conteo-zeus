// @vitest-environment jsdom
/**
 * The counting screens, end to end on a tablet — P2.3.
 *
 * The first `describe` is the requirement, so it is tested like one. **No
 * running total for any article is rendered anywhere in the counting path**
 * (DOMAIN.md §2.1), and the way to assert that is not to check a component's
 * props: it is to take a counter who has three standing entries on one article,
 * walk every surface they can reach, and search the rendered text for the sum.
 * As a substring, because `13` hides inside `2.130` and inside a `codigo`.
 *
 * The mechanism being protected against is anchoring *during the act of
 * counting*: you see 5, the stack in front of you looks eight-ish, and you
 * reconcile toward a number that feels right. Anything revealing magnitude
 * reopens it — including a badge reading «3 registros», since entry counts
 * correlate with how big a stack is.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryChain, MemoryRepository, type CounterPayload } from '../../src/domain';
import type { AssignmentStore } from '../../src/store';
import type { CounterAssignmentRow } from '../../src/store/db';
import type { Api } from '../../src/ui/api';
import { CounterScreen } from '../../src/ui/counter/CounterScreen';
import { COUNTER, samplePayload } from './counterHarness';
import { ID, SESSION_ID, sampleSession } from './harness';

afterEach(cleanup);

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaa';

/** An `AssignmentStore` in a variable. The tablet is «prepared» before it opens. */
function heldAssignment(payload: CounterPayload): AssignmentStore {
  let row: CounterAssignmentRow | null = {
    token: TOKEN,
    sessionId: payload.session.id,
    counterId: payload.counter.id,
    fetchedAt: '2026-08-31T12:00:00.000Z',
    payload,
  };
  return {
    save: async (token, fresh, fetchedAt) => {
      row = { token, sessionId: fresh.session.id, counterId: fresh.counter.id, fetchedAt, payload: fresh };
    },
    load: async () => row,
    list: async () => (row ? [row] : []),
  };
}

/**
 * The device's two stores, sharing what the real device shares.
 *
 * On a tablet `DexieCounterChain` and `DexieCountRepository` are two views of
 * **one** `countEvents` table (src/store/repository.ts), which is what lets a
 * reload hydrate the screen from the rows the chain wrote. The memory fakes
 * are separate stores, so the harness wires the chain through the way the
 * shared table does: a chained append is also a stored event.
 */
function sharedDevice() {
  const repo = new MemoryRepository();
  const chain = new MemoryChain();
  const append = chain.appendChainedBatch.bind(chain);
  chain.appendChainedBatch = async (links) => {
    await append(links);
    for (const link of links) await repo.appendEvent(link.event);
  };
  return { repo, chain };
}

/**
 * A tablet in a bodega: the assignment is on the device, and the network is
 * not there. Every screen below therefore renders from Dexie alone, which is
 * the condition the whole product runs in.
 */
async function openTablet(
  options: {
    mostrarMarcaRegistrado?: boolean;
    brokenDatabase?: boolean;
    /** Articles somebody else registered before this tablet fetched (P2.3.5 §6b). */
    yaRegistrados?: readonly number[];
    /** A shared session (P2.6): the whole catalogue as one synthesized section. */
    compartido?: boolean;
    /** An existing device, for the reload tests: same stores, fresh screen. */
    device?: ReturnType<typeof sharedDevice>;
  } = {},
) {
  const payload = samplePayload(options);
  const { repo, chain } = options.device ?? sharedDevice();
  if (!options.device) await repo.createSession(sampleSession());
  if (options.brokenDatabase) {
    // A tablet whose IndexedDB has stopped taking writes. Not a hypothetical:
    // it is what a full disk or an evicted origin looks like from in here.
    chain.appendChainedBatch = async () => {
      throw new Error('IndexedDB dijo que no');
    };
  }
  const api: Api = {
    get: async () => {
      throw new Error('sin red');
    },
    post: async () => {
      throw new Error('sin red');
    },
    patch: async () => {
      throw new Error('sin red');
    },
  };
  const view = render(
    <CounterScreen
      token={TOKEN}
      api={api}
      assignments={heldAssignment(payload)}
      repo={repo}
      chain={chain}
    />,
  );
  const user = userEvent.setup();
  // Boot: the assignment read, the device identified, the chain started.
  await screen.findByRole('button', { name: 'Contar' });
  return { user, chain, repo, payload, unmount: () => view.unmount() };
}

const tab = (name: string) => screen.getByRole('button', { name });

async function registrar(user: ReturnType<typeof userEvent.setup>, query: string, qty: string) {
  await user.clear(screen.getByLabelText('buscar artículo'));
  await user.type(screen.getByLabelText('buscar artículo'), query);
  await user.click(await screen.findByRole('button', { name: new RegExp(query, 'i') }));
  await user.type(screen.getByLabelText(/cantidad contada/), qty);
  // One tap: «Registrar 4» is the write. There is no second «Sí, registrar».
  await user.click(screen.getByRole('button', { name: new RegExp(`^Registrar ${qty}$`) }));
}

describe('no running total is reachable in the counting path', () => {
  it('three entries on one article never show their sum, on any surface', async () => {
    const { user } = await openTablet();

    // PAN TAJADO, three times: 4 + 5 + 7. The sum is 16 and must not exist.
    await registrar(user, 'TAJADO', '4');
    await registrar(user, 'TAJADO', '5');
    await registrar(user, 'TAJADO', '7');

    // The clock is not a surface. `formatInstant` renders «01/09/2026, 04:16
    // p. m.», so a minute of 16, or a day or an hour of 18, would fail this
    // test for one minute in every sixty and on two days of every month. What
    // is being looked for is a running total, not a coincidence of digits.
    const clockless = (): string =>
      (document.body.textContent ?? '').replace(
        /\d{2}\/\d{2}\/\d{4},\s*\d{2}:\d{2}\s*[ap]\.\s*m\./g,
        '',
      );

    const surfaces: string[] = [];
    /** Search results, with the article already registered three times. */
    await user.clear(screen.getByLabelText('buscar artículo'));
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    surfaces.push(clockless());

    /** The entry card, opened for a fourth time. */
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    surfaces.push(clockless());

    /** The entry card, with a quantity typed and on the button. */
    await user.type(screen.getByLabelText(/cantidad contada/), '2');
    surfaces.push(clockless());
    await user.click(screen.getByRole('button', { name: /^Registrar 2$/ }));

    /** The toast, back on the search screen. */
    surfaces.push(clockless());

    /** Mis registros, and Terminar. */
    await user.click(tab('Mis registros'));
    surfaces.push(clockless());
    await user.click(tab('Terminar'));
    surfaces.push(clockless());

    for (const text of surfaces) {
      // 4 + 5 + 7 = 16, and 4 + 5 + 7 + 2 = 18. Neither is ever on screen.
      expect(text).not.toContain('16');
      expect(text).not.toContain('18');
    }
    // …and the individual entries are, where they should be: Mis registros.
    await user.click(tab('Mis registros'));
    const list = document.body.textContent ?? '';
    for (const each of ['4', '5', '7', '2']) expect(list).toContain(each);
  });

  it('the ✓ marker is binary — no count, no magnitude', async () => {
    const { user } = await openTablet();
    await registrar(user, 'TAJADO', '4');
    await registrar(user, 'TAJADO', '5');

    await user.clear(screen.getByLabelText('buscar artículo'));
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    const marks = await screen.findAllByLabelText('ya registraste algo aquí');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.textContent).toBe('✓');
    // Not «2 registros», which correlates with how big the stack was.
    expect(document.body.textContent).not.toMatch(/\d+\s*registros?\b(?!\s*sin subir)/);
  });

  it('is off entirely when the session says so', async () => {
    const { user } = await openTablet({ mostrarMarcaRegistrado: false });
    await registrar(user, 'TAJADO', '4');
    await user.clear(screen.getByLabelText('buscar artículo'));
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    expect(screen.queryByLabelText('ya registraste algo aquí')).toBeNull();
  });

  it('the entry field is never seeded from what is already recorded', async () => {
    // P1 pre-filled it with the running value so a second visit could be
    // corrected rather than retyped. On a shared shelf that pre-fill *is* the
    // anchor, so it is gone: correcting happens in Mis registros, by name.
    const { user } = await openTablet();
    await registrar(user, 'TAJADO', '9');
    await user.clear(screen.getByLabelText('buscar artículo'));
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    expect((screen.getByLabelText(/cantidad contada/) as HTMLInputElement).value).toBe('');
  });
});

describe('the three verbs, and the one that was removed', () => {
  it('registers a quantity in one tap — the button carries the number it will write', async () => {
    const { user, chain } = await openTablet();
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));

    // Nothing typed, nothing to tap: the confirmation *is* reading the button.
    expect((screen.getByRole('button', { name: 'Registrar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.type(screen.getByLabelText(/cantidad contada/), '8');

    // One tap. The second «Sí, registrar» that used to follow was pure
    // friction on a two-hundred-row afternoon; a wrong entry is corrected by
    // name in Mis registros, not prevented by asking everybody twice.
    await user.click(screen.getByRole('button', { name: /^Registrar 8$/ }));
    const held = await chain.unsynced(sampleSession().id, 'counter-ana', 10);
    expect(held.map((link) => link.event)).toMatchObject([
      { kind: 'add', qty: 8, idarticulo: ID.panTajado },
    ]);
  });

  it('still asks about a quantity with too many digits', async () => {
    const { user, chain } = await openTablet();
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    await user.type(screen.getByLabelText(/cantidad contada/), '80000');

    await user.click(screen.getByRole('button', { name: /^Registrar 80.000$/ }));
    expect(screen.getByText(/Es una cantidad poco común/)).toBeTruthy();
    expect(await chain.unsynced(sampleSession().id, 'counter-ana', 10)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Sí, es correcta' }));
    expect(await chain.unsynced(sampleSession().id, 'counter-ana', 10)).toHaveLength(1);
  });

  it('a zero is its own action with its own question', async () => {
    const { user, chain } = await openTablet();
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));

    await user.click(screen.getByRole('button', { name: /Está vacío/ }));
    expect(screen.getByText(/¿Confirmas que este lugar está vacío\?/)).toBeTruthy();
    // The copy says «lugar», not «artículo»: a later entry elsewhere still adds.
    expect(screen.getByText(/no que el artículo esté en cero/)).toBeTruthy();
    expect(await chain.unsynced(sampleSession().id, 'counter-ana', 10)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Sí, está vacío' }));
    const held = await chain.unsynced(sampleSession().id, 'counter-ana', 10);
    expect(held.map((link) => link.event)).toMatchObject([{ kind: 'add', qty: 0 }]);
  });

  it('offers no waiver anywhere a counter can reach', async () => {
    const { user } = await openTablet();
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    for (const label of [/sin verificar/i, /coincide con el sistema/i, /descartar conteo/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('stamps the section’s name as the zone, per article', async () => {
    // Two sections on one tablet, so a single `zona` string would be wrong for
    // most of the afternoon. `Section.nombre` *is* the zone (P2.1 §3c).
    const { user, chain } = await openTablet();
    await registrar(user, 'TAJADO', '3');
    await registrar(user, 'TILAPIA', '2');
    const held = await chain.unsynced(sampleSession().id, 'counter-ana', 10);
    const zonas = Object.fromEntries(held.map((link) => [link.event.idarticulo, link.event.zona]));
    expect(zonas[ID.panTajado]).toBe('Panadería');
    expect(zonas[ID.tilapia600]).toBe('Cuarto frío proteínas');
  });

  it('writes notes, keeps them, and does not let one close a gap', async () => {
    const { user, chain } = await openTablet();
    await user.click(tab('Notas'));
    await user.type(screen.getByLabelText('texto de la nota'), '3 cajas sin código arriba');
    await user.click(screen.getByRole('button', { name: 'Guardar nota' }));

    expect(await screen.findByText('3 cajas sin código arriba')).toBeTruthy();
    const held = await chain.unsynced(sampleSession().id, 'counter-ana', 10);
    expect(held.map((link) => link.event)).toMatchObject([
      { kind: 'note', texto: '3 cajas sin código arriba', idarticulo: null },
    ]);

    // Five assigned articles, five still in the gap list: a remark is the
    // reason to go back, not a substitute for going.
    await user.click(tab('Terminar'));
    expect(screen.getAllByRole('button', { name: /^contar / })).toHaveLength(5);
  });
});

describe('Mis registros corrects without hiding anything', () => {
  it('is chronological, and «Deshacer» leaves the row struck through', async () => {
    const { user, chain } = await openTablet();
    await registrar(user, 'TAJADO', '4');
    await registrar(user, 'TILAPIA', '6');

    await user.click(tab('Mis registros'));
    const rows = screen.getAllByRole('listitem');
    // Newest first, so the second entry heads the list — and the two are not
    // grouped by article, which would make an article's sum readable.
    expect(rows[0].textContent).toContain('TILAPIA');

    await user.click(within(rows[0]).getByRole('button', { name: 'Deshacer' }));
    const after = screen.getAllByRole('listitem');
    expect(after[0].className).toContain('row--withdrawn');
    expect(after[0].textContent).toContain('deshecho');
    expect(within(after[0]).queryByRole('button', { name: 'Deshacer' })).toBeNull();

    const kinds = (await chain.unsynced(sampleSession().id, 'counter-ana', 10)).map(
      (link) => link.event.kind,
    );
    expect(kinds).toEqual(['add', 'add', 'retract']);
  });

  it('«Corregir» appends a withdrawal and a replacement, both visible', async () => {
    const { user, chain } = await openTablet();
    await registrar(user, 'TAJADO', '4');

    await user.click(tab('Mis registros'));
    await user.click(screen.getByRole('button', { name: 'Corregir' }));
    await user.type(screen.getByLabelText(/nueva cantidad/), '7');
    await user.click(screen.getByRole('button', { name: 'Guardar corrección' }));

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('7');
    expect(rows[1].className).toContain('row--withdrawn');

    const held = await chain.unsynced(sampleSession().id, 'counter-ana', 10);
    expect(held.map((link) => link.event.kind)).toEqual(['add', 'retract', 'add']);
    // Contiguous: one transaction, one chain, no hole for the push to trip on.
    expect(held.map((link) => link.event.seq)).toEqual([1, 2, 3]);
  });

  it('offers no whole-item discard', async () => {
    const { user } = await openTablet();
    await registrar(user, 'TAJADO', '4');
    await user.click(tab('Mis registros'));
    expect(screen.queryByRole('button', { name: /Descartar/i })).toBeNull();
  });
});

/**
 * The tablet Pedro is handed at eleven — P2.3.5 §6b.
 *
 * Everything here is downstream of one field in the assignment payload: a list
 * of `idarticulo`s somebody had already registered when the device fetched. Ids
 * only, which is the same information the neutral checkmark already carries,
 * and the reason a set of them is admissible at all under §2.1.
 *
 * The behaviours it has to buy are the two the brief names, and they pull in
 * opposite directions: **do not send Pedro to recount sixty shelves Luis
 * already did**, and **do not stop him counting one when Luis was ill and his
 * numbers are suspect**.
 */
describe('a counter who inherited somebody else’s shelves', () => {
  /** `PAN TAJADO` and `PANCETA SV · KILO`, as if Luis had counted them. */
  const HEREDADOS = [ID.panTajado, ID.pancetaKilo];

  it('leaves them off the gap list rather than sending him to recount them', async () => {
    const { user } = await openTablet({ yaRegistrados: HEREDADOS });
    await user.click(tab('Terminar'));

    // Five articles in two sections; two of them were already registered.
    // Once in «Tu trabajo» and once in each section that has one.
    expect(screen.getAllByText('ya registrados por otra persona').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/^contar PAN TAJADO/)).toBeNull();
    // And the ones nobody has touched are still there to be counted.
    expect(screen.getByLabelText(/^contar PESCADO TILAPIA/)).toBeTruthy();
  });

  it('marks them, and says whose work it was', async () => {
    // Same glyph, because the counter's next action is the same. A different
    // label, because a screen reader saying «ya registraste algo aquí» about
    // Luis's shelf tells somebody they did something they did not do.
    const { user } = await openTablet({ yaRegistrados: HEREDADOS });
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    const row = await screen.findByRole('button', { name: /TAJADO/i });
    expect(within(row).getByLabelText('otra persona ya registró aquí')).toBeTruthy();
    expect(within(row).queryByLabelText('ya registraste algo aquí')).toBeNull();
  });

  it('asks once more before adding to somebody else’s number, and says so plainly', async () => {
    const { user } = await openTablet({ yaRegistrados: HEREDADOS });
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    await user.type(screen.getByLabelText(/cantidad contada/), '4');
    await user.click(screen.getByRole('button', { name: /^Registrar 4$/ }));

    // Not recorded yet: the one tap that would normally write runs into the
    // one ask that survived the confirm's removal, because this one is about
    // something abnormal — somebody else's number already on the article.
    expect(
      screen.getByText(/Otra persona ya registró este artículo. Tu cantidad se sumará a la suya./),
    ).toBeTruthy();
    // The sentence is the truth about the additive fold, and it carries no
    // number — not Luis's, not a total.
    await user.click(screen.getByRole('button', { name: /^Sí, sumar 4$/ }));
    await user.click(tab('Mis registros'));
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('lets him count one anyway — sometimes he should', async () => {
    const { user, chain } = await openTablet({ yaRegistrados: HEREDADOS });
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    await user.type(screen.getByLabelText(/cantidad contada/), '4');
    await user.click(screen.getByRole('button', { name: /^Registrar 4$/ }));
    await user.click(screen.getByRole('button', { name: /^Sí, sumar 4$/ }));

    // Back on the search screen, which is where the entry card leaves you and
    // therefore the point at which the write has been handed to the store.
    await screen.findByLabelText('buscar artículo');
    const written = chain.all(SESSION_ID, COUNTER);
    expect(written).toHaveLength(1);
    expect(written[0].event.kind).toBe('add');
    expect(written[0].event.idarticulo).toBe(ID.panTajado);
  });

  it('catches the zero action too, which is the path that could have skipped it', async () => {
    // Declaring an inherited shelf empty is *adding a zero* to somebody else's
    // number. It changes nothing, and the sentence is exactly right about that.
    const { user } = await openTablet({ yaRegistrados: HEREDADOS });
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    await user.click(screen.getByRole('button', { name: /Está vacío/ }));
    await user.click(screen.getByRole('button', { name: /^Sí, está vacío$/ }));
    expect(screen.getByText(/Tu cantidad se sumará a la suya/)).toBeTruthy();
  });

  it('still shows no total for an inherited article, on any surface', async () => {
    // The blind rule is unchanged by the handover. Pedro is told that something
    // is registered; he is never told how much, and least of all here, where the
    // number would be somebody else's.
    const { user } = await openTablet({ yaRegistrados: HEREDADOS });
    const surfaces: string[] = [];
    await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    surfaces.push(document.body.textContent ?? '');
    await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
    surfaces.push(document.body.textContent ?? '');
    await user.click(tab('Terminar'));
    surfaces.push(document.body.textContent ?? '');
    for (const surface of surfaces) {
      expect(surface).not.toMatch(/\d+\s*(KILO|UNIDAD)?\s*registrad[oa]s? por/);
    }
  });

  it('changes nothing at all when nobody handed anything over', async () => {
    const { user } = await openTablet();
    await user.click(tab('Terminar'));
    expect(screen.queryByText('ya registrados por otra persona')).toBeNull();
    expect(screen.getByLabelText(/^contar PAN TAJADO/)).toBeTruthy();
  });
});

describe('when the tablet stops saving', () => {
  it('takes the tabs away rather than greying them out', async () => {
    // Accumulating a whole cava behind a warning is worse than stopping, and a
    // disabled screen still reads as «keep going, it will come back».
    const { user } = await openTablet({ brokenDatabase: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      await user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
      await user.click(await screen.findByRole('button', { name: /TAJADO/i }));
      await user.type(screen.getByLabelText(/cantidad contada/), '1');
      await user.click(screen.getByRole('button', { name: /^Registrar 1$/ }));
    }

    expect(await screen.findByText(/No se está guardando nada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mis registros' })).toBeNull();
    expect(screen.queryByLabelText('buscar artículo')).toBeNull();
    expect(screen.getByRole('button', { name: /Reintentar guardado/ })).toBeTruthy();
  });
});

describe('a reload mid-count', () => {
  it('reopens with «Mis registros» intact, and the entry still correctable', async () => {
    // The bug this pins down: the screen used to seed its store with an empty
    // log on every boot, so a crash, an evicted tab or a plain reload made the
    // one screen that exists to correct mistakes forget them — while the
    // device's rows and the server's copy were both fine. The chain continued
    // (no fork); only the display had amnesia.
    const device = sharedDevice();
    await device.repo.createSession(sampleSession());

    const first = await openTablet({ device });
    await registrar(first.user, 'TAJADO', '4');
    // The chained write is asynchronous; a reload races it in real life too,
    // but the test waits so what is being tested is hydration, not the race.
    await waitFor(async () => {
      expect((await device.chain.localChain(SESSION_ID, COUNTER))?.maxSeq).toBe(1);
    });
    first.unmount();

    const second = await openTablet({ device });
    await second.user.click(tab('Mis registros'));
    expect(await screen.findByText('4')).toBeTruthy();

    // And it is not a picture of the past: withdrawing it appends seq 2 onto
    // the same chain, which is the difference between hydration and a fork.
    await second.user.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(await screen.findByText('deshecho')).toBeTruthy();
    await waitFor(async () => {
      expect((await device.chain.localChain(SESSION_ID, COUNTER))?.maxSeq).toBe(2);
    });
  });

  it('restores the registrado marks in the search, not only the list', async () => {
    const device = sharedDevice();
    await device.repo.createSession(sampleSession());

    const first = await openTablet({ device });
    await registrar(first.user, 'TAJADO', '4');
    await waitFor(async () => {
      expect((await device.chain.localChain(SESSION_ID, COUNTER))?.maxSeq).toBe(1);
    });
    first.unmount();

    const second = await openTablet({ device });
    await second.user.type(screen.getByLabelText('buscar artículo'), 'TAJADO');
    const marks = await screen.findAllByLabelText('ya registraste algo aquí');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.textContent).toBe('✓');
  });
});

describe('terminar in a shared session (P2.6)', () => {
  it('reviews the counter’s own work, and gates the catalogue behind one tap', async () => {
    // The sectioning happened out on the floor, where the app cannot see it.
    // What this counter owes at terminar is an account of *their* afternoon;
    // the two hundred rows of everybody else's shelves are one tap away for
    // whoever actually wants to sweep them.
    const { user } = await openTablet({ compartido: true });
    await registrar(user, 'TAJADO', '4');
    await user.click(tab('Terminar'));

    expect(screen.getByText('artículos registrados')).toBeTruthy();
    expect(screen.queryByText(/Sin registrar por nadie ·/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^contar / })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ver lista completa' }));
    expect(screen.getByText(/Sin registrar por nadie · 4 de 5 artículos/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^contar / })).toHaveLength(4);
  });

  it('keeps the gap list on screen for a sectioned session — there it is a debt', async () => {
    const { user } = await openTablet();
    await user.click(tab('Terminar'));
    expect(screen.queryByRole('button', { name: 'Ver lista completa' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^contar / })).toHaveLength(5);
  });
});
