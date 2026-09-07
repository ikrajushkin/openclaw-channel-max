import { describe, expect, it } from "vitest";
import { hasLongAudio, toLegacyMediaContext } from "./media.js";
import type { DownloadedMedia } from "./media.js";

const m = (over: Partial<DownloadedMedia>): DownloadedMedia => ({
  path: "/tmp/a.ogg",
  url: "https://example.org/a.ogg",
  contentType: "audio/ogg",
  size: 1024,
  maxType: "audio",
  ...over,
});

describe("предупреждение о длинной записи", () => {
  it("короткое голосовое не требует подтверждения", () => {
    expect(hasLongAudio([m({ size: 20 * 1024 })])).toBe(false);
  });

  it("длинная запись требует", () => {
    expect(hasLongAudio([m({ size: 1_700_000 })])).toBe(true);
  });

  it("аудио, присланное файлом, тоже учитывается", () => {
    expect(
      hasLongAudio([m({ size: 1_700_000, maxType: "file", contentType: "audio/ogg" })]),
    ).toBe(true);
  });

  it("крупный документ не считается записью", () => {
    expect(
      hasLongAudio([
        m({ size: 5_000_000, maxType: "file", contentType: "application/pdf" }),
      ]),
    ).toBe(false);
  });

  it("пустой список — ничего не требует", () => {
    expect(hasLongAudio([])).toBe(false);
  });
});

describe("проекция медиа в контекст", () => {
  it("без вложений поля не появляются", () => {
    expect(toLegacyMediaContext([])).toEqual({});
  });

  it("первое вложение дублируется в одиночные поля", () => {
    const ctx = toLegacyMediaContext([m({ path: "/tmp/one.ogg" })]);
    expect(ctx.MediaPath).toBe("/tmp/one.ogg");
    expect(ctx.MediaPaths).toEqual(["/tmp/one.ogg"]);
  });

  it("порядок вложений сохраняется", () => {
    const ctx = toLegacyMediaContext([
      m({ path: "/tmp/1.ogg" }),
      m({ path: "/tmp/2.pdf", contentType: "application/pdf", maxType: "file" }),
    ]);
    expect(ctx.MediaPaths).toEqual(["/tmp/1.ogg", "/tmp/2.pdf"]);
    expect(ctx.MediaTypes).toEqual(["audio/ogg", "application/pdf"]);
  });

  it("при отсутствии типа берётся тип вложения из MAX", () => {
    const ctx = toLegacyMediaContext([m({ contentType: undefined, maxType: "audio" })]);
    expect(ctx.MediaTypes).toEqual(["audio"]);
  });
});
