import { createHash } from "node:crypto";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { MAX_API_BASE_URL } from "./client.js";

export const MAX_CHANNEL_ID = "max";

export type MaxDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type MaxGroupPolicy = "allowlist" | "open" | "disabled";

/** Сырая секция конфига — общая для корня и для именованного аккаунта. */
type MaxSectionShape = {
  enabled?: boolean;
  token?: string;
  tokenFile?: string;
  apiBaseUrl?: string;
  dmPolicy?: MaxDmPolicy;
  allowFrom?: string[];
  groupPolicy?: MaxGroupPolicy;
  pollTimeoutSec?: number;
  pollLimit?: number;
  /** Публичный адрес шлюза. Задан — канал работает вебхуком, иначе опросом. */
  webhookPublicUrl?: string;
};

type MaxRootSection = MaxSectionShape & {
  defaultAccount?: string;
  accounts?: Record<string, MaxSectionShape>;
};

export type MaxResolvedAccount = {
  accountId: string | null;
  enabled: boolean;
  /** Токен уже материализован (из `token` или `tokenFile`). Пуст, если не задан. */
  token: string;
  tokenSource: "inline" | "file" | "missing";
  apiBaseUrl: string;
  dmPolicy: MaxDmPolicy;
  allowFrom: string[];
  groupPolicy: MaxGroupPolicy;
  pollTimeoutSec: number;
  pollLimit: number;
  /** Публичная база для вебхука, без хвостового слеша. Пусто — работаем опросом. */
  webhookPublicUrl: string;
};

export const DEFAULT_POLL_TIMEOUT_SEC = 30;
export const DEFAULT_POLL_LIMIT = 100;

export function readMaxRootSection(cfg: OpenClawConfig): MaxRootSection {
  const channels = (cfg as { channels?: Record<string, unknown> })?.channels;
  return ((channels?.[MAX_CHANNEL_ID] as MaxRootSection) ?? {}) as MaxRootSection;
}

/**
 * Идентификаторы аккаунтов. `default` присутствует всегда: даже когда
 * конфига нет, ядру нужен хотя бы один аккаунт для диагностики.
 */
export function listMaxAccountIds(cfg: OpenClawConfig): string[] {
  const root = readMaxRootSection(cfg);
  const named = Object.keys(root.accounts ?? {});
  return named.includes("default") ? named : ["default", ...named];
}

export function resolveMaxDefaultAccountId(cfg: OpenClawConfig): string {
  const root = readMaxRootSection(cfg);
  return root.defaultAccount ?? "default";
}

function normalizeAllowFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Разрешение аккаунта: значения именованного аккаунта перекрывают корневые,
 * корневые служат общими умолчаниями. Тот же порядок, что у штатных каналов.
 */
export function resolveMaxAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): MaxResolvedAccount {
  const root = readMaxRootSection(cfg);
  const id = accountId ?? null;
  const named =
    id && id !== "default" ? (root.accounts?.[id] ?? {}) : (root.accounts?.default ?? {});

  const pick = <K extends keyof MaxSectionShape>(key: K): MaxSectionShape[K] =>
    named[key] !== undefined ? named[key] : root[key];

  const inlineToken = pick("token");
  const tokenFile = pick("tokenFile");
  let token = typeof inlineToken === "string" ? inlineToken.trim() : "";
  let tokenSource: MaxResolvedAccount["tokenSource"] = token ? "inline" : "missing";

  if (!token && tokenFile) {
    const fromFile = tryReadSecretFileSync(tokenFile, "MAX bot token");
    if (fromFile) {
      token = fromFile.trim();
      tokenSource = "file";
    }
  }

  return {
    accountId: id,
    enabled: pick("enabled") !== false,
    token,
    tokenSource,
    apiBaseUrl: pick("apiBaseUrl") ?? MAX_API_BASE_URL,
    dmPolicy: pick("dmPolicy") ?? "pairing",
    allowFrom: normalizeAllowFrom(pick("allowFrom")),
    groupPolicy: pick("groupPolicy") ?? "allowlist",
    pollTimeoutSec: pick("pollTimeoutSec") ?? DEFAULT_POLL_TIMEOUT_SEC,
    pollLimit: pick("pollLimit") ?? DEFAULT_POLL_LIMIT,
    webhookPublicUrl: (pick("webhookPublicUrl") ?? "").trim().replace(/\/+$/, ""),
  };
}

/**
 * Секрет в пути вебхука.
 *
 * Выводится из токена бота, поэтому стабилен между перезапусками, не требует
 * хранения и не угадывается тем, кто токена не знает. MAX запросы не подписывает,
 * так что незнание пути — единственная защита от посторонних POST'ов.
 */
export function deriveWebhookSecret(token: string): string {
  return createHash("sha256").update(`max-webhook:${token}`).digest("hex").slice(0, 32);
}

/** Локальный путь маршрута на шлюзе. */
export function buildWebhookPath(accountId: string, token: string): string {
  return `/max/webhook/${encodeURIComponent(accountId)}/${deriveWebhookSecret(token)}`;
}

/** Полный адрес, который отдаётся мессенджеру MAX. */
export function buildWebhookUrl(account: MaxResolvedAccount, accountId: string): string {
  if (!account.webhookPublicUrl || !account.token) return "";
  return account.webhookPublicUrl + buildWebhookPath(accountId, account.token);
}

/** Метаданные для диагностики: без материализации секрета. */
export function inspectMaxAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveMaxAccount(cfg, accountId);
  return {
    enabled: account.enabled,
    configured: account.token.length > 0,
    tokenStatus: account.token.length > 0 ? "available" : "missing",
    tokenSource: account.tokenSource,
  };
}
