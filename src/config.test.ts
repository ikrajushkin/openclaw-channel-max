import { describe, expect, it } from "vitest";
import {
  inspectMaxAccount,
  listMaxAccountIds,
  resolveMaxAccount,
} from "./config.js";

const cfg = (max: unknown) => ({ channels: { max } }) as never;

describe("разрешение аккаунта MAX", () => {
  it("читает токен из корневой секции", () => {
    const account = resolveMaxAccount(cfg({ token: "t-1" }));
    expect(account.token).toBe("t-1");
    expect(account.tokenSource).toBe("inline");
  });

  it("значения именованного аккаунта перекрывают корневые", () => {
    const account = resolveMaxAccount(
      cfg({
        token: "root",
        dmPolicy: "open",
        accounts: { ksu: { token: "named", dmPolicy: "allowlist" } },
      }),
      "ksu",
    );
    expect(account.token).toBe("named");
    expect(account.dmPolicy).toBe("allowlist");
  });

  it("наследует корневые умолчания там, где аккаунт молчит", () => {
    const account = resolveMaxAccount(
      cfg({ allowFrom: ["200000002"], accounts: { ksu: { token: "named" } } }),
      "ksu",
    );
    expect(account.allowFrom).toEqual(["200000002"]);
  });

  it("по умолчанию политика личных сообщений — сопряжение", () => {
    expect(resolveMaxAccount(cfg({ token: "t" })).dmPolicy).toBe("pairing");
  });

  it("отсутствие секции не роняет разрешение", () => {
    const account = resolveMaxAccount({ channels: {} } as never);
    expect(account.token).toBe("");
    expect(account.tokenSource).toBe("missing");
  });

  it("default присутствует в списке аккаунтов всегда", () => {
    expect(listMaxAccountIds(cfg({ accounts: { ksu: {} } }))).toContain("default");
  });

  it("инспекция не отдаёт сам секрет", () => {
    const result = inspectMaxAccount(cfg({ token: "секрет" }));
    expect(result).toEqual({
      enabled: true,
      configured: true,
      tokenStatus: "available",
      tokenSource: "inline",
    });
    expect(JSON.stringify(result)).not.toContain("секрет");
  });
});
