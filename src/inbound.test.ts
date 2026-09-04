import { describe, expect, it } from "vitest";
import { isSenderAllowed, resolveSendTarget } from "./inbound.js";
import type { MaxResolvedAccount } from "./config.js";
import type { MaxUpdate } from "./types.js";

const account = (over: Partial<MaxResolvedAccount>): MaxResolvedAccount => ({
  accountId: null,
  enabled: true,
  token: "t",
  tokenSource: "inline",
  apiBaseUrl: "https://platform-api.max.ru",
  dmPolicy: "allowlist",
  allowFrom: [],
  groupPolicy: "allowlist",
  pollTimeoutSec: 30,
  pollLimit: 100,
  ...over,
});

describe("политика доступа", () => {
  it("allowlist пропускает только своих", () => {
    const acc = account({ dmPolicy: "allowlist", allowFrom: ["1"] });
    expect(isSenderAllowed(acc, "1")).toBe(true);
    expect(isSenderAllowed(acc, "2")).toBe(false);
  });

  it("пустой allowFrom при allowlist закрывает всех", () => {
    expect(isSenderAllowed(account({ dmPolicy: "allowlist" }), "1")).toBe(false);
  });

  it("disabled закрывает даже своих", () => {
    const acc = account({ dmPolicy: "disabled", allowFrom: ["1"] });
    expect(isSenderAllowed(acc, "1")).toBe(false);
  });

  it("open пропускает любого", () => {
    expect(isSenderAllowed(account({ dmPolicy: "open" }), "999")).toBe(true);
  });
});

describe("адрес ответа", () => {
  const BOT = 100000001;

  it("в диалоге отвечаем в chat_id, а не в recipient.user_id", () => {
    // recipient.user_id здесь — сам бот; отправка по нему даёт Invalid chatId: 0
    const update = {
      update_type: "message_created",
      message: {
        sender: { user_id: 200000002 },
        recipient: { chat_type: "dialog", user_id: BOT, chat_id: 900100 },
        body: { mid: "m1", text: "привет" },
      },
    } as MaxUpdate;
    expect(resolveSendTarget(update, BOT)).toEqual({ chatId: 900100 });
  });

  it("групповой чат отвечает в chat_id", () => {
    const update = {
      update_type: "message_created",
      message: {
        sender: { user_id: 5 },
        recipient: { chat_type: "chat", chat_id: -77 },
        body: { mid: "m2", text: "привет" },
      },
    } as MaxUpdate;
    expect(resolveSendTarget(update, BOT)).toEqual({ chatId: -77 });
  });

  it("без chat_id берём получателя, если это не сам бот", () => {
    const update = {
      update_type: "message_created",
      message: {
        sender: { user_id: 5 },
        recipient: { chat_type: "dialog", user_id: 777 },
        body: { mid: "m3", text: "x" },
      },
    } as MaxUpdate;
    expect(resolveSendTarget(update, BOT)).toEqual({ userId: 777 });
  });

  it("если получатель — сам бот и chat_id нет, отвечаем отправителю", () => {
    const update = {
      update_type: "message_created",
      message: {
        sender: { user_id: 200000002 },
        recipient: { chat_type: "dialog", user_id: BOT },
        body: { mid: "m4", text: "x" },
      },
    } as MaxUpdate;
    expect(resolveSendTarget(update, BOT)).toEqual({ userId: 200000002 });
  });

  it("без получателя падает обратно на отправителя", () => {
    const update = {
      update_type: "message_created",
      message: { sender: { user_id: 8 }, body: { mid: "m5", text: "x" } },
    } as MaxUpdate;
    expect(resolveSendTarget(update, BOT)).toEqual({ userId: 8 });
  });
});
