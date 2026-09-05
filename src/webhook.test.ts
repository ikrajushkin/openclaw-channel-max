import { describe, expect, it } from "vitest";
import {
  buildWebhookPath,
  buildWebhookUrl,
  deriveWebhookSecret,
  resolveMaxAccount,
} from "./config.js";
import { collectWebhookPaths, listWebhookAccountIds } from "./webhook.js";
import { listMaxAccountIds } from "./config.js";

const cfg = (max: unknown) => ({ channels: { max } }) as never;

describe("секрет пути вебхука", () => {
  it("выводится из токена и стабилен", () => {
    expect(deriveWebhookSecret("t-1")).toBe(deriveWebhookSecret("t-1"));
  });

  it("разный для разных токенов", () => {
    expect(deriveWebhookSecret("t-1")).not.toBe(deriveWebhookSecret("t-2"));
  });

  it("не содержит самого токена", () => {
    const token = "очень-секретный-токен";
    expect(deriveWebhookSecret(token)).not.toContain(token);
  });

  it("длиной 32 шестнадцатеричных символа", () => {
    expect(deriveWebhookSecret("t")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("адрес вебхука", () => {
  it("склеивается из публичной базы и пути", () => {
    const account = resolveMaxAccount(
      cfg({ token: "t-1", webhookPublicUrl: "https://oc.example.org" }),
    );
    const url = buildWebhookUrl(account, "default");
    expect(url).toBe(`https://oc.example.org${buildWebhookPath("default", "t-1")}`);
  });

  it("хвостовой слеш в базе не даёт двойного", () => {
    const account = resolveMaxAccount(
      cfg({ token: "t-1", webhookPublicUrl: "https://oc.example.org/" }),
    );
    expect(buildWebhookUrl(account, "default")).not.toContain("org//");
  });

  it("без публичной базы адреса нет — значит работаем опросом", () => {
    const account = resolveMaxAccount(cfg({ token: "t-1" }));
    expect(buildWebhookUrl(account, "default")).toBe("");
  });

  it("без токена адреса нет", () => {
    const account = resolveMaxAccount(cfg({ webhookPublicUrl: "https://oc.example.org" }));
    expect(buildWebhookUrl(account, "default")).toBe("");
  });
});

describe("пути в обход авторизации шлюза", () => {
  it("собираются только для настроенных аккаунтов", () => {
    const c = cfg({
      webhookPublicUrl: "https://oc.example.org",
      accounts: {
        default: { token: "t-1" },
        second: { token: "t-2" },
        third: {},
      },
    });
    const paths = collectWebhookPaths(c, listMaxAccountIds, resolveMaxAccount);
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => p.startsWith("/max/webhook/"))).toBe(true);
  });

  it("пусто, когда вебхук не настроен", () => {
    const paths = collectWebhookPaths(
      cfg({ token: "t-1" }),
      listMaxAccountIds,
      resolveMaxAccount,
    );
    expect(paths).toEqual([]);
  });
});

describe("реестр запущенных аккаунтов", () => {
  it("на старте пуст", () => {
    expect(listWebhookAccountIds()).toEqual([]);
  });
});
