#!/bin/bash
# Перед публикацией: в репозитории не должно быть реальных идентификаторов,
# адресов и путей конкретной установки. Запускать из корня проекта.
#
# Дважды ловил на этом себя: правки готовились в копии со свежими логами,
# и настоящие user_id уезжали в примеры README.
set -uo pipefail
PATTERNS='"user_id": *[0-9]{7,}|"chat_id": *[0-9]{7,}|[0-9]{1,3}(\.[0-9]{1,3}){3}|/srv/openclaw'
if grep -rnE "$PATTERNS" . \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
    --exclude='redact-check.sh' 2>/dev/null | grep -vE '200000002|300000003|100000001|example\.org'; then
  echo
  echo "Похоже на реальные данные — проверьте перед публикацией."
  exit 1
fi
echo "чисто"
