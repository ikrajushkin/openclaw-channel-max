import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { MaxAttachment } from "./types.js";

/** Потолок на одно вложение. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** Ссылки MAX живут недолго, поэтому качаем сразу и не тянем с этим. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type DownloadedMedia = {
  path: string;
  url: string;
  contentType?: string;
  fileName?: string;
  size: number;
  /** Тип вложения так, как его назвал MAX: image, file, audio, video. */
  maxType: string;
};

/**
 * Скачать вложение по прямой ссылке из `payload.url`.
 *
 * Кладём через хелпер ядра, а не сами: он пишет в разрешённый каталог
 * входящего медиа (`media/inbound`), определяет тип по содержимому и держит
 * защиту от SSRF. Своя папка в /tmp не годится — инструмент просмотра
 * изображений отвергает пути вне периметра.
 */
export async function downloadAttachment(params: {
  attachment: MaxAttachment;
}): Promise<DownloadedMedia | null> {
  const url = params.attachment.payload?.url;
  if (!url) return null;

  const saved = await saveRemoteMedia({
    url,
    subdir: "inbound",
    // MAX часто отдаёт application/octet-stream даже для PDF, зато имя файла
    // приходит честное — по нему ядро и определит тип.
    originalFilename: params.attachment.filename,
    filePathHint: params.attachment.filename,
    maxBytes: MAX_DOWNLOAD_BYTES,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    requireHttps: true,
  });

  return {
    path: saved.path,
    url,
    contentType: saved.contentType,
    fileName: saved.fileName ?? params.attachment.filename,
    size: saved.size,
    maxType: params.attachment.type,
  };
}

/** Скачать все вложения сообщения; те, что не удались, просто пропускаем. */
export async function downloadAttachments(params: {
  attachments: readonly MaxAttachment[];
  onError?: (attachment: MaxAttachment, err: unknown) => void;
}): Promise<DownloadedMedia[]> {
  const out: DownloadedMedia[] = [];
  for (const attachment of params.attachments) {
    try {
      const got = await downloadAttachment({ attachment });
      if (got) out.push(got);
    } catch (err) {
      params.onError?.(attachment, err);
    }
  }
  return out;
}

/**
 * Аудио примерно такого размера распознаётся дольше, чем человек готов ждать
 * молча: при типичном битрейте Opus это минуты полторы записи и более.
 */
const LONG_AUDIO_BYTES = 300 * 1024;

/** Есть ли среди вложений длинная запись, о которой стоит предупредить. */
export function hasLongAudio(media: readonly DownloadedMedia[]): boolean {
  return media.some(
    (m) =>
      m.size > LONG_AUDIO_BYTES &&
      (m.maxType === "audio" || (m.contentType ?? "").startsWith("audio/")),
  );
}

/**
 * Проекция скачанного в поля контекста, которые читает ядро.
 *
 * Поля `Media*` помечены в SDK как устаревшие, но остаются рабочей
 * совместимостью; переход на `media` в полном контракте приёма — отдельная
 * задача, см. README.
 */
export function toLegacyMediaContext(
  media: readonly DownloadedMedia[],
): Record<string, unknown> {
  if (media.length === 0) return {};
  return {
    MediaPath: media[0]?.path,
    MediaUrl: media[0]?.url,
    MediaType: media[0]?.contentType,
    MediaPaths: media.map((m) => m.path),
    MediaUrls: media.map((m) => m.url),
    MediaTypes: media.map((m) => m.contentType ?? m.maxType),
  };
}
