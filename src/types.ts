/** Типы Bot API мессенджера MAX — только то, что реально используется каналом. */

export type MaxUser = {
  user_id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
  name?: string;
};

export type MaxRecipient = {
  chat_id?: number;
  chat_type?: "dialog" | "chat" | "channel";
  user_id?: number;
};

/**
 * Вложение входящего сообщения.
 *
 * Формы, подтверждённые на живом боте (документация MAX их не описывает):
 *   image: payload = { photo_id, token, url }
 *   file:  filename, size, payload = { fileId, token, url (со сроком годности) }
 *
 * `payload.url` — прямая ссылка, её достаточно для скачивания.
 */
export type MaxAttachment = {
  type: string;
  filename?: string;
  size?: number;
  payload?: {
    url?: string;
    token?: string;
    photo_id?: number;
    fileId?: number;
    [key: string]: unknown;
  };
};

export type MaxMessageBody = {
  mid: string;
  seq?: number;
  text?: string | null;
  attachments?: MaxAttachment[] | null;
};

export type MaxMessage = {
  sender?: MaxUser;
  recipient?: MaxRecipient;
  timestamp?: number;
  body: MaxMessageBody;
};

export type MaxUpdate = {
  update_type: string;
  timestamp?: number;
  message?: MaxMessage;
  user?: MaxUser;
  user_id?: number;
  chat_id?: number;
  chat_type?: string;
  payload?: string;
  callback?: { callback_id: string; payload?: string; user?: MaxUser };
};

export type MaxUpdatesResponse = {
  updates?: MaxUpdate[];
  marker?: number | null;
};

export type MaxSendResult = {
  message?: MaxMessage;
};

export type MaxSubscription = {
  url: string;
  time?: number;
  update_types?: string[] | null;
  version?: string;
};

/** Целевой адрес отправки: MAX различает диалог с пользователем и чат. */
export type MaxSendTarget = { userId: number } | { chatId: number };
