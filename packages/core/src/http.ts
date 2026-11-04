/**
 * Outbound HTTP with a deadline. Every call to another service (payments, WhatsApp, Instagram,
 * storage, error reporting) goes through this, so one slow upstream can't hold our requests open.
 */
export type Fetch = typeof fetch;

export function fetchWithTimeout(ms: number, base: Fetch = fetch): Fetch {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}
