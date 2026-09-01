/**
 * The per-counter hash chain — `src/domain/chain.ts`.
 *
 * The property under test is not "the hash is a hash". It is that two
 * independently built chains over the same events agree byte for byte, because
 * the client and the serverless functions import this module and the only
 * defence against them disagreeing is that there is one implementation.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalEvent,
  chainEvents,
  chainHash,
  genesisHash,
  headHash,
  UnchainableEventError,
  verifyChain,
  type CountEvent,
} from '../../src/domain';
import { addCount, finish, note, resetFactory, retract, setCount } from './factory';

const SESSION = 'session-1';
const COUNTER = 'counter-ana';

/**
 * A counter's own chain: `counterId` on every event, `seq` contiguous **from 1**.
 *
 * One-based, and not by taste. The push protocol resumes from
 * `storedMaxSeq + 1` and a finish manifest states `finish.seq === finalSeq + 1`
 * (P2.2 §1b, §2a); both need a value meaning "nothing stored yet" and both
 * spell it `0`. A counter who recorded nothing finishes with `finalSeq = 0`,
 * `headHash = genesis` and `finish.seq = 1`, which is only arithmetic if the
 * first content event is seq 1.
 */
function chainOf(count: number): CountEvent[] {
  resetFactory();
  const events: CountEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(
      setCount(1181, i + 1, {
        id: `e${i}`,
        sessionId: SESSION,
        counterId: COUNTER,
        deviceId: 'tablet-a',
        seq: i + 1,
      }),
    );
  }
  return events;
}

describe('canonicalEvent — the bytes an event contributes', () => {
  it('is an array of strings, so free text cannot forge a boundary', () => {
    const evil = note(1181, 'a\tb\nc"de', {
      id: 'n1',
      sessionId: SESSION,
      counterId: COUNTER,
      seq: 0,
    });
    const canonical = canonicalEvent(evil);

    // Round-trips through JSON.parse, which is the guarantee: whatever the
    // counter typed comes back as exactly one field.
    const fields: string[] = JSON.parse(canonical);
    expect(fields.every((f) => typeof f === 'string')).toBe(true);
    expect(fields).toContain('a\tb\nc"de');
    // The separator the chain uses is escaped, not embedded raw.
    expect(canonical.includes('\u001e')).toBe(false);
  });

  it('renders qty by String(), the shortest round-tripping form', () => {
    const event = addCount(1181, 20.8, { id: 'a1', sessionId: SESSION, counterId: COUNTER, seq: 0 });
    expect(JSON.parse(canonicalEvent(event))).toContain('20.8');
  });

  it('renders a null idarticulo as the empty string, not as "null"', () => {
    const event = finish(4, 'deadbeef', { id: 'f1', sessionId: SESSION, counterId: COUNTER, seq: 5 });
    const fields: string[] = JSON.parse(canonicalEvent(event));
    expect(fields).not.toContain('null');
    expect(fields[6]).toBe('');
  });

  it('refuses an event with no counterId rather than inventing one', () => {
    // The documented rule for P1 events (docs/MIGRATION-P1-P2.md). Inventing an
    // id here would mint a chain that never existed, and a chain that never
    // existed is one a server could be persuaded to accept.
    const legacy = setCount(1181, 5, { id: 'p1', sessionId: SESSION, seq: 0 });
    expect(legacy.counterId).toBeUndefined();
    expect(() => canonicalEvent(legacy)).toThrow(UnchainableEventError);
    expect(() => canonicalEvent(legacy)).toThrow(/counterId/);
  });

  it('refuses a non-finite qty rather than hashing "NaN"', () => {
    const broken = { ...setCount(1181, 5, { id: 'x', counterId: COUNTER, seq: 0 }), qty: NaN };
    expect(() => canonicalEvent(broken)).toThrow(/not finite/);
  });
});

describe('the chain', () => {
  it('reproduces the same head on two independently built chains', () => {
    const events = chainOf(12);
    // Built forwards from genesis, one link at a time…
    let manual = genesisHash(SESSION, COUNTER);
    for (const event of events) manual = chainHash(manual, event);
    // …and through the module's own fold.
    expect(headHash(SESSION, COUNTER, events)).toBe(manual);

    // And from a shuffled array, because the chain orders by `seq` and a merge
    // delivers events in whatever order it likes.
    const shuffled = [...events].reverse();
    expect(headHash(SESSION, COUNTER, shuffled)).toBe(manual);
  });

  it('anchors genesis to the session and the counter', () => {
    expect(genesisHash(SESSION, COUNTER)).not.toBe(genesisHash('other-session', COUNTER));
    expect(genesisHash(SESSION, COUNTER)).not.toBe(genesisHash(SESSION, 'counter-luis'));
    // An empty chain is its genesis, so a counter who did nothing still has a
    // head to claim in a `finish`.
    expect(headHash(SESSION, COUNTER, [])).toBe(genesisHash(SESSION, COUNTER));
  });

  it('changes the head when any single field of any event changes', () => {
    const events = chainOf(5);
    const baseline = headHash(SESSION, COUNTER, events);

    const mutations: Array<[string, (e: CountEvent) => CountEvent]> = [
      ['id', (e) => ({ ...e, id: `${e.id}-x` })],
      ['sessionId', (e) => ({ ...e, sessionId: 'other' })],
      ['counterId', (e) => ({ ...e, counterId: 'counter-luis' })],
      ['seq', (e) => ({ ...e, seq: e.seq + 100 })],
      ['kind', (e) => ({ ...e, kind: 'add' }) as CountEvent],
      ['idarticulo', (e) => ({ ...e, idarticulo: 330 }) as CountEvent],
      ['qty', (e) => ({ ...e, qty: 999 }) as CountEvent],
      ['usuario', (e) => ({ ...e, usuario: 'luis' })],
      ['zona', (e) => ({ ...e, zona: 'NEVERA' })],
      ['at', (e) => ({ ...e, at: '2030-01-01T00:00:00.000Z' })],
      ['deviceId', (e) => ({ ...e, deviceId: 'tablet-b' })],
    ];

    // Every field, at every position, not just the last one. A chain that only
    // noticed a change to its head would be a checksum of one event.
    for (const [field, mutate] of mutations) {
      for (let position = 0; position < events.length; position++) {
        const tampered = events.map((e, i) => (i === position ? mutate(e) : e));
        expect({ field, position, head: headHash(SESSION, COUNTER, tampered) }).not.toEqual({
          field,
          position,
          head: baseline,
        });
      }
    }
  });

  it('distinguishes a scoped retraction from an unscoped one', () => {
    // The two fold to different item states, so they must hash differently.
    const target = setCount(1181, 5, { id: 't', sessionId: SESSION, counterId: COUNTER, seq: 0 });
    const scoped = retract(1181, {
      id: 'r',
      sessionId: SESSION,
      counterId: COUNTER,
      seq: 1,
      retractsEventId: 't',
    });
    const unscoped = { ...scoped };
    delete (unscoped as { retractsEventId?: string }).retractsEventId;

    expect(headHash(SESSION, COUNTER, [target, scoped])).not.toBe(
      headHash(SESSION, COUNTER, [target, unscoped]),
    );
  });

  it('exposes each link, so a server can store prev_hash and hash per row', () => {
    const events = chainOf(3);
    const links = chainEvents(genesisHash(SESSION, COUNTER), events);
    expect(links.map((l) => l.event.seq)).toEqual([1, 2, 3]);
    expect(links[0].prevHash).toBe(genesisHash(SESSION, COUNTER));
    expect(links[1].prevHash).toBe(links[0].hash);
    expect(links[2].prevHash).toBe(links[1].hash);
  });
});

describe('verifyChain — what the server asks before believing a `finish`', () => {
  it('accepts a complete chain and reports its head and final seq', () => {
    const events = chainOf(6);
    const verdict = verifyChain(SESSION, COUNTER, events);
    expect(verdict).toMatchObject({ ok: true, finalSeq: 6, count: 6 });
    expect(verdict.ok && verdict.head).toBe(headHash(SESSION, COUNTER, events));
  });

  it('accepts an empty chain, whose head is the genesis and whose finalSeq is 0', () => {
    // Zero and not null: this is the figure a `finish` manifest carries, and
    // the empty case *is* `finalSeq = 0` (P2.2 §2a). Two spellings of "nothing"
    // on the two sides of the comparison that decides whether a session may be
    // sealed is an off-by-one waiting for the least suspicious person's tablet.
    expect(verifyChain(SESSION, COUNTER, [])).toEqual({
      ok: true,
      head: genesisHash(SESSION, COUNTER),
      finalSeq: 0,
      count: 0,
    });
  });

  it('detects a gap in seq, and says where', () => {
    // The whole point: absence of data looks the same as a counter who did
    // nothing, so the hole has to be nameable before a session is sealed.
    const events = chainOf(6).filter((e) => e.seq !== 3);
    const verdict = verifyChain(SESSION, COUNTER, events);
    expect(verdict).toMatchObject({ ok: false, problem: 'gap', atSeq: 3 });
    expect(verdict.ok === false && verdict.detail).toMatch(/seq 3 is missing/);
  });

  it('detects a chain that does not start at 1', () => {
    const verdict = verifyChain(SESSION, COUNTER, chainOf(4).filter((e) => e.seq !== 1));
    expect(verdict).toMatchObject({ ok: false, problem: 'gap', atSeq: 1 });
  });

  it('detects two events claiming one seq', () => {
    const events = chainOf(3);
    const twin = { ...events[1], id: 'twin' };
    const verdict = verifyChain(SESSION, COUNTER, [...events, twin]);
    expect(verdict).toMatchObject({ ok: false, problem: 'duplicate-seq', atSeq: 2 });
  });

  it("rejects another counter's event rather than folding it in", () => {
    const events = chainOf(3);
    const foreign = { ...events[1], counterId: 'counter-luis' };
    expect(verifyChain(SESSION, COUNTER, [events[0], foreign, events[2]])).toMatchObject({
      ok: false,
      problem: 'foreign-event',
    });
  });

  it('reports an unchainable event rather than throwing', () => {
    // A P1 event pushed at a P2 endpoint. The server has to record a state for
    // the counter, not 500.
    const events = chainOf(2);
    const legacy = { ...events[1] };
    delete (legacy as { counterId?: string }).counterId;
    expect(verifyChain(SESSION, COUNTER, [events[0], legacy])).toMatchObject({
      ok: false,
      problem: 'foreign-event',
    });
  });

  it('matches the manifest a `finish` event carries', () => {
    // The end-to-end shape of the P2.4 seal check, written out once.
    const events = chainOf(9);
    const verdict = verifyChain(SESSION, COUNTER, events);
    const claim = finish(9, headHash(SESSION, COUNTER, events), {
      id: 'fin',
      sessionId: SESSION,
      counterId: COUNTER,
      seq: 10,
    });
    expect(verdict.ok && verdict.finalSeq).toBe(claim.finalSeq);
    expect(verdict.ok && verdict.head).toBe(claim.headHash);
  });
});
