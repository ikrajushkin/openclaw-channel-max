import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { maxChannelPlugin } from "./src/channel.js";
import {
  buildWebhookPath,
  listMaxAccountIds,
  resolveMaxAccount,
} from "./src/config.js";
import { setMaxRuntime } from "./src/runtime-store.js";
import { createWebhookHandler } from "./src/webhook.js";

export default defineChannelPluginEntry({
  id: "max",
  name: "MAX",
  description: "Канал мессенджера MAX для OpenClaw",
  plugin: maxChannelPlugin,
  setRuntime: setMaxRuntime,
  registerFull(api: OpenClawPluginApi) {
    // По маршруту на каждый аккаунт с настроенным вебхуком. Секрет в пути
    // выводится из токена бота, поэтому одинаков при каждой загрузке.
    for (const accountId of listMaxAccountIds(api.config)) {
      const account = resolveMaxAccount(api.config, accountId);
      if (!account.token || !account.webhookPublicUrl) continue;
      api.registerHttpRoute({
        path: buildWebhookPath(accountId, account.token),
        match: "exact",
        auth: "plugin",
        replaceExisting: true,
        handler: createWebhookHandler(accountId),
      });
      api.logger?.info?.(
        `max[${accountId}]: маршрут вебхука зарегистрирован`,
      );
    }
  },
});
