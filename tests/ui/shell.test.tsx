// @vitest-environment jsdom
/**
 * The shell around the count: the update notice, the install offer, and what
 * the app says when the browser will not promise to keep the database.
 *
 * None of this is the domain, and all of it is what makes the app survivable
 * on a tablet in a storeroom. The three things asserted here are the three
 * that go wrong quietly: a version that applies itself, an install button that
 * outlives its prompt, and a persistence refusal that nobody is told about.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../../src/domain';
import { App } from '../../src/ui/App';
import type { Downloader } from '../../src/ui/download';
import type { Install } from '../../src/ui/install';
import { localOutbox } from '../../src/ui/outbox';
import type { StorageReport } from '../../src/ui/storage';
import type { Updates } from '../../src/ui/updates';
import { SAMPLE_XLS } from '../helpers';
import { memoryStorage, NOT_PERSISTED, PERSISTED } from './harness';

afterEach(cleanup);

function zeusFile(): File {
  return new NodeFile([readFileSync(SAMPLE_XLS)], 'COMESTIBLES ALMACEN.xls', {
    type: 'application/octet-stream',
  }) as unknown as File;
}

function upload(container: HTMLElement): void {
  const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files: [zeusFile()] } });
}

/** An `Updates` whose "a version is waiting" moment the test controls. */
function fakeUpdates() {
  const listeners = new Set<(waiting: boolean) => void>();
  const apply = vi.fn(async () => {});
  return {
    apply,
    announce() {
      for (const listener of listeners) listener(true);
    },
    port: {
      subscribe(listener: (waiting: boolean) => void) {
        listeners.add(listener);
        listener(false);
        return () => listeners.delete(listener);
      },
      apply,
    } satisfies Updates,
  };
}

function fakeInstall(offeredAtFirst: boolean) {
  const listeners = new Set<(offered: boolean) => void>();
  let offered = offeredAtFirst;
  const prompt = vi.fn(async () => {
    offered = false;
    for (const listener of listeners) listener(false);
  });
  return {
    prompt,
    port: {
      subscribe(listener: (offered: boolean) => void) {
        listeners.add(listener);
        listener(offered);
        return () => listeners.delete(listener);
      },
      prompt,
    } satisfies Install,
  };
}

const persisted = (report: StorageReport) => () => Promise.resolve(report);

describe('a new version, waiting', () => {
  it('says nothing at all while there is no update', async () => {
    const updates = fakeUpdates();
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        updates={updates.port}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    expect(screen.queryByText('Hay una versión nueva')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actualizar' })).toBeNull();
  });

  /**
   * The notice appears; nothing else happens. The worker has already
   * downloaded and installed the new build and is holding at `waiting` — the
   * one thing it must not do is take over on its own, because the person
   * holding the tablet is in the middle of a count.
   */
  it('offers the update and applies it only when asked', async () => {
    const updates = fakeUpdates();
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        updates={updates.port}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');

    updates.announce();

    expect(await screen.findByText('Hay una versión nueva')).toBeTruthy();
    expect(updates.apply).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(updates.apply).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed, and stays dismissed for the rest of the shift', async () => {
    const updates = fakeUpdates();
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        updates={updates.port}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    updates.announce();
    await screen.findByText('Hay una versión nueva');

    await userEvent.setup().click(screen.getByRole('button', { name: 'descartar aviso' }));

    expect(screen.queryByText('Hay una versión nueva')).toBeNull();
    // Re-announcing does not bring it back: the worker fires `onNeedRefresh`
    // more than once in some browsers, and a notice that reappears after being
    // dismissed is a notice that gets tapped through without being read.
    updates.announce();
    expect(screen.queryByText('Hay una versión nueva')).toBeNull();
    expect(updates.apply).not.toHaveBeenCalled();
  });

  it('follows the count onto the counting screen rather than only the list', async () => {
    const updates = fakeUpdates();
    const { container } = render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        updates={updates.port}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    upload(container);
    await screen.findByLabelText('buscar artículo');

    updates.announce();
    expect(await screen.findByText('Hay una versión nueva')).toBeTruthy();
  });
});

describe('when the browser will not promise to keep the count', () => {
  it('says so on the sessions screen, with the risk and the thing to do about it', async () => {
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        persistence={persisted(NOT_PERSISTED)}
      />,
    );
    const notice = await screen.findByText(/El navegador no garantiza guardar este conteo/);
    expect(notice.textContent).toContain('puede borrarlo si la tableta se queda sin espacio');
    expect(notice.textContent).toContain('Genera el archivo de ajuste el mismo día');
    // Installing is the one lever a person has over Chrome's answer.
    expect(notice.textContent).toContain('instala la aplicación');
  });

  it('repeats it in the counting header, where a count that runs all afternoon is', async () => {
    const { container } = render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        persistence={persisted(NOT_PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    upload(container);
    await screen.findByLabelText('buscar artículo');

    expect(
      screen.getByText(/El navegador puede borrar este conteo si la tableta se queda sin espacio/),
    ).toBeTruthy();
  });

  it('is silent on both screens once the browser has promised', async () => {
    const { container } = render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    expect(screen.queryByText(/El navegador no garantiza/)).toBeNull();
    expect(screen.getByText(/protegido/)).toBeTruthy();

    upload(container);
    await screen.findByLabelText('buscar artículo');
    expect(screen.queryByText(/El navegador puede borrar este conteo/)).toBeNull();
  });

  /**
   * A `persistence` probe that rejects must not take the boot with it. This is
   * the browser nobody tested on, and the app still has to count.
   */
  it('still opens when the probe itself fails', async () => {
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        persistence={() => Promise.reject(new Error('sin StorageManager'))}
      />,
    );
    expect(await screen.findByText('Trae un archivo de Zeus y empieza')).toBeTruthy();
    // And falls back to saying it cannot promise, rather than to silence.
    expect(screen.getByText(/El navegador no garantiza/)).toBeTruthy();
  });

  it('warns before a count starts when the tablet is nearly full', async () => {
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        persistence={persisted({ persistence: 'granted', usage: 95, quota: 100 })}
      />,
    );
    expect(await screen.findByText(/La tableta está casi llena/)).toBeTruthy();
  });
});

describe('the install offer', () => {
  it('appears only while the browser has an install to offer', async () => {
    const install = fakeInstall(true);
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        install={install.port}
        persistence={persisted(PERSISTED)}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Instalar en la tableta' });

    await userEvent.setup().click(button);

    expect(install.prompt).toHaveBeenCalledTimes(1);
    // A captured prompt may be shown once. Left on screen it is a button that
    // does nothing, which is worse than no button.
    expect(screen.queryByRole('button', { name: 'Instalar en la tableta' })).toBeNull();
  });

  it('shows nothing when there is nothing to install — an installed app, or a browser that cannot', async () => {
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        install={fakeInstall(false).port}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    expect(screen.queryByRole('button', { name: 'Instalar en la tableta' })).toBeNull();
  });
});

describe('which build this is, and what it did', () => {
  it('prints the build stamp where a tester can read it out', async () => {
    render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    expect(screen.getByText('versión')).toBeTruthy();
  });

  it('exports the whole log, with the events of a count that just happened', async () => {
    const saved: { filename: string; bytes: Uint8Array }[] = [];
    const download: Downloader = {
      save: (filename, bytes) => saved.push({ filename, bytes }),
    };
    const { container } = render(
      <App
        repo={new MemoryRepository()}
        outbox={localOutbox(memoryStorage())}
        download={download}
        persistence={persisted(PERSISTED)}
      />,
    );
    await screen.findByText('Trae un archivo de Zeus y empieza');
    upload(container);
    await screen.findByLabelText('buscar artículo');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('buscar artículo'), '0111020{Enter}');
    await user.type(screen.getByLabelText(/^cantidad contada de/), '5');
    await user.click(screen.getByRole('button', { name: /^Guardar/ }));
    await user.click(screen.getByRole('button', { name: 'sesiones' }));

    await user.click(
      await screen.findByRole('button', { name: 'Exportar registro de actividad' }),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toMatch(/^conteo-log-\d{4}-\d{2}-\d{2}-.+\.csv$/);
    const csv = new TextDecoder().decode(saved[0].bytes.slice(3));
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2); // header + the one count
    expect(csv).toContain('"set"');
    expect(csv).toContain('"5"');
  });
});
