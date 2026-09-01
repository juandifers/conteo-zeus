/**
 * The admin's chain — P2.3.5 §3.
 *
 * A second append-only log beside the counters' events, hashed with the same
 * primitives in `src/domain/chain.ts` because a second canonicalisation is a
 * second thing that can disagree with the first.
 *
 * What is under test is the property that makes it worth having at all: an
 * admin decision cannot be added, removed or edited afterwards without the
 * chain saying so — including by somebody with a `psql` prompt, which is the
 * threat model, since there are no accounts and the whole record is otherwise a
 * few rows in a table.
 */
import { describe, expect, it } from 'vitest';

import {
  actionGenesisHash,
  canonicalAction,
  canonicalJson,
  chainActionHash,
  genesisHash,
  headHash,
  sessionHash,
  verifyActionChain,
  type ChainableAction,
  type StoredAction,
} from '../../src/domain';

const SESSION = 'sesion-1';

function action(seq: number, over: Partial<ChainableAction> = {}): ChainableAction {
  return {
    id: `a${seq}`,
    sessionId: SESSION,
    seq,
    kind: 'retirar_contador',
    payload: { counterId: 'luis', nombre: 'Luis', motivo: 'se fue enfermo' },
    usuario: 'Marta',
    at: `2026-08-31T11:0${seq}:00.000Z`,
    ...over,
  };
}

/** Chain a run of actions onto the session's genesis, as the handler does. */
function chain(actions: readonly ChainableAction[]): StoredAction[] {
  let prev = actionGenesisHash(SESSION);
  return actions.map((one) => {
    const hash = chainActionHash(prev, one);
    const link = { ...one, prevHash: prev, hash };
    prev = hash;
    return link;
  });
}

describe('canonicalJson — the bytes a payload contributes', () => {
  it('sorts keys, so a jsonb round trip hashes to what went in', () => {
    // `jsonb` does not preserve key order. Without this the hash would fail to
    // verify on the very first read, which is a chain that is worse than none:
    // it would cry wolf about the one thing it exists to detect.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('is stable under a real JSON round trip', () => {
    const payload = {
      movimientos: [{ idarticulo: 1181, from: 'luis', to: 'pedro', sectionId: 'sec-a' }],
      motivo: 'se fue enfermo',
      seccionesCreadas: [],
    };
    expect(canonicalJson(JSON.parse(JSON.stringify(payload)) as unknown)).toBe(
      canonicalJson(payload),
    );
  });

  it('refuses a number that would not come back out as it went in', () => {
    // `jsonb` stores numbers as `numeric` and renders them canonically, so
    // `1.0` and `1e2` do not survive as written. An admin action carries no
    // quantity, so forbidding them costs nothing and closes the only way the
    // round trip could change a byte.
    expect(() => canonicalJson({ qty: 1.5 })).toThrow(/safe integers/);
    expect(canonicalJson({ seq: 83 })).toBe('{"seq":83}');
  });

  it('drops undefined rather than hashing it as anything', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('canonicalAction', () => {
  it('refuses an action with nobody on it', () => {
    // The single reason this table exists: a decision an auditor will ask about
    // has to have a name attached before it can be recorded at all.
    expect(() => canonicalAction(action(1, { usuario: '  ' }))).toThrow(/usuario/);
  });

  it('refuses a seq that is not a position in a chain', () => {
    expect(() => canonicalAction(action(0))).toThrow(/seq/);
  });

  it('is a different chain from an event chain, by construction', () => {
    // Tagged separately so no action can ever be mistaken for an event or
    // hashed into an event chain, however either format changes later.
    expect(canonicalAction(action(1))).toContain('conteo-zeus/action/v1');
    expect(actionGenesisHash(SESSION)).not.toBe(genesisHash(SESSION, 'luis'));
  });
});

describe('verifyActionChain', () => {
  it('accepts a chain the handler built', () => {
    const verdict = verifyActionChain(SESSION, chain([action(1), action(2), action(3)]));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.finalSeq).toBe(3);
  });

  it('is empty-clean: no actions is a valid history, not a broken one', () => {
    const verdict = verifyActionChain(SESSION, []);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.finalSeq).toBe(0);
      expect(verdict.head).toBe(actionGenesisHash(SESSION));
    }
  });

  it('catches a payload edited in the database', () => {
    // The threat model. There are no accounts; the record is a handful of rows,
    // and the person who would want to change «faltan 61–83» to «faltan 82–83»
    // is the person with access to them.
    const links = chain([action(1), action(2)]);
    const tampered = links.map((link, index) =>
      index === 0
        ? { ...link, payload: { ...(link.payload as object), motivo: 'renunció' } }
        : link,
    );
    const verdict = verifyActionChain(SESSION, tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.atSeq).toBe(1);
  });

  it('catches an action removed from the middle', () => {
    const links = chain([action(1), action(2), action(3)]);
    const verdict = verifyActionChain(SESSION, [links[0], links[2]]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toBe('gap');
  });

  it('catches an action inserted at the end with a plausible hash', () => {
    const links = chain([action(1), action(2)]);
    const forged = action(3);
    // Hashed onto the *genesis* rather than onto seq 2 — the shape of a row
    // written by hand by somebody who copied the hashing but not the chaining.
    const verdict = verifyActionChain(SESSION, [
      ...links,
      { ...forged, prevHash: actionGenesisHash(SESSION), hash: chainActionHash(actionGenesisHash(SESSION), forged) },
    ]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.atSeq).toBe(3);
  });

  it('refuses a chain replayed into another session', () => {
    const links = chain([action(1)]);
    const verdict = verifyActionChain('otra-sesion', links);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toBe('foreign-event');
  });
});

/**
 * The seal hash — P2.5 §1b, and the first task that calls it.
 *
 * Three properties, and each of them is a way the seal could attest to
 * something other than what was counted.
 */
describe('sessionHash covers both chains and the catalogue they were counted against', () => {
  const SOURCE = 'a'.repeat(64);
  const counters = [
    { counterId: 'ana', maxSeq: 12, headHash: headHash(SESSION, 'ana', []) },
    { counterId: 'luis', maxSeq: 40, headHash: headHash(SESSION, 'luis', []) },
  ];
  const actionHead = actionGenesisHash(SESSION);
  const base = {
    sessionId: SESSION,
    sourceHash: SOURCE,
    counters,
    actionHead,
    actionMaxSeq: 0,
  };

  it('changes when an admin action changes', () => {
    // A seal over only the counters' events would leave every admin decision —
    // who was retired, what was reassigned, whose missing work was sealed over,
    // which eighteen hundred rows somebody signed off unseen — outside whatever
    // the acta guarantees. Those are the entries somebody has a motive to change.
    const links = chain([action(1)]);
    const after = sessionHash({
      ...base,
      actionHead: links[links.length - 1].hash,
      actionMaxSeq: 1,
    });
    expect(after).not.toBe(sessionHash(base));
  });

  it('changes when a counter chain changes', () => {
    expect(
      sessionHash({
        ...base,
        counters: [{ ...counters[0], headHash: 'otra-cabeza' }, counters[1]],
      }),
    ).not.toBe(sessionHash(base));
  });

  it('changes when `sourceHash` changes, so the seal cannot float free of the file', () => {
    // Without it the same event set over a different catalogue hashes the same,
    // and «91069 = 2» is a fact about a bodega only in company with the file
    // that says what 91069 is and what Zeus believed was on the shelf.
    expect(sessionHash({ ...base, sourceHash: 'b'.repeat(64) })).not.toBe(sessionHash(base));
  });

  it('changes when a chain is truncated, even with the same head', () => {
    // The lengths are in the hash so a missing tail is visible in the seal and
    // not only in the chain that lost it.
    expect(
      sessionHash({ ...base, counters: [{ ...counters[0], maxSeq: 11 }, counters[1]] }),
    ).not.toBe(sessionHash(base));
  });

  it('does not depend on the order the counters are handed in', () => {
    expect(sessionHash({ ...base, counters: [counters[1], counters[0]] })).toBe(
      sessionHash(base),
    );
  });

  it('cannot have a counter head and the action head exchanged', () => {
    // The tags are what stop it: `['contadores', …]` and `['acciones', …]` are
    // different byte sequences however similar their contents.
    const a = sessionHash({
      ...base,
      counters: [{ counterId: 'x', maxSeq: 1, headHash: 'uno' }],
      actionHead: 'dos',
      actionMaxSeq: 1,
    });
    const b = sessionHash({
      ...base,
      counters: [{ counterId: 'x', maxSeq: 1, headHash: 'dos' }],
      actionHead: 'uno',
      actionMaxSeq: 1,
    });
    expect(a).not.toBe(b);
  });

  it('is anchored to the session', () => {
    expect(sessionHash({ ...base, sessionId: 'otra' })).not.toBe(sessionHash(base));
  });
});
