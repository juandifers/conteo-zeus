// @vitest-environment jsdom
/**
 * The counting screen, driven the way a counter drives it.
 *
 * These cover the parts that are logic rather than pixels: what Enter selects,
 * which event each button appends, and where a count lands when one `codigo`
 * covers several balances. Everything asserts against the event log, because
 * the log is the only record that survives (DOMAIN.md §3, §4).
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CountEvent } from '../../src/domain';
import { CountScreen } from '../../src/ui/screens/CountScreen';
import { CountStore } from '../../src/ui/store';
import { MemoryRepository } from '../../src/domain';
import { ID, SESSION_ID, fakeIdentity, seededRepository, txtSession } from './harness';

afterEach(cleanup);

let store: CountStore;

beforeEach(async () => {
  const repo = await seededRepository();
  store = await CountStore.open(repo, SESSION_ID, fakeIdentity());
});

function draw() {
  render(
    <CountScreen
      store={store}
      onBack={() => {}}
      onFaltantes={() => {}}
      onRevision={() => {}}
    />,
  );
  return userEvent.setup();
}

const search = () => screen.getByLabelText('buscar artículo');

/**
 * Record a count the way a blind counter records one: type it and save.
 *
 * Most of what follows used `Coincide con el sistema` to get an item into
 * `counted` in one click, which is no longer a control a blind count has
 * (DOMAIN.md §2.1). Typing the same quantity produces the same `set` event, so
 * the assertions below are about what they were always about — the fold, the
 * withdrawal, the stamp — and not about which button got there.
 *
 * Called with no `qty` it saves whatever the card is already showing, which is
 * how a second identical count is made: re-opening a counted row prefills the
 * field with what is recorded.
 */
async function save(
  user: ReturnType<typeof userEvent.setup>,
  nombre: string,
  qty?: string,
): Promise<void> {
  if (qty !== undefined) {
    await user.type(screen.getByLabelText(`cantidad contada de ${nombre}`), qty);
  }
  await user.click(screen.getByRole('button', { name: /^Guardar/ }));
}
const eventsFor = (idarticulo: number): CountEvent[] =>
  store.getSnapshot().events.filter((event) => event.idarticulo === idarticulo);

describe('search', () => {
  it('shows name, codigo, presentation and book figure on every row', async () => {
    const user = draw();
    await user.type(search(), 'melon');

    const row = screen.getByRole('button', { name: /MELON/ });
    expect(row.textContent).toContain('0111020');
    expect(row.textContent).toContain('KILO');
    expect(row.textContent).toContain('pendiente');
  });

  it('shows an item is already counted the second time it is searched', async () => {
    store.setCount(ID.panTajado, 70);
    const user = draw();
    await user.type(search(), 'pan tajado');

    const row = screen.getAllByRole('button', { name: /PAN TAJADO/ })[0];
    // Blind: the row says what this counter recorded, which is what "already
    // counted" needed to say. It does not say what the books hold, and it does
    // not say the two disagree — 81 against 70 is a variance, and a variance is
    // an arithmetic statement about `existencia` (DOMAIN.md §2.1).
    expect(row.textContent).toContain('contado');
    expect(row.textContent).toContain('70');
    expect(row.textContent).not.toContain('faltan');
    expect(row.textContent).not.toContain('81');
  });

  it('prints no book figure on any row', async () => {
    const user = draw();
    await user.type(search(), 'pan tajado');
    // 81 is PAN TAJADO's `existencia`, and it used to sit in the right-hand
    // column of every result row — 298 of them, at a glance (DOMAIN.md §2.1).
    expect(document.querySelectorAll('.row__existencia')).toHaveLength(0);
    expect(screen.queryByText('81')).toBeNull();
  });

  it('draws a divider between word matches and mid-word matches', async () => {
    const user = draw();
    await user.type(search(), 'pan');
    expect(screen.getByText('coincidencias parciales')).toBeTruthy();
  });
});

describe('the card carries nothing from Zeus (§2.1)', () => {
  it('shows no book figure, no variance and no bar', async () => {
    const user = draw();
    await user.type(search(), '0112006{Enter}');

    // 81 in the books at 2 968,75 each. None of it, in any form: not beside
    // the field, not under it, not as a bar that resolves as a shape.
    expect(document.querySelector('.readout__expected')).toBeNull();
    expect(document.querySelector('.variance__bar')).toBeNull();
    expect(screen.queryByText('81')).toBeNull();
    expect(screen.getByText(/el sistema no se muestra/)).toBeTruthy();
  });

  it('keeps the variance hidden while a quantity is being typed', async () => {
    // The live preview was the leak that mattered: type 80 against a book
    // figure of 81 and the card used to answer «faltan 1», which is the book
    // figure arrived at by subtraction.
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await user.type(screen.getByLabelText('cantidad contada de PAN TAJADO'), '80');

    expect(screen.queryByText(/faltan/)).toBeNull();
    expect(screen.queryByText(/sobran/)).toBeNull();
    expect(screen.queryByText(/cuadra con el sistema/)).toBeNull();
  });

  it('prints no book figures beside the other presentations of one codigo', async () => {
    // PANCETA SV is three balances under 0103005 and the card lists all three,
    // because typing 60 into KILO when you weighed PORCION X 350 GRAMOS is how
    // a count reaches the wrong balance (ZEUS_FORMAT.md §4). The list stays.
    // The quantities that used to sit beside it do not.
    const user = draw();
    await user.type(search(), '0103005{Enter}');

    expect(screen.getByText(/3 presentaciones/)).toBeTruthy();
    expect(document.querySelectorAll('.presrow')).toHaveLength(3);
    expect(document.querySelectorAll('.presrow__qty')).toHaveLength(0);
  });

  it('still shows the counter their own number', async () => {
    // The rule is about what the ERP believes, not about what this person
    // recorded ten minutes ago on the shelf they are standing at.
    store.setCount(ID.panTajado, 70);
    const user = draw();
    await user.type(search(), '0112006{Enter}');

    expect(screen.getByLabelText('cantidad contada de PAN TAJADO')).toHaveProperty(
      'value',
      '70',
    );
    expect(screen.getByText('contado').textContent).toContain('70');
  });
});

describe('Enter — the scanner path', () => {
  it('takes the exact codigo, not the top-ranked row', async () => {
    const user = draw();
    // 0106001 covers four presentations of PESCADO TILAPIA ROJA; the ranking
    // puts "DE 200 A 250 GRS" first, alphabetically.
    await user.type(search(), '0106001');
    expect(screen.getAllByRole('button', { name: /PESCADO TILAPIA/ })[0].textContent).toContain(
      'DE 200 A 250 GRS',
    );

    await user.keyboard('{Enter}');

    const field = screen.getByLabelText('cantidad contada de PESCADO TILAPIA ROJA');
    expect(field).toBeTruthy();
    // The card opened on the first row in file order, which is shelf order —
    // not on the alphabetically first balance.
    await user.type(field, '5');
    await user.click(screen.getByRole('button', { name: /^Guardar/ }));
    expect(eventsFor(ID.tilapia600)).toHaveLength(1);
    expect(eventsFor(ID.tilapia200)).toHaveLength(0);
  });
});

describe('the three actions are not interchangeable', () => {
  it('offers no route to agreeing with the system', async () => {
    // «Coincide con el sistema» was one tap and is gone. Not a leak that was
    // patched — a sentence that cannot be meant: "what I found is what you
    // have on file" is unavailable to somebody who has not been told what is
    // on file (DOMAIN.md §2.1). Typing the figure still produces the same
    // `set`, which is the point: nothing is lost but the shortcut.
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    expect(screen.queryByRole('button', { name: 'Coincide con el sistema' })).toBeNull();

    await save(user, 'PAN TAJADO', '81');
    expect(eventsFor(ID.panTajado)).toHaveLength(1);
    expect(eventsFor(ID.panTajado)[0].kind).toBe('set');
    expect(store.resolutionFor(ID.panTajado)).toEqual({ state: 'counted', qty: 81 });
  });

  it('«Dejar sin verificar» is a waiver, and carries a name', async () => {
    store.setUsuario('ana');
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await user.click(screen.getByRole('button', { name: 'Dejar sin verificar' }));

    const [event] = eventsFor(ID.panTajado);
    expect(event.kind).toBe('unchanged');
    expect(event.usuario).toBe('ana');
    // No quantity: it is not a count of `existencia`, it is somebody saying
    // they did not need to count (DOMAIN.md §2, §4).
    expect(store.resolutionFor(ID.panTajado)).toEqual({ state: 'unchanged' });
  });

  it('confirms a zero before recording it', async () => {
    const user = draw();
    await user.type(search(), '0103005{Enter}');
    // File order opens on PORCION X 300 GRAMOS, 30 in the books.
    await user.type(screen.getByLabelText('cantidad contada de PANCETA SV'), '0');
    await user.click(screen.getByRole('button', { name: /^Guardar/ }));

    expect(eventsFor(ID.pancetaPorcion300)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Sí, registrar 0' }));
    expect(store.resolutionFor(ID.pancetaPorcion300)).toEqual({ state: 'counted', qty: 0 });
  });

  it('asks about every zero, including the ones the books expect', async () => {
    // MELON is booked at zero, so this zero contradicts nothing and the prompt
    // still appears. A prompt that fired only when the books disagreed would
    // be a readout of `existencia > 0`, one bit at a time, for any row
    // somebody cared to probe (DOMAIN.md §2.1). It is also the last check the
    // screen can make on its own, now that there is no reference to catch an
    // order-of-magnitude slip against.
    const user = draw();
    await user.type(search(), '0111020{Enter}');
    await save(user, 'MELON', '0');

    expect(eventsFor(ID.melon)).toHaveLength(0);
    const prompt = screen.getByText(/El estante está vacío/);
    expect(prompt.textContent).not.toContain('El sistema dice');

    await user.click(screen.getByRole('button', { name: 'Sí, registrar 0' }));
    expect(store.resolutionFor(ID.melon)).toEqual({ state: 'counted', qty: 0 });
  });
});

describe('tally mode', () => {
  it('ten taps are ten add events and a readout of 10', async () => {
    const user = draw();
    await user.type(search(), '0111020{Enter}');
    await user.click(screen.getByRole('button', { name: 'Modo conteo' }));

    const pad = screen.getByRole('button', { name: 'sumar uno a MELON' });
    for (let tap = 0; tap < 10; tap++) await user.click(pad);

    const kinds = eventsFor(ID.melon).map((event) => event.kind);
    expect(kinds).toEqual(Array(10).fill('add'));
    expect(store.resolutionFor(ID.melon).qty).toBe(10);
    expect(within(pad).getByText('10')).toBeTruthy();
  });

  it('undo appends rather than deletes', async () => {
    const user = draw();
    await user.type(search(), '0111020{Enter}');
    await user.click(screen.getByRole('button', { name: 'Modo conteo' }));
    const pad = screen.getByRole('button', { name: 'sumar uno a MELON' });
    await user.click(pad);
    await user.click(pad);

    const before = store.getSnapshot().events.length;
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));

    expect(store.getSnapshot().events.length).toBe(before + 1);
    expect(store.resolutionFor(ID.melon).qty).toBe(1);
  });
});

describe('one codigo, several balances', () => {
  it('routes each entry to its own idarticulo', async () => {
    // 0103005 is PANCETA SV in three presentations, each with its own balance
    // (ZEUS_FORMAT.md §4). Getting this wrong posts a count against the wrong
    // product, and nothing downstream can tell.
    const user = draw();
    await user.type(search(), '0103005{Enter}');

    for (const qty of ['12', '90', '5']) {
      await user.type(screen.getByLabelText('cantidad contada de PANCETA SV'), qty);
      await user.click(screen.getByRole('button', { name: /^Guardar/ }));
    }

    expect(store.resolutionFor(ID.pancetaPorcion300)).toEqual({ state: 'counted', qty: 12 });
    expect(store.resolutionFor(ID.pancetaKilo)).toEqual({ state: 'counted', qty: 90 });
    expect(store.resolutionFor(ID.pancetaPorcion350)).toEqual({ state: 'counted', qty: 5 });
    // …and the card closed, because that was the last presentation.
    expect(screen.queryByLabelText('cantidad contada de PANCETA SV')).toBeNull();
  });

  it('names every product when a codigo covers more than one', async () => {
    // ZEUS_FORMAT.md §4 offers "nombre is stable per codigo" as an import
    // integrity check. The other sample export breaks it on 43 codes, and a
    // card headed with one product whose rows are another is how a count lands
    // on the wrong balance. So the card prints every name and says so.
    const repo = new MemoryRepository();
    await repo.createSession(txtSession());
    store = await CountStore.open(repo, SESSION_ID, fakeIdentity());

    const user = draw();
    await user.type(search(), '0109032{Enter}');

    expect(screen.getByText(/no todas son el mismo artículo/)).toBeTruthy();
    // Both names on screen at once, each against its own balance.
    expect(screen.getAllByText(/CEBOLLA ROJA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CREMA DE CHOCLO KNORR/).length).toBeGreaterThan(0);
  });

  it('shows all three presentations and their balances at once', async () => {
    const user = draw();
    await user.type(search(), '0103005{Enter}');

    for (const presentacion of ['PORCION X 300 GRAMOS', 'KILO', 'PORCION X 350 GRAMOS']) {
      expect(screen.getByRole('button', { name: new RegExp(presentacion) })).toBeTruthy();
    }
  });
});

describe('taking it back', () => {
  it('«Descartar conteo» returns the row to pendiente and appends a withdrawal', async () => {
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await save(user, 'PAN TAJADO', '81');
    expect(store.resolutionFor(ID.panTajado).state).toBe('counted');

    await user.type(search(), 'pan tajado');
    await user.click(screen.getAllByRole('button', { name: /PAN TAJADO/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Descartar conteo' }));

    expect(store.resolutionFor(ID.panTajado)).toEqual({ state: 'untouched' });
    // Two events, not zero. Nothing is deleted, and the withdrawal carries a
    // name and a time like everything else (DOMAIN.md §3).
    expect(eventsFor(ID.panTajado).map((event) => event.kind)).toEqual(['set', 'retract']);
    expect(eventsFor(ID.panTajado)[1].usuario).toBe('ana');
  });

  it('puts the item back in the way of a post', async () => {
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await save(user, 'PAN TAJADO', '81');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');

    await user.type(search(), 'pan tajado');
    await user.click(screen.getAllByRole('button', { name: /PAN TAJADO/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Descartar conteo' }));

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('puts the withdrawal furthest from the thumb, and undo nearest', async () => {
    // The right-hand footer column carries the mode's primary action — Guardar,
    // which spans it, or Listo in tally mode — and never a correction. Descartar
    // used to sit in that column one row below where Listo had just been.
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    const corrections = [
      ...document.querySelectorAll<HTMLButtonElement>('.corrections .btn'),
    ].map((button) => button.textContent);
    expect(corrections).toEqual(['Descartar conteo', 'Deshacer']);
  });

  it('greys out the withdrawal it has just carried out, and keeps undo live', async () => {
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await save(user, 'PAN TAJADO', '81');
    await user.type(search(), 'pan tajado');
    await user.click(screen.getAllByRole('button', { name: /PAN TAJADO/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Descartar conteo' }));

    expect(screen.getByRole('button', { name: 'Descartar conteo' })).toHaveProperty(
      'disabled',
      true,
    );
    // …and undo still restores the count the withdrawal took away.
    expect(screen.getByRole('button', { name: 'Deshacer' })).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(store.resolutionFor(ID.panTajado)).toEqual({ state: 'counted', qty: 81 });
  });

  it('disables undo when undoing would change nothing at all', async () => {
    // Two identical counts: undoing the second restates the first, so there is
    // nothing to undo. The button reads that from `undoLast` returning null,
    // not from a rule of its own — a component with its own rule here is a
    // second copy of the fold (DOMAIN.md §3).
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await save(user, 'PAN TAJADO', '81');
    await user.type(search(), 'pan tajado');
    await user.click(screen.getAllByRole('button', { name: /PAN TAJADO/ })[0]);
    // Re-opening a counted row prefills the field, so this saves the same 81.
    await save(user, 'PAN TAJADO');

    await user.type(search(), 'pan tajado');
    await user.click(screen.getAllByRole('button', { name: /PAN TAJADO/ })[0]);
    expect(eventsFor(ID.panTajado)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Deshacer' })).toHaveProperty('disabled', true);
    // The row is still counted, so it can still be withdrawn.
    expect(screen.getByRole('button', { name: 'Descartar conteo' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('offers nothing to discard on an item nobody has touched', async () => {
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    expect(screen.getByRole('button', { name: 'Descartar conteo' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Deshacer' })).toHaveProperty('disabled', true);
  });

  it('undoes a first count all the way back to pendiente', async () => {
    // The case undo could not serve before `retract` existed: there was no
    // prior resolution to restore, so the count could only be overwritten.
    const user = draw();
    await user.type(search(), '0112006{Enter}');
    await save(user, 'PAN TAJADO', '81');

    await user.type(search(), 'pan tajado');
    await user.click(screen.getAllByRole('button', { name: /PAN TAJADO/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));

    expect(store.resolutionFor(ID.panTajado)).toEqual({ state: 'untouched' });
  });
});

describe('when saving stops working', () => {
  it('takes the search box away rather than letting the count grow', async () => {
    const repo = await seededRepository();
    let rejecting = false;
    const flaky = {
      ...repo,
      createSession: (session: Parameters<typeof repo.createSession>[0]) =>
        repo.createSession(session),
      getSession: (id: string) => repo.getSession(id),
      listSessions: () => repo.listSessions(),
      itemsForSession: (id: string) => repo.itemsForSession(id),
      eventsForItem: (id: string, art: number) => repo.eventsForItem(id, art),
      eventsForSession: (id: string) => repo.eventsForSession(id),
      appendEvent: async (event: Parameters<typeof repo.appendEvent>[0]) => {
        if (rejecting) throw new Error('QuotaExceededError');
        await repo.appendEvent(event);
      },
    };
    store = await CountStore.open(flaky, SESSION_ID, fakeIdentity());

    const user = draw();
    rejecting = true;
    for (const qty of [1, 2, 3]) {
      await user.type(search(), '0111020{Enter}');
      await user.type(screen.getByLabelText('cantidad contada de MELON'), String(qty));
      await user.click(screen.getByRole('button', { name: /^Guardar/ }));
    }
    await act(() => store.settled());

    expect(screen.getByText('No se está guardando nada')).toBeTruthy();
    expect(screen.queryByLabelText('buscar artículo')).toBeNull();
    expect(screen.getByRole('button', { name: /Reintentar guardado/ })).toBeTruthy();
  });
});

describe('a file that does not pass its own integrity check', () => {
  it('says so, up front, without refusing to open it', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(txtSession());
    store = await CountStore.open(repo, SESSION_ID, fakeIdentity());
    draw();

    // ZEUS_FORMAT.md §4.1: 43 of 232 codes in this export carry more than one
    // name. The importer refuses a file like this now, so the only way to be
    // looking at one is to have imported it before the check existed — and the
    // screen has to say so rather than let somebody count a whole cava into a
    // session that cannot produce a file.
    expect(screen.getByRole('alert').textContent).toContain('no cuadra consigo mismo');
    expect(screen.getByRole('alert').textContent).toContain('artículo equivocado');
  });

  it('stays quiet on a file that does pass it', () => {
    draw();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('progress', () => {
  it('counts a waiver as verified, because it posts', async () => {
    const user = draw();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');

    await user.type(search(), '0112006{Enter}');
    await user.click(screen.getByRole('button', { name: 'Dejar sin verificar' }));

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  });

  it('stamps the zone the counter says they are in', async () => {
    const user = draw();
    await user.selectOptions(screen.getByLabelText('Zona'), 'CAVA');
    await user.type(search(), '0112006{Enter}');
    await save(user, 'PAN TAJADO', '81');

    expect(eventsFor(ID.panTajado)[0].zona).toBe('CAVA');
  });
});
