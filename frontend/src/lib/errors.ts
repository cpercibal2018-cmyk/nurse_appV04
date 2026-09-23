import { ApiError } from '../services/http';

/** A message fit to show a user, with the request id when the server gave one (for support). */
export function describeApiError(e: unknown): string {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details)
      ? (e.details as Array<{ path?: string; message?: string }>).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ')
      : '';
    return [e.message, details, e.requestId ? `(ref ${e.requestId.slice(0, 8)})` : ''].filter(Boolean).join(' ');
  }
  return e instanceof Error ? e.message : String(e);
}
