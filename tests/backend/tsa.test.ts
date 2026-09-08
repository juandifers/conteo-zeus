/**
 * RFC 3161 — `api/_tsa.ts`.
 *
 * No network and no database: a timestamp request is sixty deterministic
 * bytes and the response walk is arithmetic over a byte array, so the whole
 * thing tests like the HMAC does. The response fixtures are built here with
 * the same DER rules the module encodes with — the parser does not verify
 * the TSA's signature (the auditor does, with the TSA's certificates), so a
 * fixture with an empty signerInfos is exactly as parseable as DigiCert's.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildTimeStampReq,
  normalizeNonce,
  parseTimeStampResp,
  requestTimestamp,
} from '../../api/_tsa';
import { fromBase64 } from '../../src/lib/base64';

const HASH = 'ab'.repeat(32);
const NONCE = new Uint8Array([0x12, 0x34]);

// ---------------------------------------------------------------------------
// Just enough DER to build a TimeStampResp fixture.

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length >= 0x100) throw new Error('fixture demasiado grande');
  const header = length < 0x80 ? [tag, length] : [tag, 0x81, length];
  const out = new Uint8Array(header.length + length);
  out.set(header, 0);
  let offset = header.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const bytes = (...values: number[]) => new Uint8Array(values);
const SHA256_OID = bytes(0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01);
const SIGNED_DATA_OID = bytes(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02);
const TSTINFO_OID = bytes(0x06, 0x0b, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04);

function hashBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

function fixtureResp(over: { status?: number; hash?: string; nonce?: Uint8Array; genTime?: string } = {}): Uint8Array {
  const tstInfo = tlv(
    0x30,
    tlv(0x02, bytes(1)), // version
    bytes(0x06, 0x03, 0x2a, 0x03, 0x04), // policy 1.2.3.4
    tlv(0x30, tlv(0x30, SHA256_OID, bytes(0x05, 0x00)), tlv(0x04, hashBytes(over.hash ?? HASH))),
    tlv(0x02, bytes(42)), // serialNumber
    tlv(0x18, new TextEncoder().encode(over.genTime ?? '20260908150405Z')),
    tlv(0x02, over.nonce ?? NONCE),
  );
  const signedData = tlv(
    0x30,
    tlv(0x02, bytes(3)),
    tlv(0x31), // digestAlgorithms: empty SET
    tlv(0x30, TSTINFO_OID, tlv(0xa0, tlv(0x04, tstInfo))),
    tlv(0x31), // signerInfos: empty — the parser leaves signatures to the auditor
  );
  return tlv(
    0x30,
    tlv(0x30, tlv(0x02, bytes(over.status ?? 0))),
    tlv(0x30, SIGNED_DATA_OID, tlv(0xa0, signedData)),
  );
}

describe('the request', () => {
  it('is the exact DER RFC 3161 describes, byte for byte', () => {
    const hex = Array.from(buildTimeStampReq(HASH, NONCE), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(hex).toBe(
      '303d' + // TimeStampReq
        '020101' + // version 1
        '3031300d06096086480165030402010500' + // messageImprint: sha256 + NULL
        '0420' + HASH + // the 32 bytes being stamped
        '02021234' + // nonce
        '0101ff', // certReq TRUE
    );
  });

  it('refuses anything that is not a SHA-256 in hex', () => {
    expect(() => buildTimeStampReq('abc', NONCE)).toThrow(/no es un SHA-256/);
  });

  it('normalizes a nonce DER could not carry minimally', () => {
    expect([...normalizeNonce(new Uint8Array([0, 0, 0x12]))]).toEqual([0x12]);
    expect([...normalizeNonce(new Uint8Array([0, 0, 0]))]).toEqual([1]);
  });
});

describe('the response walk', () => {
  it('finds genTime inside a granted token over our hash', () => {
    expect(parseTimeStampResp(fixtureResp(), HASH, NONCE)).toEqual({
      at: '2026-09-08T15:04:05Z',
    });
  });

  it('keeps fractional seconds when the TSA sends them', () => {
    expect(parseTimeStampResp(fixtureResp({ genTime: '20260908150405.123Z' }), HASH, NONCE)).toEqual({
      at: '2026-09-08T15:04:05.123Z',
    });
  });

  it('rejects a refusal, a token over another hash, and an answer to another nonce', () => {
    expect(() => parseTimeStampResp(fixtureResp({ status: 2 }), HASH, NONCE)).toThrow(
      /no concedió/,
    );
    expect(() => parseTimeStampResp(fixtureResp({ hash: 'cd'.repeat(32) }), HASH, NONCE)).toThrow(
      /no cubre el hash/,
    );
    expect(() =>
      parseTimeStampResp(fixtureResp({ nonce: new Uint8Array([0x56, 0x78]) }), HASH, NONCE),
    ).toThrow(/nonce no coincide/);
  });

  it('rejects truncated bytes instead of reading past them', () => {
    expect(() => parseTimeStampResp(fixtureResp().slice(0, 10), HASH, NONCE)).toThrow(
      /DER truncado/,
    );
  });
});

describe('the request-response round trip', () => {
  it('posts the query and hands back the token as .tsr bytes plus the certified time', async () => {
    const resp = fixtureResp();
    const fetcher = vi.fn(async (url: unknown, init: unknown) => {
      const request = init as { method: string; headers: Record<string, string>; body: Uint8Array };
      expect(url).toBe('https://tsa.example/stamp');
      expect(request.method).toBe('POST');
      expect(request.headers['Content-Type']).toBe('application/timestamp-query');
      expect(request.body[0]).toBe(0x30);
      return new Response(resp.slice().buffer, { status: 200 });
    });

    const stamp = await requestTimestamp(HASH, {
      url: 'https://tsa.example/stamp',
      fetcher: fetcher as unknown as typeof fetch,
      nonce: NONCE,
    });
    expect(stamp.at).toBe('2026-09-08T15:04:05Z');
    expect(stamp.url).toBe('https://tsa.example/stamp');
    // The stored token is the response verbatim: what `openssl ts` reads.
    expect([...fromBase64(stamp.token)]).toEqual([...resp]);
  });

  it('throws on an HTTP refusal — the caller decides whether that blocks', async () => {
    const fetcher = vi.fn(async () => new Response('no', { status: 500 }));
    await expect(
      requestTimestamp(HASH, { fetcher: fetcher as unknown as typeof fetch, nonce: NONCE }),
    ).rejects.toThrow(/la TSA respondió 500/);
  });
});
