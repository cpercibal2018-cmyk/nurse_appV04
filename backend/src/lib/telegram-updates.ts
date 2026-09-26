// Incoming Telegram messages (D-66): how /start <token> reaches the linking
// service. Two ways, chosen by TELEGRAM_UPDATES:
// - polling: the jobs process long-polls getUpdates (25 s), so a development
//   PC without a public address still receives them;
// - webhook: the API registers /api/v1/telegram/webhook with setWebhook and a
//   secret that Telegram sends back in X-Telegram-Bot-Api-Secret-Token.
// With the mock driver nothing comes from Telegram; the Dev Console simulates
// a message instead.
//
// The token is part of every Bot API URL, so errors log only a status or an
// error name, never the URL.

import { describeError, logger } from './logger.js';

/** The part of a Telegram Update this application reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number; type: string }; text?: string };
}

type Fetch = typeof fetch;
const POLL_SECONDS = 25;

export function createBotApi(token: string, fetchImpl: Fetch = fetch) {
  async function call<T>(method: string, body: object, timeoutMs = 10_000): Promise<T> {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const out = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!res.ok || !out?.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${out?.description?.slice(0, 200) ?? ''}`.trim());
    return out.result as T;
  }
  return {
    getUpdates: (offset: number) => call<TelegramUpdate[]>('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] }, (POLL_SECONDS + 10) * 1000),
    setWebhook: (url: string, secret: string) => call<boolean>('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false }),
    deleteWebhook: () => call<boolean>('deleteWebhook', { drop_pending_updates: false }),
  };
}
export type BotApi = ReturnType<typeof createBotApi>;

/** Long-polls for updates and hands each to `handle`; returns a stop function. One poller per bot. */
export function startTelegramPolling(api: BotApi, handle: (u: TelegramUpdate) => Promise<void>) {
  let stopped = false;
  let offset = 0;
  const loop = async () => {
    try {
      await api.deleteWebhook(); // getUpdates is refused while a webhook is set
    } catch (e) {
      logger.warn('telegram: could not clear the webhook before polling', { error: e instanceof Error ? e.message : 'unknown' });
    }
    logger.info('telegram polling started');
    while (!stopped) {
      try {
        const updates = await api.getUpdates(offset);
        for (const u of updates) {
          offset = u.update_id + 1; // confirmed at the next call, so a crash re-delivers only unhandled ones
          await handle(u).catch((e) => logger.error('telegram update not handled', { updateId: u.update_id, ...describeError(e) }));
        }
      } catch (e) {
        if (stopped) break;
        logger.warn('telegram polling failed; retrying in 10 s', { error: e instanceof Error ? e.message : 'unknown' });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };
  void loop();
  return () => { stopped = true; };
}
