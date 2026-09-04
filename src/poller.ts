import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { MaxApiError, MaxClient } from "./client.js";
import type { MaxResolvedAccount } from "./config.js";
import { handleMaxMessage, type MaxInboundLog } from "./inbound.js";

/** Типы событий, которые канал сейчас умеет обрабатывать. */
const SUBSCRIBED_UPDATE_TYPES = ["message_created", "bot_started"];

/** Сколько mid держим для защиты от повторной доставки одного события. */
const SEEN_MID_LIMIT = 2000;

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;

export type MaxPollerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  account: MaxResolvedAccount;
  abortSignal: AbortSignal;
  log?: MaxInboundLog;
  clientFactory?: (account: MaxResolvedAccount) => MaxClient;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Цикл long polling для одного аккаунта.
 *
 * Курсор `marker` живёт в памяти процесса: при перезапуске гейтвея канал
 * стартует с текущего момента и не переигрывает историю. Долговечная очередь
 * (`createChannelIngressMonitor`) — задача следующей фазы.
 */
export async function runMaxPoller(params: MaxPollerParams): Promise<void> {
  const { account, accountId, abortSignal, log } = params;
  const client =
    params.clientFactory?.(account) ??
    new MaxClient({ token: account.token, baseUrl: account.apiBaseUrl });

  let botUserId: number | undefined;
  try {
    const me = await client.getMe(abortSignal);
    botUserId = me.user_id;
    log?.info?.(
      `max[${accountId}]: подключён как ${me.username ?? me.name ?? me.user_id}`,
    );
  } catch (err) {
    if (err instanceof MaxApiError && err.isAuthError) {
      log?.error?.(`max[${accountId}]: токен отклонён (${err.message})`);
      return;
    }
    log?.warn?.(`max[${accountId}]: /me недоступен, продолжаю: ${String(err)}`);
  }

  let marker: number | undefined;
  const seen = new Set<string>();
  let failures = 0;

  while (!abortSignal.aborted) {
    try {
      const res = await client.getUpdates({
        marker,
        limit: account.pollLimit,
        timeoutSec: account.pollTimeoutSec,
        types: SUBSCRIBED_UPDATE_TYPES,
        signal: abortSignal,
      });
      failures = 0;

      for (const update of res.updates ?? []) {
        if (abortSignal.aborted) break;
        if (update.update_type !== "message_created") {
          log?.info?.(
            `max[${accountId}]: событие ${update.update_type} не обрабатывается`,
          );
          continue;
        }

        // Голосовые MAX присылает как message_created вообще без поля message:
        // ни отправителя, ни чата, ни вложения. Ответить тоже некуда.
        if (!update.message) {
          log?.warn?.(
            `max[${accountId}]: событие без тела сообщения — так MAX присылает` +
              " голосовые; содержимое боту недоступно, отвечать некуда",
          );
          continue;
        }

        const mid = update.message?.body?.mid;
        if (mid) {
          if (seen.has(mid)) continue;
          seen.add(mid);
          if (seen.size > SEEN_MID_LIMIT) {
            // Set сохраняет порядок вставки — выкидываем самые старые.
            const excess = seen.size - SEEN_MID_LIMIT;
            let dropped = 0;
            for (const key of seen) {
              seen.delete(key);
              if (++dropped >= excess) break;
            }
          }
        }

        try {
          await handleMaxMessage({
            cfg: params.cfg,
            accountId,
            account,
            client,
            update,
            botUserId,
            log,
            signal: abortSignal,
          });
        } catch (err) {
          log?.error?.(`max[${accountId}]: обработка события упала: ${String(err)}`);
        }
      }

      if (typeof res.marker === "number") marker = res.marker;
    } catch (err) {
      if (abortSignal.aborted) break;
      if (err instanceof MaxApiError && err.isAuthError) {
        log?.error?.(
          `max[${accountId}]: опрос остановлен — токен недействителен (${err.message})`,
        );
        return;
      }
      failures += 1;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      log?.warn?.(
        `max[${accountId}]: опрос не удался (${String(err)}), повтор через ${backoff} мс`,
      );
      await sleep(backoff, abortSignal);
    }
  }

  log?.info?.(`max[${accountId}]: опрос остановлен`);
}
