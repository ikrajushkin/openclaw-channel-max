import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { MaxClient } from "./client.js";
import { buildWebhookPath, buildWebhookUrl, type MaxResolvedAccount } from "./config.js";
import { handleMaxMessage, type MaxInboundLog } from "./inbound.js";
import type { MaxUpdate } from "./types.js";

/** Сколько mid держим против повторной доставки: MAX умеет присылать дубли. */
const SEEN_MID_LIMIT = 2000;

/** Тело запроса больше этого отбрасываем не читая — простая защита от мусора. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

type AccountRuntime = {
  cfg: OpenClawConfig;
  accountId: string;
  account: MaxResolvedAccount;
  client: MaxClient;
  botUserId?: number;
  log?: MaxInboundLog;
  seen: Set<string>;
};

/**
 * Аккаунты, обслуживаемые вебхуком.
 *
 * Обработчик маршрута видит только запрос, поэтому всё нужное для разбора
 * кладём сюда при старте аккаунта и убираем при остановке.
 */
const accounts = new Map<string, AccountRuntime>();

export function registerWebhookAccount(rt: Omit<AccountRuntime, "seen">): void {
  accounts.set(rt.accountId, { ...rt, seen: new Set() });
}

export function unregisterWebhookAccount(accountId: string): void {
  accounts.delete(accountId);
}

export function listWebhookAccountIds(): string[] {
  return [...accounts.keys()];
}

/** Пути всех настроенных вебхуков — шлюзу, чтобы пропускал их без авторизации. */
export function collectWebhookPaths(
  cfg: OpenClawConfig,
  listAccountIds: (cfg: OpenClawConfig) => string[],
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => MaxResolvedAccount,
): string[] {
  const paths: string[] = [];
  for (const accountId of listAccountIds(cfg)) {
    const account = resolveAccount(cfg, accountId);
    if (!account.token || !account.webhookPublicUrl) continue;
    paths.push(buildWebhookPath(accountId, account.token));
  }
  return paths;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("тело запроса слишком велико"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function rememberMid(rt: AccountRuntime, mid: string): boolean {
  if (rt.seen.has(mid)) return false;
  rt.seen.add(mid);
  if (rt.seen.size > SEEN_MID_LIMIT) {
    const excess = rt.seen.size - SEEN_MID_LIMIT;
    let dropped = 0;
    for (const key of rt.seen) {
      rt.seen.delete(key);
      if (++dropped >= excess) break;
    }
  }
  return true;
}

/**
 * Обработчик входящего вебхука.
 *
 * Разбор доводится до конца ДО ответа мессенджеру. Отвечать раньше нельзя:
 * с закрытием ответа рушится область выполнения запроса, и запуск агента
 * отклоняется с GatewayDrainingError. Плата — MAX ждёт всё время работы
 * агента; от повторной доставки по таймауту защищает дедуп по mid.
 */
export function createWebhookHandler(accountId: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rt = accounts.get(accountId);
    if (!rt) {
      res.statusCode = 503;
      res.end("account not running");
      return true;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return true;
    }

    let update: MaxUpdate | undefined;
    try {
      const raw = await readBody(req);
      update = JSON.parse(raw) as MaxUpdate;
    } catch (err) {
      rt.log?.warn?.(`max[${accountId}]: вебхук — не удалось разобрать тело: ${String(err)}`);
      res.statusCode = 400;
      res.end("bad request");
      return true;
    }

    try {
      await processUpdate(rt, update);
    } catch (err) {
      rt.log?.error?.(`max[${accountId}]: обработка вебхука упала: ${String(err)}`);
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
    return true;
  };
}

async function processUpdate(rt: AccountRuntime, update: MaxUpdate): Promise<void> {
  if (update.update_type !== "message_created") {
    rt.log?.info?.(
      `max[${rt.accountId}]: вебхук — событие ${update.update_type} не обрабатывается`,
    );
    return;
  }
  if (!update.message) {
    rt.log?.warn?.(
      `max[${rt.accountId}]: вебхук прислал событие без тела: ` +
        JSON.stringify(update).slice(0, 500),
    );
    return;
  }

  const mid = update.message.body?.mid;
  if (mid && !rememberMid(rt, mid)) {
    rt.log?.info?.(`max[${rt.accountId}]: повторная доставка ${mid}, пропуск`);
    return;
  }

  await handleMaxMessage({
    cfg: rt.cfg,
    accountId: rt.accountId,
    account: rt.account,
    client: rt.client,
    update,
    botUserId: rt.botUserId,
    log: rt.log,
  });
}

/**
 * Привести подписки к одной — нашей.
 *
 * MAX подписки копит, а не заменяет, и отписывает бота после восьми часов без
 * успешного ответа. Поэтому при каждом старте снимаем всё лишнее и регистрируем
 * подписку заново, даже если она вроде бы уже есть.
 */
export async function syncSubscription(params: {
  client: MaxClient;
  account: MaxResolvedAccount;
  accountId: string;
  log?: MaxInboundLog;
  signal?: AbortSignal;
}): Promise<string> {
  const want = buildWebhookUrl(params.account, params.accountId);
  if (!want) return "";

  let existing: Awaited<ReturnType<MaxClient["listSubscriptions"]>> = [];
  try {
    existing = await params.client.listSubscriptions(params.signal);
  } catch (err) {
    params.log?.warn?.(
      `max[${params.accountId}]: не удалось получить список подписок: ${String(err)}`,
    );
  }

  for (const sub of existing) {
    if (!sub.url) continue;
    try {
      await params.client.unsubscribe(sub.url, params.signal);
      params.log?.info?.(`max[${params.accountId}]: снята прежняя подписка`);
    } catch (err) {
      params.log?.warn?.(
        `max[${params.accountId}]: не удалось снять подписку: ${String(err)}`,
      );
    }
  }

  await params.client.subscribe({
    url: want,
    updateTypes: ["message_created", "bot_started"],
    signal: params.signal,
  });
  params.log?.info?.(
    `max[${params.accountId}]: подписка на вебхук зарегистрирована`,
  );
  return want;
}
