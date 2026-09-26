// Starts receiving Telegram messages the way TELEGRAM_UPDATES says (D-66).
// Polling runs where the jobs run (the API in development, the worker in
// production), so exactly one process polls; the webhook is registered by the
// API, which serves it. Nothing happens with the mock driver.

import type { Env } from '../config/env.js';
import { describeError, logger } from '../lib/logger.js';
import { createBotApi, startTelegramPolling, type TelegramUpdate } from '../lib/telegram-updates.js';

/** `poll`: this process runs the jobs; `serves`: this process is the API (it registers the webhook). */
export function startTelegramUpdates(env: Env, handle: (u: TelegramUpdate) => Promise<void>, { poll, serves }: { poll: boolean; serves: boolean }): () => void {
  if (env.NOTIFICATION_DRIVER !== 'telegram') return () => undefined;
  const api = createBotApi(env.TELEGRAM_BOT_TOKEN);
  if (env.TELEGRAM_UPDATES === 'polling') return poll ? startTelegramPolling(api, handle) : () => undefined;
  if (serves) {
    const url = `${(env.APP_BASE_URL ?? env.CORS_ORIGIN).replace(/\/$/, '')}/api/v1/telegram/webhook`;
    api.setWebhook(url, env.TELEGRAM_WEBHOOK_SECRET)
      .then(() => logger.info('telegram webhook registered', { url }))
      .catch((e) => logger.error('telegram webhook not registered', describeError(e)));
  }
  return () => undefined;
}
