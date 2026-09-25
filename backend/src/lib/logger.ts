// One-line JSON logs (architecture plan: "JSON logs with X-Request-Id; no PII
// in logs"). Callers pass identifiers only — never names, emails, national IDs
// or request bodies.

import { redactIdentifiers } from './field-crypto.js';

type Level = 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function write(level: Level, msg: string, fields: LogFields = {}) {
  // Spec §8.3.4: whatever slips through, a national ID / Iqama number never reaches the log.
  const line = redactIdentifiers(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields),
};

/** Error detail for the log only: name, message and a short stack. Never sent to clients. */
export function describeError(e: unknown): LogFields {
  if (e instanceof Error) {
    return { errorName: e.name, errorMessage: e.message, stack: e.stack?.split('\n').slice(0, 6).join(' | ') };
  }
  return { errorMessage: String(e) };
}
