export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details?: unknown) {
    super(code);
  }
}

export async function api<T = any>(path: string, init: { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.json !== undefined || init.form ? 'POST' : 'GET');
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    signal: init.signal,
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-Trawer': '1' } : {}),
    },
    body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'request_failed', body.details);
  return body as T;
}
