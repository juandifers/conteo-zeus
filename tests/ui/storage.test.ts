/**
 * Asking the browser not to delete the count.
 *
 * The request itself is one line; what is worth testing is everything around
 * it, because every branch here ends with the app telling somebody a different
 * thing about whether their afternoon is safe. A `persist()` that rejects must
 * not read as a refusal, a refusal must not read as a grant, and neither may
 * throw — a browser that will not promise is still a browser somebody has to
 * count on.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  atRisk,
  describeSpace,
  formatBytes,
  requestPersistence,
  spaceIsTight,
  UNKNOWN_STORAGE,
} from '../../src/ui/storage';

/** Enough of a `StorageManager` to answer the three questions this asks it. */
function manager(over: Partial<Record<'persist' | 'persisted' | 'estimate', unknown>>) {
  return {
    persist: vi.fn(async () => true),
    persisted: vi.fn(async () => false),
    estimate: vi.fn(async () => ({ usage: 4_000_000, quota: 2_000_000_000 })),
    ...over,
  } as unknown as StorageManager;
}

describe('requesting persistence', () => {
  it('grants when the browser says yes', async () => {
    const report = await requestPersistence(manager({}));
    expect(report.persistence).toBe('granted');
    expect(report.usage).toBe(4_000_000);
    expect(report.quota).toBe(2_000_000_000);
  });

  it('does not ask again when the origin is already persistent', async () => {
    // Firefox prompts. Asking an origin that is already persistent would put a
    // dialog in front of somebody on every single launch, for nothing.
    const storage = manager({ persisted: vi.fn(async () => true) });
    const report = await requestPersistence(storage);
    expect(report.persistence).toBe('granted');
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it('reports a refusal as denied, not as an error', async () => {
    const report = await requestPersistence(manager({ persist: vi.fn(async () => false) }));
    expect(report.persistence).toBe('denied');
    // And still measures: how full the tablet is, is exactly the question a
    // refusal makes urgent.
    expect(report.usage).toBe(4_000_000);
  });

  it('survives a StorageManager that rejects', async () => {
    // Some embedded webviews reject rather than resolving false.
    const report = await requestPersistence(
      manager({ persist: vi.fn(async () => { throw new Error('nope'); }) }),
    );
    expect(report.persistence).toBe('unsupported');
  });

  it('survives an estimate that rejects, and still reports the grant', async () => {
    const report = await requestPersistence(
      manager({ estimate: vi.fn(async () => { throw new Error('nope'); }) }),
    );
    expect(report.persistence).toBe('granted');
    expect(report.usage).toBeNull();
    expect(report.quota).toBeNull();
  });

  it('says unsupported when there is no StorageManager at all', async () => {
    expect(await requestPersistence(undefined)).toEqual(UNKNOWN_STORAGE);
  });

  /**
   * `denied` and `unsupported` are one answer to the person holding the
   * tablet, because the consequence is identical. They stay separate in the
   * type because only one of them can be improved by installing the app.
   */
  it('treats anything short of a grant as a risk', () => {
    expect(atRisk({ persistence: 'granted', usage: null, quota: null })).toBe(false);
    expect(atRisk({ persistence: 'denied', usage: null, quota: null })).toBe(true);
    expect(atRisk(UNKNOWN_STORAGE)).toBe(true);
  });
});

describe('how full the tablet is', () => {
  it('prints bytes in the unit a person would use', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4_000)).toBe('4 kB');
    expect(formatBytes(4_200_000)).toBe('4,2 MB');
    expect(formatBytes(2_000_000_000)).toBe('2 GB');
  });

  it('reports usage against quota, because the ratio is what predicts an eviction', () => {
    expect(describeSpace({ persistence: 'granted', usage: 4_200_000, quota: 2e9 })).toBe(
      '4,2 MB de 2 GB',
    );
  });

  it('reports usage alone when the browser will not say what the quota is', () => {
    expect(describeSpace({ persistence: 'granted', usage: 4_200_000, quota: null })).toBe('4,2 MB');
  });

  it('says nothing rather than something wrong when there is no estimate', () => {
    expect(describeSpace(UNKNOWN_STORAGE)).toBeNull();
  });

  it('calls the tablet tight at nine tenths of quota, and not before', () => {
    expect(spaceIsTight({ persistence: 'granted', usage: 89, quota: 100 })).toBe(false);
    expect(spaceIsTight({ persistence: 'granted', usage: 90, quota: 100 })).toBe(true);
    // No quota is not the same as a full one; a guess here would put a "casi
    // llena" banner on every tablet whose browser is coy about its limits.
    expect(spaceIsTight({ persistence: 'granted', usage: 90, quota: null })).toBe(false);
    expect(spaceIsTight({ persistence: 'granted', usage: 90, quota: 0 })).toBe(false);
  });
});
