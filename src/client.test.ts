import { describe, expect, it, vi } from "vitest";
import { chunkText, MaxApiError, MaxClient } from "./client.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("клиент MAX", () => {
  it("передаёт токен заголовком, а не в query", async () => {
    const fetchImpl = fakeFetch(200, { user_id: 7 });
    const client = new MaxClient({ token: "секрет", fetchImpl });
    await client.getMe();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).not.toContain("секрет");
    expect((init.headers as Record<string, string>).Authorization).toBe("секрет");
  });

  it("диалог адресуется user_id, чат — chat_id", async () => {
    const fetchImpl = fakeFetch(200, {});
    const client = new MaxClient({ token: "t", fetchImpl });
    await client.sendText({ target: { userId: 42 }, text: "привет" });
    await client.sendText({ target: { chatId: -5 }, text: "привет" });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("user_id=42");
    expect(calls[1][0]).toContain("chat_id=-5");
  });

  it("401 распознаётся как проблема с токеном", async () => {
    const client = new MaxClient({
      token: "плохой",
      fetchImpl: fakeFetch(401, { code: "verify.token", message: "Invalid access_token" }),
    });
    const err = await client.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(MaxApiError);
    expect((err as MaxApiError).isAuthError).toBe(true);
    expect((err as MaxApiError).code).toBe("verify.token");
  });
});

describe("разбиение текста", () => {
  it("короткий текст не режется", () => {
    expect(chunkText("привет")).toEqual(["привет"]);
  });

  it("длинный текст режется по границе строки", () => {
    const text = `${"а".repeat(30)}\n${"б".repeat(30)}`;
    const chunks = chunkText(text, 40);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("а".repeat(30));
    expect(chunks.join("").length).toBeLessThanOrEqual(text.length);
  });

  it("каждый кусок укладывается в лимит", () => {
    for (const chunk of chunkText("x".repeat(9500), 4000)) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });
});
