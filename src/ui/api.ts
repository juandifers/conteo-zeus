/**
 * The browser's side of the backend, in one file.
 *
 * Everything the admin screens and the device-preparation screen do goes
 * through here, for the reason every other port in this codebase exists: a
 * component that called `fetch` directly would be a component no test can run
 * without a server, and this app's tests are the reason its rules hold.
 *
 * **The counting screens do not use this.** P1's count is entirely local and
 * stays that way — not one byte the entry, search or review screens read comes
 * from the network. The one crossing point is `fetchAssignment`, which runs
 * once, on office wifi, before the tablet leaves (P2.1 §4c).
 */

/** A refusal from the server, with the structured half kept. */
export class ApiError extends Error {
  readonly status: number;
  /** The `detalle` the endpoint returned: §4.1 faults, dispatch blockers, row differences. */
  readonly detalle: unknown;

  constructor(status: number, message: string, detalle: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detalle = detalle;
  }
}

/** Injected so a test does not need a server, and a screen does not need a mock of one. */
export type Fetcher = typeof fetch;

async function request<T>(
  fetcher: Fetcher,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (cause) {
    // The offline case, and the one worth naming: on a tablet this is somebody
    // standing in a corridor rather than a server that is down.
    throw new ApiError(
      0,
      `No hay conexión con el servidor (${cause instanceof Error ? cause.message : String(cause)}).`,
      null,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // A non-JSON body from an endpoint that only ever sends JSON means
    // something in front of the function answered — the SPA fallback, a proxy,
    // a login page. Saying so beats a parse error.
    throw new ApiError(response.status, `El servidor respondió algo que no es JSON (${response.status}).`, text.slice(0, 200));
  }

  if (!response.ok) {
    const payload = (parsed ?? {}) as { error?: string; detalle?: unknown };
    throw new ApiError(response.status, payload.error ?? `Error ${response.status}`, payload.detalle);
  }
  return parsed as T;
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function httpApi(fetcher: Fetcher = fetch.bind(globalThis)): Api {
  return {
    get: (path) => request(fetcher, 'GET', path),
    post: (path, body) => request(fetcher, 'POST', path, body ?? {}),
    patch: (path, body) => request(fetcher, 'PATCH', path, body),
    del: (path) => request(fetcher, 'DELETE', path),
  };
}
