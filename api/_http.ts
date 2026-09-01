/**
 * The request and response, typed structurally so `api/` imports no framework.
 *
 * Same choice as `api/health.ts` made in P2.0: Vercel's own types would put a
 * package in the dependency graph of every handler and in front of every test,
 * to describe two objects with four members between them.
 */
export interface ApiRequest {
  method?: string;
  /** Path and query parameters. Vercel merges the two; `[token]` arrives here. */
  query?: Record<string, string | string[] | undefined>;
  /** Parsed JSON when the content type says so, and whatever arrived when it does not. */
  body?: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** What every handler returns before it touches a response object. */
export interface ApiResult {
  status: number;
  body: unknown;
}

export function ok(body: unknown): ApiResult {
  return { status: 200, body };
}

export function created(body: unknown): ApiResult {
  return { status: 201, body };
}

/**
 * A refusal, in the shape every screen reads.
 *
 * `error` is a sentence somebody can act on; `detalle` carries the structured
 * form when there is one — the §4.1 faults, the dispatch blockers, the rows
 * that did not match. A UI that had only the sentence would be reduced to
 * parsing it back apart.
 */
export function fail(status: number, error: string, detalle?: unknown): ApiResult {
  return { status, body: detalle === undefined ? { error } : { error, detalle } };
}

/** The single string a `[param]` route segment is, or null if it arrived as a list. */
export function param(request: ApiRequest, name: string): string | null {
  const value = request.query?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Write an `ApiResult` out, never cached.
 *
 * The header is set before anything else can fail, so even a rejection is
 * uncacheable. `vercel.json` sets the same header at the edge; both, because a
 * cached answer about who counts what is a tablet loading last week's
 * partition.
 */
export function send(response: ApiResponse, result: ApiResult): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.status(result.status).json(result.body);
}

/** Turn whatever was thrown into a sentence, without leaking a stack. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
