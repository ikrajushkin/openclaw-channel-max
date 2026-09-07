import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { dispatchMaxTurn } from "./dispatch.js";
import { chunkText, MaxClient } from "./client.js";
import { MAX_CHANNEL_ID, type MaxResolvedAccount } from "./config.js";
import { downloadAttachments, hasLongAudio } from "./media.js";
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

  if (!message || !sender?.user_id) {
    log?.warn?.("max: сообщение без отправителя, пропуск");
    return false;
  }
  if (sender.is_bot || (params.botUserId && sender.user_id === params.botUserId)) {
    return false;
  }

  const senderId = String(sender.user_id);
  const attachments = message.body?.attachments ?? [];

  if (!text && attachments.length === 0) {
    // Замечено на .ogg, приложенном файлом: MAX присылает событие с пустым
    // телом. Печатаем целиком, чтобы понять, теряется вложение или приходит
    // отдельным событием следом.
    log?.warn?.(
      `max: сообщение без текста и вложений от ${senderId}: ` +
        JSON.stringify({
          body: message.body,
          recipient: message.recipient,
          timestamp: message.timestamp,
        }).slice(0, 1200),
    );
    return false;
  }

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

  const media = attachments.length
    ? await downloadAttachments({
        attachments,
        onError: (attachment, err) =>
          log?.warn?.(
            `max: вложение ${attachment.type} не скачалось: ${String(err)}`,
          ),
      })
    : [];

  if (attachments.length && media.length === 0) {
    log?.warn?.(`max: ни одно вложение от ${senderId} не скачалось`);
    await client.sendText({
      target,
      text: "Не удалось забрать вложение — попробуйте прислать ещё раз.",
      signal: params.signal,
    });
    return false;
  }

  if (media.length) {
    log?.info?.(
      `max: скачано вложений ${media.length}: ` +
        media.map((m) => `${m.maxType}/${m.contentType ?? "?"}`).join(", "),
    );
  }

  // Длинную запись распознаём минуту и дольше. Без подтверждения приёма
  // это выглядит как молчание, и человек шлёт сообщение заново.
  if (hasLongAudio(media)) {
    try {
      await client.sendText({
        target,
        text: "Запись получена, распознаю — это займёт около минуты.",
        signal: params.signal,
      });
      log?.info?.(`max: отправлено подтверждение приёма длинной записи`);
    } catch (err) {
      // Не смогли предупредить — не повод бросать саму работу.
      log?.warn?.(`max: подтверждение приёма не ушло: ${String(err)}`);
    }
  }

  await dispatchMaxTurn({
    cfg,
    accountId,
    client,
    update,
    target,
    senderId,
    senderLabel: senderLabel(update),
    botUserId: params.botUserId,
    text,
    media,
    messageId: mid,
    timestamp: message.timestamp ?? update.timestamp,
    log,
    signal: params.signal,
  });
  return true;
}
