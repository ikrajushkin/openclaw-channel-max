#!/bin/bash
# Сборка и установка плагина в локальный OpenClaw.
#
# Установщик OpenClaw копирует каталог целиком, поэтому ставить каталог
# разработки нельзя: туда уедут node_modules (сотни мегабайт) и .git.
# Собираем чистую выкладку и ставим её.
#
# Переменные окружения:
#   STAGE_DIR  куда положить выкладку (по умолчанию рядом с проектом)
#   OC_BIN     чем вызывать OpenClaw (по умолчанию `openclaw`)
set -euo pipefail

D="$(cd "$(dirname "$0")/.." && pwd)"
STAGE_DIR="${STAGE_DIR:-$D/.stage}"
OC="${OC_BIN:-openclaw}"

echo "→ сборка"
cd "$D"
npx tsc -p tsconfig.json

echo "→ чистая выкладка в $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -a dist "$STAGE_DIR/dist"
cp -a package.json openclaw.plugin.json README.md "$STAGE_DIR/"

echo "→ установка"
# НЕ вызывать здесь `plugins uninstall`: он удаляет и секцию channels.max
# из конфига — токен, политики, allowFrom. Установка поверх этого не делает.
#
# И не удалять каталог плагина вручную через rm -rf: запись об установке
# останется в состоянии OpenClaw, после чего любая новая установка того же
# идентификатора падает с «has no authoritative runtime child list».
# Штатное удаление — `openclaw plugins uninstall max --force`.
"$OC" plugins install "$STAGE_DIR" --force --accept-capabilities </dev/null

echo "→ проверка"
"$OC" channels list --all </dev/null | grep -i max || echo "  канал не виден"
echo
echo "Перезапустите шлюз, чтобы плагин загрузился, например:"
echo "  systemctl restart openclaw-gateway"
