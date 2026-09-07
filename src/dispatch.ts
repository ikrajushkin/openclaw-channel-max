import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { chunkText, MaxClient } from "./client.js";
import { MAX_CHANNEL_ID } from "./config.js";
import type { DownloadedMedia } from "./media.js";
import type { MaxInboundLog } from "./inbound.js";
import type { MaxSendTarget, MaxUpdate } from "./types.js";

/** Вид вложения так, как его понимает ядро. */
function mediaKind(m: DownloadedMedia): "audio" | "image" | "video" | "document" {
  const type = (m.contentType ?? "").toLowerCase();
  if (type.startsWith("audio/") || m.maxType === "audio") return "audio";
  if (type.startsWith("image/") || m.maxType === "image") return "image";
  if (type.startsWith("video/") || m.maxType === "video") return "video";
  return "document";
}

export type DispatchMaxTurnParams = {
  cfg: OpenClawConfig;
  accountId: string;
  client: MaxClient;
  update: MaxUpdate;
  target: MaxSendTarget;
  senderId: string;
  senderLabel: string;
  botUserId?: number;
  text: string;
  media: readonly DownloadedMedia[];
  messageId: string;
  timestamp?: number;
  log?: MaxInboundLog;
  signal?: AbortSignal;
};

/**
 * Отдать входящее событие ядру и доставить ответ обратно в MAX.
 *
 * Идём полным контрактом приёма: вложения передаются массивом `media`,
 * а не устаревшими полями контекста `MediaPaths` и соседними. Так ядро
 * получает про каждый файл и путь, и тип, и порядок — и само решает,
 * что распознать, а что показать модели.
 */
export async function dispatchMaxTurn(params: DispatchMaxTurnParams): Promise<void> {
  const { cfg, accountId, update, log } = params;

  const conversationKind =
    update.message?.recipient?.chat_type === "dialog" ? "direct" : "group";

  const route = resolveAgentRoute({
    cfg,
    channel: MAX_CHANNEL_ID,
    accountId,
    peer: { kind: conversationKind, id: params.senderId },
  });

  // Хелпер асинхронный: он дочитывает длительность аудио и размеры картинок.
  const media = await toInboundMediaFactsWithMetadata(
    params.media.map((m) => ({
      path: m.path,
      url: m.url,
      contentType: m.contentType,
      fileName: m.fileName,
      kind: mediaKind(m),
      messageId: params.messageId,
    })),
  );

  const conversationId =
    update.message?.recipient?.chat_id != null
      ? String(update.message.recipient.chat_id)
      : params.senderId;

  await runChannelInboundEvent({
    channel: MAX_CHANNEL_ID,
    accountId,
    raw: update,
    adapter: {
      ingest: (raw) => ({
        id: params.messageId,
        timestamp: params.timestamp,
        rawText: params.text,
        raw,
      }),

      // Вложения объявляем здесь: ядро подхватит их до запуска агента
      // и само решит, что нужно распознать.
      preflight: () => (media.length ? { media } : undefined),

      resolveTurn: (input) => {
        const ctxPayload = buildChannelInboundEventContext({
          channel: MAX_CHANNEL_ID,
          accountId,
          messageId: params.messageId,
          timestamp: params.timestamp,
          from: params.senderId,
          sender: {
            id: params.senderId,
            name: params.senderLabel,
            displayLabel: params.senderLabel,
            isBot: false,
          },
          conversation: {
            kind: conversationKind,
            id: conversationId,
            label: params.senderLabel,
            routePeer: { kind: conversationKind, id: params.senderId },
          },
          route: {
            agentId: route.agentId,
            accountId,
            routeSessionKey: route.sessionKey,
            mainSessionKey: route.mainSessionKey,
            dmScope: route.dmScope,
            createIfMissing: true,
          },
          reply: {
            to: conversationId,
            replyToId: params.messageId,
          },
          message: {
            rawBody: input.rawText,
            body: input.rawText,
          },
          media,
          // Канал ещё не перешёл на проверяемое происхождение входящих:
          // разрешение мы делаем сами, до вызова, по dmPolicy и allowFrom.
          channelIngress: "unsupported",
        });

        return {
          cfg,
          channel: MAX_CHANNEL_ID,
          accountId,
          ctxPayload,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          messageId: params.messageId,
          delivery: {
            deliver: async (payload) => {
              const outText = payload.text?.trim();
              if (!outText) return;
              for (const chunk of chunkText(outText)) {
                await params.client.sendText({
                  target: params.target,
                  text: chunk,
                  signal: params.signal,
                });
              }
            },
          },
        };
      },

      onFinalize: (result) => {
        if (!result.dispatched) {
          log?.info?.(
            `max[${accountId}]: событие не дошло до агента (${result.admission.kind}` +
              `${"reason" in result.admission ? `: ${result.admission.reason}` : ""})`,
          );
        }
      },
    },
    log: (event) => {
      if (event.event === "error" || event.event === "drop") {
        log?.warn?.(
          `max[${accountId}]: ${event.stage}/${event.event}` +
            `${event.reason ? ` — ${event.reason}` : ""}` +
            `${event.error ? ` — ${String(event.error)}` : ""}`,
        );
      }
    },
  });
}
