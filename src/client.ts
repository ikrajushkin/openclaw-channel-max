import type {
  MaxSendResult,
  MaxSendTarget,
  MaxUpdatesResponse,
  MaxUser,
} from "./types.js";

export const MAX_API_BASE_URL = "https://platform-api.max.ru";

/** Лимит текста одного сообщения в MAX. */
export const MAX_TEXT_LIMIT = 4000;

export class MaxApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "MaxApiError";
    this.status = status;
    this.code = code;
  }

  /** Токен отозван или неверен — перезапуск не поможет, нужно вмешательство владельца. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type MaxClientOptions = {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Тонкий клиент Bot API MAX.
 *
 * Токен передаётся заголовком `Authorization`, а не в query — иначе он оседает
 * в логах прокси. Query-вариант API тоже принимает, но мы им не пользуемся.
 */
export class MaxClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MaxClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? MAX_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(params: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T> {
    const url = new URL(this.baseUrl + params.path);
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = await this.fetchImpl(url.toString(), {
      method: params.method,
      headers: {
        Authorization: this.token,
        Accept: "application/json",
        ...(params.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: params.signal,
    });

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const err = parsed as { code?: string; message?: string };
      throw new MaxApiError(
        res.status,
        err?.code,
        err?.message ?? `MAX API ${params.method} ${params.path}: HTTP ${res.status}`,
      );
    }
    return parsed as T;
  }

  /** Профиль бота. Используется как проверка живости токена при старте. */
  getMe(signal?: AbortSignal): Promise<MaxUser> {
    return this.request<MaxUser>({ method: "GET", path: "/me", signal });
  }

  /**
   * Long polling. `marker` — курсор из предыдущего ответа; при `undefined`
   * MAX отдаёт только последнее событие, поэтому первый вызов делаем с
   * marker'ом, полученным из пустого запроса, чтобы не проглотить историю.
   */
  getUpdates(params: {
    marker?: number;
    limit?: number;
    timeoutSec?: number;
    types?: string[];
    signal?: AbortSignal;
  }): Promise<MaxUpdatesResponse> {
    return this.request<MaxUpdatesResponse>({
      method: "GET",
      path: "/updates",
      query: {
        marker: params.marker,
        limit: params.limit,
        timeout: params.timeoutSec,
        types: params.types?.length ? params.types.join(",") : undefined,
      },
      signal: params.signal,
    });
  }

  /** Отправка текста. Разбиение на куски делает вызывающая сторона. */
  sendText(params: {
    target: MaxSendTarget;
    text: string;
    format?: "markdown" | "html";
    notify?: boolean;
    replyToMid?: string;
    signal?: AbortSignal;
  }): Promise<MaxSendResult> {
    const query: Record<string, string | number | undefined> =
      "userId" in params.target
        ? { user_id: params.target.userId }
        : { chat_id: params.target.chatId };

    const body: Record<string, unknown> = { text: params.text };
    if (params.format) body.format = params.format;
    if (params.notify !== undefined) body.notify = params.notify;
    if (params.replyToMid) {
      body.link = { type: "reply", mid: params.replyToMid };
    }

    return this.request<MaxSendResult>({
      method: "POST",
      path: "/messages",
      query,
      body,
      signal: params.signal,
    });
  }
}

/** Режет текст по лимиту MAX, стараясь рвать по границе строки. */
export function chunkText(text: string, limit = MAX_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit * 0.5 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
