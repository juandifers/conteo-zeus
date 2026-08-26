// @vitest-environment jsdom
/**
 * The way in: an empty tablet, a Zeus export, and a session to count.
 *
 * The import goes through `importZeusBytes`, which sniffs the representation
 * rather than trusting a file name — an Android picker reports whatever the
 * sending app felt like calling it. Nothing in src/ui/ imports src/zeus/, so
 * the screens never learn that a count arrives as tab-separated CP850.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryRepository,
  type CountEvent,
  type ExportRecord,
  type Session,
} from '../../src/domain';
import { App } from '../../src/ui/App';
import { localOutbox } from '../../src/ui/outbox';
import { SAMPLE_TXT, SAMPLE_XLS } from '../helpers';
import { memoryStorage } from './harness';

afterEach(cleanup);

/**
 * A `File` with a working `arrayBuffer()`.
 *
 * jsdom's `Blob` still has none, so the browser API the import path actually
 * uses has to come from Node. The alternative — a `FileReader` fallback in
 * production code — would be test scaffolding wearing a compatibility shim's
 * clothes.
 */
function zeusFile(path: string, name: string): File {
  return new NodeFile([readFileSync(path)], name, {
    type: 'application/octet-stream',
  }) as unknown as File;
}

function upload(container: HTMLElement, file: File): void {
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files: [file] } });
}

describe('an empty tablet', () => {
  it('invites the import instead of apologising for the void', async () => {
    render(<App repo={new MemoryRepository()} outbox={localOutbox(memoryStorage())} />);
    expect(await screen.findByText('Trae un archivo de Zeus y empieza')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Importar archivo de Zeus' })).toBeTruthy();
  });
});

describe('importing a Zeus export', () => {
  it('opens the count straight from the .txt', async () => {
    const repo = new MemoryRepository();
    const { container } = render(<App repo={repo} outbox={localOutbox(memoryStorage())} />);
    await screen.findByText('Trae un archivo de Zeus y empieza');

    upload(container, zeusFile(SAMPLE_TXT, 'COMESTIBLES ALMACEN.txt'));

    // Straight into counting: the person who just imported is the person about
    // to count, and a list with one row on it is a tap for nothing.
    expect(await screen.findByLabelText('buscar artículo')).toBeTruthy();
    expect(screen.getByText('01')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('298');
    expect(await repo.listSessions()).toHaveLength(1);
  });

  it('takes the .xls just as happily, sniffing the bytes rather than the name', async () => {
    const repo = new MemoryRepository();
    const { container } = render(<App repo={repo} outbox={localOutbox(memoryStorage())} />);
    await screen.findByText('Trae un archivo de Zeus y empieza');

    // Deliberately mislabelled: the picker's name is not evidence.
    upload(container, zeusFile(SAMPLE_XLS, 'export.txt'));

    expect(await screen.findByLabelText('buscar artículo')).toBeTruthy();
    const [session] = await repo.listSessions();
    expect(session.itemCount).toBe(298);
  });

  it('says why when the bytes are not a Zeus export', async () => {
    const { container } = render(<App repo={new MemoryRepository()} outbox={localOutbox(memoryStorage())} />);
    await screen.findByText('Trae un archivo de Zeus y empieza');

    upload(container, new NodeFile(['not a count'], 'notas.txt') as unknown as File);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('No se pudo importar');
  });
});

describe('coming back to a session', () => {
  it('lists it with the progress folded from its log', async () => {
    const repo = new MemoryRepository();
    const { container } = render(<App repo={repo} outbox={localOutbox(memoryStorage())} />);
    await screen.findByText('Trae un archivo de Zeus y empieza');
    upload(container, zeusFile(SAMPLE_TXT, 'COMESTIBLES ALMACEN.txt'));
    await screen.findByLabelText('buscar artículo');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('buscar artículo'), '0111020{Enter}');
    await user.click(screen.getByRole('button', { name: 'Coincide con el sistema' }));
    await user.click(screen.getByRole('button', { name: 'sesiones' }));

    const card = await screen.findByRole('button', { name: /Bodega/ });
    expect(card.textContent).toContain('298 artículos');
    // Folded from the log, not from a counter kept alongside it.
    expect(card.textContent).toContain('1 verificados');
  });
});

describe('the way through to the review', () => {
  it('reaches it from the count screen, carrying the file the session came from', async () => {
    // The review screen is a different device and a different person — but the
    // same app and the same session, and this is the door.
    const repo = new MemoryRepository();
    const { container } = render(
      <App repo={repo} outbox={localOutbox(memoryStorage())} />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    upload(container, zeusFile(SAMPLE_XLS, 'COMESTIBLES ALMACEN.xls'));
    await screen.findByLabelText('buscar artículo');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revisar y generar archivo' }));

    expect(await screen.findByRole('button', { name: 'Generar archivo' })).toBeDisabled();
    expect(screen.getByText('Faltan 298 artículos por contar o exentar.')).toBeTruthy();
    // The import kept the file, so the only thing blocking the post is the count.
    const [session] = await repo.listSessions();
    expect(session.sourceName).toBe('COMESTIBLES ALMACEN.xls');
  });
});

describe('booting', () => {
  it('boots once with the outbox it builds for itself', async () => {
    // Every other test here injects one, which is exactly how a real bug hid:
    // a `localOutbox()` default constructed during render is a new identity in
    // the boot effect's dependency array, so the effect restarts on every
    // render for ever. In the browser that showed as a blank screen with
    // nothing in the console. Reaching the sessions list is not enough to
    // catch it — the boot has to happen a bounded number of times.
    const backing = new MemoryRepository();
    let identifications = 0;
    const repo = {
      createSession: (session: Session) => backing.createSession(session),
      getSession: (id: string) => backing.getSession(id),
      listSessions: () => backing.listSessions(),
      itemsForSession: (id: string) => backing.itemsForSession(id),
      eventsForItem: (id: string, art: number) => backing.eventsForItem(id, art),
      eventsForSession: (id: string) => backing.eventsForSession(id),
      appendEvent: (event: CountEvent) => backing.appendEvent(event),
      recordExport: (record: ExportRecord) => backing.recordExport(record),
      exportsForSession: (id: string) => backing.exportsForSession(id),
      identify: () => {
        identifications++;
        return backing.identify();
      },
    };

    render(<App repo={repo} />);
    await screen.findByRole('button', { name: 'Importar archivo de Zeus' });
    await new Promise((settle) => setTimeout(settle, 50));

    expect(identifications).toBe(1);
  });

  it('refuses to count when the tablet cannot say who it is', async () => {
    // DOMAIN.md §6: the fold breaks ties on `deviceId`, so an improvised one
    // produces a log nothing can order afterwards. Better to stop.
    const repo = new MemoryRepository();
    let broken = true;
    const unidentifiable = Object.assign(Object.create(Object.getPrototypeOf(repo)), repo, {
      identify: async () => {
        if (broken) throw new Error('InvalidStateError: no se pudo abrir la base de datos');
        return { deviceId: 'tablet-1', nextSeq: 0 };
      },
    });

    render(<App repo={unidentifiable} outbox={localOutbox(memoryStorage())} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No se puede contar en esta tableta');
    expect(alert.textContent).toContain('no se pudo abrir la base de datos');
    // No way in: the import button is not on screen either.
    expect(screen.queryByRole('button', { name: 'Importar archivo de Zeus' })).toBeNull();

    broken = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Importar archivo de Zeus' })).toBeTruthy();
  });

  it('reports work the replay could not flush', async () => {
    const storage = memoryStorage();
    const stuck: CountEvent = {
      id: 'ev-stuck',
      sessionId: 'ninguna',
      idarticulo: 77,
      usuario: 'ana',
      zona: 'ALMACEN',
      at: '2026-08-25T10:00:00.000Z',
      deviceId: 'tablet-1',
      seq: 0,
      kind: 'set',
      qty: 3,
    };
    const outbox = localOutbox(storage);
    outbox.hold(stuck);

    // The session it belongs to is not in this repository, so the replay fails
    // and the event stays held rather than being dropped.
    render(<App repo={new MemoryRepository()} outbox={outbox} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('1 registros de una sesión anterior');
    expect(outbox.pending()).toHaveLength(1);
  });
});
