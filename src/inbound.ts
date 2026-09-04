import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { chunkText, MaxClient } from "./client.js";
import { MAX_CHANNEL_ID, type MaxResolvedAccount } from "./config.js";
import { getMaxRuntime } from "./runtime-store.js";
import type { MaxSendTarget, MaxUpdate } from "./types.js";

export type MaxInboundLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

/** Разрешён ли отправитель писать боту при текущей политике личных сообщений. */
export function isSenderAllowed(
  account: MaxResolvedAccount,
  senderId: string,
): boolean {
  switch (account.dmPolicy) {
    case "open":
      return true;
    case "disabled":
      return false;
    case "allowlist":
    case "pairing":
    default:
      return account.allowFrom.includes(senderId);
  }
}

/**
 * Куда отвечать.
 *
 * `chat_id` универсален: он есть и у диалога, и у группы. Его и берём первым.
 * `recipient.user_id` в диалоге — это САМ БОТ (кому адресовано входящее), по нему
 * отвечать нельзя: MAX возвращает `Invalid chatId: 0`. Поэтому пользовательский
 * адрес — только как запасной путь и только если это не сам бот.
 */
export function resolveSendTarget(
  update: MaxUpdate,
  botUserId?: number,
): MaxSendTarget | null {
  const recipient = update.message?.recipient;
  if (recipient?.chat_id) return { chatId: recipient.chat_id };

  const recipientUser = recipient?.user_id;
  if (recipientUser && recipientUser !== botUserId) {
    return { userId: recipientUser };
  }

  const senderId = update.message?.sender?.user_id;
  if (senderId) return { userId: senderId };
  return null;
}

function senderLabel(update: MaxUpdate): string {
  const sender = update.message?.sender;
  const name = [sender?.first_name, sender?.last_name].filter(Boolean).join(" ");
  return name || sender?.username || sender?.name || String(sender?.user_id ?? "unknown");
}

export type HandleMaxMessageParams = {
  cfg: OpenClawConfig;
  accountId: string;
  account: MaxResolvedAccount;
  client: MaxClient;
  update: MaxUpdate;
  botUserId: number | undefined;
  log?: MaxInboundLog;
  signal?: AbortSignal;
};

/**
 * Один входящий `message_created`: проверка доступа, запуск агента и доставка
 * ответа обратно в MAX.
 *
 * Возвращает `false`, когда событие сознательно пропущено (не текст, эхо
 * собственного сообщения, отправитель не в списке) — вызывающая сторона
 * использует это только для логов.
 */
export async function handleMaxMessage(
  params: HandleMaxMessageParams,
): Promise<boolean> {
  const { update, account, client, cfg, accountId, log } = params;
  const message = update.message;
  const sender = message?.sender;
  const text = message?.body?.text?.trim() ?? "";

  if (!message || !sender?.user_id) return false;
  if (sender.is_bot || (params.botUserId && sender.user_id === params.botUserId)) {
    return false;
  }
  if (!text) {
    // Вложения появятся во второй фазе; сейчас честно молчим, а не эхо-отвечаем.
    // Форму вложений документация MAX не описывает — печатаем сырой JSON,
    // чтобы узнать её эмпирически.
    log?.info?.(
      `max: сообщение без текста от ${sender.user_id};` +
        ` attachments=${JSON.stringify(message.body?.attachments ?? null)}`,
    );
    return false;
  }

  const senderId = String(sender.user_id);
  if (!isSenderAllowed(account, senderId)) {
    log?.warn?.(
      `max: отправитель ${senderId} отклонён политикой ${account.dmPolicy}`,
    );
    return false;
  }

  const target = resolveSendTarget(update, params.botUserId);
  if (!target) {
    log?.warn?.(
      `max: не удалось определить адрес ответа для ${senderId};` +
        ` recipient=${JSON.stringify(message.recipient ?? null)}`,
    );
    return false;
  }
  log?.info?.(
    `max: сообщение от ${senderId}, отвечаю в ${JSON.stringify(target)}`,
  );

  const mid = message.body.mid;

  await dispatchInboundDirectDmWithRuntime({
    runtime: getMaxRuntime(),
    cfg,
    channel: MAX_CHANNEL_ID,
    channelLabel: "MAX",
    accountId,
    peer: { kind: "direct", id: senderId },
    senderId,
    senderAddress: senderId,
    recipientAddress: params.botUserId ? String(params.botUserId) : accountId,
    conversationLabel: senderLabel(update),
    rawBody: text,
    messageId: mid,
    timestamp: message.timestamp ?? update.timestamp,
    inboundAccessAuthorized: true,
    channelIngress: "unsupported",
    deliver: async (payload) => {
      const outText = payload.text?.trim();
      if (!outText) return;
      for (const chunk of chunkText(outText)) {
        await client.sendText({
          target,
          text: chunk,
          signal: params.signal,
        });
      }
    },
    onRecordError: (err) => {
      log?.error?.(`max: не удалось записать сессию: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      log?.error?.(`max: ошибка обработки (${info.kind}): ${String(err)}`);
    },
  });

  return true;
}
