/**
 * RFC 3161: a neutral clock on the seal.
 *
 * `sessionHash` proves the sealed set is internally consistent. It does not
 * prove *when* it existed — a hash has no time in it, and until a copy leaves
 * the building it is only as trustworthy as whoever holds the database. This
 * module sends the hash (just the 32 bytes, no count data) to a public
 * Timestamp Authority, which signs `hash + hora` with its own key. Anyone can
 * later verify that token against the TSA's published certificates:
 *
 *     openssl ts -verify -digest <sessionHash> -in sello_<id>.tsr \
 *       -CAfile <cadena de la TSA>
 *
 * ## Hand-rolled DER, deliberately
 *
 * The request is ~60 fixed bytes and the response walk touches five node
 * types. An ASN.1 library would be a dependency an auditor has to trust for
 * something a page of code states exactly; this repository already makes that
 * trade for SHA-256 (`src/lib/hash.ts`) and base64 (`src/lib/base64.ts`).
 *
 * What the parse checks — and what it does not: it confirms the TSA said
 * «granted», that the token covers exactly our hash, and that the nonce we
 * sent came back (a replayed old response would carry the wrong one). It does
 * **not** verify the TSA's signature chain; that is the auditor's step, with
 * the TSA's own certificates, which is the point — the claim is only worth
 * something because this server *cannot* manufacture it.
 *
 * ## Best-effort by contract
 *
 * The caller treats a failure here as «no timestamp yet», never as «no seal»:
 * the token binds only `sessionHash`, which is immutable after the seal, so
 * it can be requested again later. Late is a weaker claim («existía el
 * martes»), not a wrong one.
 */
import { toBase64 } from '../src/lib/base64.js';

/** DigiCert's public TSA. Free, no account; `TSA_URL` overrides. */
export const DEFAULT_TSA_URL = 'http://timestamp.digicert.com';

export interface TsaStamp {
  /** The whole DER `TimeStampResp`, base64 — the bytes a `.tsr` file holds. */
  token: string;
  /** `genTime` from the token, as UTC ISO-8601. */
  at: string;
  /** Who answered. Printed on the acta so the auditor knows whose chain to fetch. */
  url: string;
}

// ---------------------------------------------------------------------------
// DER encoding — tag, length, value.

function tlv(tag: number, value: Uint8Array): Uint8Array {
  let header: number[];
  if (value.length < 0x80) {
    header = [tag, value.length];
  } else if (value.length < 0x100) {
    header = [tag, 0x81, value.length];
  } else {
    header = [tag, 0x82, value.length >> 8, value.length & 0xff];
  }
  const out = new Uint8Array(header.length + value.length);
  out.set(header, 0);
  out.set(value, header.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A positive INTEGER: DER demands a leading zero when the high bit is set. */
function derInteger(bytes: Uint8Array): Uint8Array {
  return tlv(0x02, bytes[0] & 0x80 ? concat(new Uint8Array([0]), bytes) : bytes);
}

/** OID 2.16.840.1.101.3.4.2.1 — SHA-256 — pre-encoded; it never varies. */
const SHA256_OID = new Uint8Array([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
const DER_NULL = new Uint8Array([0x05, 0x00]);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The `TimeStampReq`: version 1, our hash under SHA-256, a nonce, and
 * `certReq TRUE` so the response carries the TSA's certificate — the auditor
 * verifying years later should not have to hunt for it.
 */
export function buildTimeStampReq(hashHex: string, nonce: Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) {
    throw new Error(`el hash a sellar no es un SHA-256 en hex: «${hashHex.slice(0, 16)}…»`);
  }
  return tlv(
    0x30,
    concat(
      derInteger(new Uint8Array([1])),
      // messageImprint ::= SEQUENCE { AlgorithmIdentifier, OCTET STRING }
      tlv(0x30, concat(tlv(0x30, concat(SHA256_OID, DER_NULL)), tlv(0x04, hexToBytes(hashHex)))),
      derInteger(nonce),
      new Uint8Array([0x01, 0x01, 0xff]), // certReq TRUE
    ),
  );
}

// ---------------------------------------------------------------------------
// DER reading — just enough structure to find genTime and check the imprint.

interface Node {
  tag: number;
  /** Offset of the first value byte. */
  start: number;
  /** Offset past the last value byte. */
  end: number;
}

function readNode(bytes: Uint8Array, offset: number): Node {
  if (offset + 2 > bytes.length) throw new Error('DER truncado');
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > bytes.length) throw new Error('DER truncado');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];
    start += count;
  }
  if (start + length > bytes.length) throw new Error('DER truncado');
  return { tag, start, end: start + length };
}

function children(bytes: Uint8Array, node: Node): Node[] {
  const kids: Node[] = [];
  let offset = node.start;
  while (offset < node.end) {
    const kid = readNode(bytes, offset);
    kids.push(kid);
    offset = kid.end;
  }
  return kids;
}

function slice(bytes: Uint8Array, node: Node): Uint8Array {
  return bytes.subarray(node.start, node.end);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Leading zeros off, for comparing INTEGER values however they were padded. */
function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return bytes.subarray(start);
}

/**
 * A nonce DER can carry minimally: leading zeros dropped (an INTEGER may not
 * start `00` unless the next byte's high bit forces it), never empty.
 */
export function normalizeNonce(bytes: Uint8Array): Uint8Array {
  const clean = stripLeadingZeros(bytes);
  return clean.length === 1 && clean[0] === 0 ? new Uint8Array([1]) : clean;
}

/** `YYYYMMDDHHMMSS[.fff]Z` → `YYYY-MM-DDTHH:MM:SS[.fff]Z`. */
function generalizedTimeToIso(text: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(text);
  if (!match) throw new Error(`genTime ilegible: «${text}»`);
  const [, y, mo, d, h, mi, s, frac] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ?? ''}Z`;
}

/** OID 1.2.840.113549.1.9.16.1.4 — id-ct-TSTInfo. */
const TSTINFO_OID = new Uint8Array([0x06, 0x0b, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04]);

/**
 * Walk `TimeStampResp → ContentInfo → SignedData → TSTInfo` and hold the
 * token to its word: granted, over our hash, answering our nonce.
 */
export function parseTimeStampResp(
  bytes: Uint8Array,
  hashHex: string,
  nonce: Uint8Array,
): { at: string } {
  const root = readNode(bytes, 0);
  if (root.tag !== 0x30) throw new Error('la respuesta de la TSA no es DER');
  const [statusInfo, contentInfo] = children(bytes, root);

  const status = children(bytes, statusInfo)[0];
  const statusValue = slice(bytes, status);
  // 0 = granted, 1 = grantedWithMods; anything else is a refusal.
  if (status.tag !== 0x02 || statusValue.length !== 1 || statusValue[0] > 1) {
    throw new Error(`la TSA no concedió el sello (status ${statusValue[0] ?? '?'})`);
  }
  if (!contentInfo) throw new Error('la TSA concedió pero no envió el token');

  // ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT SignedData }
  const signedData = readNode(bytes, children(bytes, contentInfo)[1].start);
  // SignedData ::= SEQUENCE { version, digestAlgorithms, encapContentInfo, … }
  const encap = children(bytes, signedData)[2];
  const [eContentType, eContentWrap] = children(bytes, encap);
  if (!sameBytes(bytes.subarray(eContentType.start - 2, eContentType.end), TSTINFO_OID)) {
    throw new Error('el token no contiene un TSTInfo');
  }
  // eContent ::= [0] EXPLICIT OCTET STRING — the TSTInfo's own DER.
  const octet = readNode(bytes, eContentWrap.start);
  const tstInfo = readNode(bytes, octet.start);
  const fields = children(bytes, tstInfo);

  // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber,
  //                        genTime, accuracy?, ordering?, nonce?, … }
  const imprint = children(bytes, fields[2]);
  if (!sameBytes(slice(bytes, imprint[1]), hexToBytes(hashHex))) {
    throw new Error('el token de la TSA no cubre el hash que se le envió');
  }
  const genTime = fields[4];
  if (genTime.tag !== 0x18) throw new Error('el TSTInfo no trae genTime donde debe');

  // The nonce, if echoed, must be ours: a replayed response carries another.
  const echoed = fields.slice(5).find((field) => field.tag === 0x02);
  if (echoed && !sameBytes(stripLeadingZeros(slice(bytes, echoed)), stripLeadingZeros(nonce))) {
    throw new Error('la TSA respondió a otra petición: el nonce no coincide');
  }

  return { at: generalizedTimeToIso(new TextDecoder().decode(slice(bytes, genTime))) };
}

// ---------------------------------------------------------------------------

/**
 * One request, one token. Throws on anything short of a granted, verified
 * token — the caller decides whether that blocks (retry op) or not (seal).
 */
export async function requestTimestamp(
  hashHex: string,
  options: {
    url?: string;
    fetcher?: typeof fetch;
    /** Injected in tests; production randomness comes from the platform. */
    nonce?: Uint8Array;
    timeoutMs?: number;
  } = {},
): Promise<TsaStamp> {
  const url = options.url ?? DEFAULT_TSA_URL;
  const fetcher = options.fetcher ?? fetch;
  const nonce = normalizeNonce(options.nonce ?? crypto.getRandomValues(new Uint8Array(8)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: buildTimeStampReq(hashHex, nonce),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`la TSA respondió ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { at } = parseTimeStampResp(bytes, hashHex, nonce);
    return { token: toBase64(bytes), at, url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The production wiring: reads `TSA_URL` (absent = DigiCert, `off` = no
 * timestamps, e.g. an air-gapped deployment). Handlers pass this into
 * `sealSession`; the pg tests call the decision functions without it, so no
 * test ever talks to a real TSA.
 */
export function timestamperFromEnv(
  env: NodeJS.ProcessEnv,
): ((hashHex: string) => Promise<TsaStamp>) | undefined {
  if (env.TSA_URL === 'off') return undefined;
  const url = env.TSA_URL || DEFAULT_TSA_URL;
  return (hashHex) => requestTimestamp(hashHex, { url });
}
