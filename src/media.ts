import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MaxAttachment } from "./types.js";

/** Больше этого не скачиваем: телеметрия чужого файла нам не нужна. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** Скачанное живёт час — ядру хватает, диск не растёт. */
const KEEP_MS = 60 * 60 * 1000;

export type DownloadedMedia = {
  path: string;
  url: string;
  contentType?: string;
  fileName?: string;
  /** Тип вложения так, как его назвал MAX: image, file, audio, video. */
  maxType: string;
};

const EXT_BY_TYPE: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

function mediaDir(): string {
  return path.join(os.tmpdir(), "openclaw-max-media");
}

/** Подчищаем старое, чтобы каталог не рос бесконечно. */
async function sweep(dir: string): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st && now - st.mtimeMs > KEEP_MS) await fs.rm(file, { force: true });
    }
  } catch {
    // каталога может не быть — это нормально
  }
}

function pickExtension(attachment: MaxAttachment, contentType?: string): string {
  const fromName = attachment.filename ? path.extname(attachment.filename) : "";
  if (fromName) return fromName;
  const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return EXT_BY_TYPE[base ?? ""] ?? "";
}

/**
 * Скачать вложение по прямой ссылке из `payload.url`.
 *
 * Ссылки у файлов со сроком годности, поэтому качаем сразу при получении
 * события, а не лениво в момент, когда агент решит посмотреть.
 */
export async function downloadAttachment(params: {
  attachment: MaxAttachment;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DownloadedMedia | null> {
  const url = params.attachment.payload?.url;
  if (!url) return null;

  const res = await (params.fetchImpl ?? fetch)(url, { signal: params.signal });
  if (!res.ok) {
    throw new Error(`не удалось скачать вложение: HTTP ${res.status}`);
  }

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`вложение слишком велико: ${declared} байт`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`вложение слишком велико: ${buf.byteLength} байт`);
  }

  const contentType = res.headers.get("content-type") ?? undefined;
  const dir = mediaDir();
  await fs.mkdir(dir, { recursive: true });
  void sweep(dir);

  const stamp = createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, 16);
  const file = path.join(
    dir,
    `${Date.now()}-${stamp}${pickExtension(params.attachment, contentType)}`,
  );
  await fs.writeFile(file, buf, { mode: 0o600 });

  return {
    path: file,
    url,
    contentType,
    fileName: params.attachment.filename,
    maxType: params.attachment.type,
  };
}

/** Скачать все вложения сообщения; те, что не удались, просто пропускаем. */
export async function downloadAttachments(params: {
  attachments: readonly MaxAttachment[];
  signal?: AbortSignal;
  onError?: (attachment: MaxAttachment, err: unknown) => void;
}): Promise<DownloadedMedia[]> {
  const out: DownloadedMedia[] = [];
  for (const attachment of params.attachments) {
    try {
      const got = await downloadAttachment({ attachment, signal: params.signal });
      if (got) out.push(got);
    } catch (err) {
      params.onError?.(attachment, err);
    }
  }
  return out;
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
