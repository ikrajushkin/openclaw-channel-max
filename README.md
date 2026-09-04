# openclaw-channel-max

Канал мессенджера [MAX](https://max.ru) для [OpenClaw](https://openclaw.ai).

> *A [MAX messenger](https://max.ru) channel plugin for OpenClaw. Lets an OpenClaw
> agent receive and answer messages in MAX. Docs below are in Russian —
> MAX is a Russian-market messenger.*

Готового канала для MAX в OpenClaw нет: в каталоге около трёх десятков
мессенджеров, MAX среди них отсутствует, в ClawHub тоже пусто. Этот плагин
закрывает пробел.

## Что умеет

- Приём текстовых сообщений через long polling (`GET /updates`).
- Ответы агента обратно в MAX (`POST /messages`), с разбиением по 4000 символов.
- Политики доступа `dmPolicy` (`pairing` / `allowlist` / `open` / `disabled`)
  и `allowFrom` — та же модель, что у штатных каналов OpenClaw.
- Несколько аккаунтов: `channels.max.accounts.<id>`; значения аккаунта
  перекрывают корневые.
- Токен из файла (`tokenFile`), чтобы не держать секрет в конфиге.
- Горячий перезапуск: правка `channels.max.*` поднимает только этот канал,
  не трогая остальные.

## Чего пока нет

- **Вебхук.** MAX рекомендует его для продакшена, а long polling помечает как
  средство разработки и ограничивает по скорости.
- **Вложения, голос, медиа.** Сообщение без текста сейчас пропускается.
- **Долговечная очередь входящих.** Курсор `marker` живёт в памяти процесса:
  после перезапуска канал стартует с текущего момента и не переигрывает историю.
- **Уведомление о сопряжении.** `pairing.notify` отправляет код через аккаунт
  по умолчанию; на практике проще подтверждать вручную через
  `openclaw pairing approve`.

## Требования

- OpenClaw 2026.8 или новее.
- Node.js 22.22+, 24.15+ или 25.9+.
- Бот в MAX и его токен.

## Установка

```bash
git clone https://github.com/<владелец>/openclaw-channel-max.git
cd openclaw-channel-max
npm install
npm run build
```

Установщик OpenClaw копирует каталог целиком, включая `node_modules`, поэтому
ставить нужно чистую выкладку. Это делает вспомогательный скрипт:

```bash
bash scripts/install-local.sh
```

Он собирает проект, раскладывает в отдельный каталог только то, что нужно
в рантайме, и вызывает `openclaw plugins install`. После установки перезапустите
шлюз, чтобы плагин загрузился:

```bash
openclaw plugins install <каталог-выкладки> --force --accept-capabilities
systemctl restart openclaw-gateway   # или как у вас запускается шлюз
```

Флаг `--accept-capabilities` обязателен: плагин объявляет канал, а это требует
явного согласия.

## Получение токена

Бот создаётся в самом мессенджере у `@MasterBot`: команда `/create`, имя от 11
до 60 символов с обязательным окончанием `_bot`. В ответ приходит токен.

## Настройка

```jsonc
{
  "channels": {
    "max": {
      "tokenFile": "/путь/к/секретам/max.token",
      "dmPolicy": "allowlist",
      "allowFrom": ["<ваш user_id в MAX>"]
    }
  }
}
```

Или через CLI:

```bash
openclaw config set channels.max.tokenFile /путь/к/секретам/max.token
openclaw config set channels.max.dmPolicy allowlist
openclaw config set channels.max.allowFrom '["<ваш user_id>"]'
```

### Как узнать свой user_id

Он **не совпадает** с номером аккаунта, под которым создавался бот (тот зашит
в имя бота вида `seNNNNNNNN_1_bot`). Bot API оперирует другим идентификатором.

Самый простой способ: оставить `dmPolicy: "allowlist"` с пустым списком,
написать боту и посмотреть журнал шлюза — отказ печатает id отправителя:

```
[max] отправитель 200000002 отклонён политикой allowlist
```

Этот номер и нужен в `allowFrom`.

### Маршрутизация на агента

Если у вас несколько агентов, канал нужно привязать явно, иначе ядро откажется
угадывать (`AgentSelectionRequiredError`). Привязки живут в верхнеуровневом
массиве `bindings`:

```jsonc
{
  "bindings": [
    {
      "type": "route",
      "agentId": "<имя агента>",
      "match": { "channel": "max", "accountId": "default" }
    }
  ]
}
```

Правка `bindings` требует полного перезапуска шлюза.

### Несколько ботов

```jsonc
{
  "channels": {
    "max": {
      "dmPolicy": "allowlist",
      "accounts": {
        "default": { "tokenFile": "/путь/к/секретам/max-1.token",
                     "allowFrom": ["111"] },
        "support":  { "tokenFile": "/путь/к/секретам/max-2.token",
                      "allowFrom": ["222"] }
      }
    }
  }
}
```

Значения аккаунта перекрывают корневые, корневые служат общими умолчаниями.

## Параметры

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `token` | — | Токен бота прямо в конфиге. Предпочтительнее `tokenFile`. |
| `tokenFile` | — | Путь к файлу с токеном. |
| `apiBaseUrl` | `https://platform-api.max.ru` | База Bot API. |
| `dmPolicy` | `pairing` | Кто может писать боту в личку. |
| `allowFrom` | `[]` | Белый список отправителей. |
| `groupPolicy` | `allowlist` | Политика для групповых чатов. |
| `pollTimeoutSec` | `30` | Таймаут одного запроса long polling (0–90). |
| `pollLimit` | `100` | Сколько событий забирать за раз (1–1000). |
| `enabled` | `true` | Выключатель аккаунта. |

## Разработка

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run build        # tsc -> dist/
```

Типы стоит брать от **установленного** экземпляра OpenClaw, а не от свежего
с npm, иначе они разойдутся с тем, что реально работает на шлюзе:

```bash
rm -rf node_modules/openclaw
ln -s "$(npm root -g)/openclaw" node_modules/openclaw
```

## Особенности MAX Bot API, на которые стоит заложиться

- **Отвечать нужно в `recipient.chat_id`.** В диалоге `recipient.user_id` — это
  сам бот, то есть получатель входящего. Отправка по нему возвращает
  `Invalid chatId: 0`, и ответ теряется. `chat_id` работает и для диалога,
  и для группы.
- **`GET /chats` для ботов не отдаёт JSON** — приходит zip-архив с `logcat.txt`.
  Список диалогов через него получить нельзя.
- **`marker` в `/updates`** при первом запросе без значения отдаёт только
  последнее событие, а не всю очередь.
- **Лимиты:** 30 запросов в секунду на REST, не больше двух сообщений в секунду
  в один диалог, 4000 символов на сообщение.

## Лицензия

MIT — см. [LICENSE](LICENSE).
