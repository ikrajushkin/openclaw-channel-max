import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelCapabilities } from "openclaw/plugin-sdk/channel-contract";
import { chunkText, MaxClient } from "./client.js";
import {
  inspectMaxAccount,
  listMaxAccountIds,
  MAX_CHANNEL_ID,
  resolveMaxAccount,
  resolveMaxDefaultAccountId,
  type MaxResolvedAccount,
} from "./config.js";
import { runMaxPoller } from "./poller.js";
import type { MaxSendTarget } from "./types.js";

/** `to` приходит как `user:<id>` / `chat:<id>` либо голым числом (диалог). */
export function parseMaxTarget(to: string): MaxSendTarget | null {
  const raw = to.trim();
  const chat = /^chat:(-?\d+)$/.exec(raw);
  if (chat) return { chatId: Number(chat[1]) };
  const user = /^(?:user:|max:)?(-?\d+)$/.exec(raw);
  if (user) return { userId: Number(user[1]) };
  return null;
}

function clientFor(account: MaxResolvedAccount): MaxClient {
  return new MaxClient({ token: account.token, baseUrl: account.apiBaseUrl });
}

/** Отправка текста с разбиением; возвращает mid последнего куска. */
async function sendTextTo(params: {
  account: MaxResolvedAccount;
  to: string;
  text: string;
}): Promise<string> {
  const target = parseMaxTarget(params.to);
  if (!target) {
    throw new Error(`max: не разобран адрес получателя "${params.to}"`);
  }
  const client = clientFor(params.account);
  let lastMid = "";
  for (const chunk of chunkText(params.text)) {
    const res = await client.sendText({ target, text: chunk });
    lastMid = res.message?.body?.mid ?? lastMid;
  }
  return lastMid;
}

const maxMeta = {
  id: MAX_CHANNEL_ID,
  label: "MAX",
  selectionLabel: "MAX",
  docsPath: "/channels/max",
  blurb: "Мессенджер MAX через Bot API",
  markdownCapable: true,
} as const;

const maxCapabilities: ChannelCapabilities = {
  chatTypes: ["direct", "group"],
  media: false,
  reply: true,
  edit: false,
  reactions: false,
  polls: false,
};

const maxConfigAdapter = {
  listAccountIds: listMaxAccountIds,
  defaultAccountId: resolveMaxDefaultAccountId,
  resolveAccount: resolveMaxAccount,
  inspectAccount: inspectMaxAccount,
  isEnabled: (account: MaxResolvedAccount) => account.enabled,
  isConfigured: (account: MaxResolvedAccount) => account.token.length > 0,
  unconfiguredReason: () =>
    "не задан токен бота MAX (channels.max.tokenFile или channels.max.token)",
  resolveAllowFrom: (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveMaxAccount(params.cfg, params.accountId).allowFrom,
};

const pluginBase = createChannelPluginBase<MaxResolvedAccount>({
  id: MAX_CHANNEL_ID,
  meta: maxMeta,
  capabilities: maxCapabilities,
  reload: { configPrefixes: [`channels.${MAX_CHANNEL_ID}`] },
  config: maxConfigAdapter,
  setup: {
    applyAccountConfig: ({ cfg, input }: { cfg: OpenClawConfig; input: unknown }) => {
      const channels = (cfg as { channels?: Record<string, unknown> }).channels ?? {};
      return {
        ...cfg,
        channels: {
          ...channels,
          [MAX_CHANNEL_ID]: {
            ...(channels[MAX_CHANNEL_ID] as Record<string, unknown>),
            ...(input as Record<string, unknown>),
          },
        },
      };
    },
  },
});

export const maxChannelPlugin = createChatChannelPlugin<MaxResolvedAccount>({
  // `createChannelPluginBase` помечает эти поля необязательными, а базе канала
  // они нужны обязательно — возвращаем их явно.
  base: {
    ...pluginBase,
    meta: maxMeta,
    capabilities: maxCapabilities,
    config: maxConfigAdapter,
  },

  security: {
    dm: {
      channelKey: MAX_CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "pairing",
    },
  },

  pairing: {
    text: {
      idLabel: "user_id в MAX",
      message: "Отправьте этот код владельцу бота для подтверждения:",
      notify: async ({ cfg, id, accountId, message }) => {
        const account = resolveMaxAccount(cfg, accountId ?? null);
        if (!account.token) {
          throw new Error("max: нечем отправить код сопряжения — токен не задан");
        }
        await sendTextTo({ account, to: id, text: message });
      },
    },
  },

  threading: { topLevelReplyToMode: "none" },

  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: MAX_CHANNEL_ID,
      sendText: async (ctx) => {
        const account = resolveMaxAccount(ctx.cfg, ctx.accountId ?? null);
        const messageId = await sendTextTo({
          account,
          to: ctx.to,
          text: ctx.text,
        });
        return { messageId };
      },
    },
  },
});

/**
 * Контекст запуска аккаунта. `createChannelPluginBase` не принимает `gateway`,
 * поэтому рантайм подключаем к готовому объекту канала — и типизируем ровно ту
 * часть контекста, которой пользуемся.
 */
type MaxGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  account: MaxResolvedAccount;
  abortSignal: AbortSignal;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
};

maxChannelPlugin.gateway = {
  startAccount: async (ctx: MaxGatewayContext) => {
    if (!ctx.account.token) {
      ctx.log?.warn?.(`max[${ctx.accountId}]: токен не задан — аккаунт не запущен`);
      return;
    }
    await runMaxPoller({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      account: ctx.account,
      abortSignal: ctx.abortSignal,
      log: ctx.log,
    });
  },
} as typeof maxChannelPlugin.gateway;
