# Деплой Telegram-бота копитрейдинга на VPS

Инструкция по переносу проекта на свой сервер (VPS) и запуску Next.js-приложения и Telegram-бота (long polling) в Docker Compose.

## Требования

- VPS с Linux (проверено на Ubuntu 22.04/24.04), минимум 2 ГБ RAM.
- Установленные [Docker Engine](https://docs.docker.com/engine/install/) и Docker Compose plugin (`docker compose version` — v2+).
- Git (или другой способ переноса репозитория).
- Открытый порт **8080** (или reverse-proxy: nginx/Caddy) для доступа к приложению.
- Токен Telegram-бота от [@BotFather](https://t.me/BotFather).
- Доступ к DynamoDB-совместимому Document API Yandex Cloud (endpoint таблицы и статический ключ сервисного аккаунта).

## 1. Перенос репозитория на VPS

Вариант через git:

```shell
git clone <URL вашего репозитория> /opt/copybot
cd /opt/copybot
```

Либо скопируйте каталог проекта на сервер любым способом (scp, rsync), например:

```shell
rsync -av --exclude node_modules --exclude .next ./ user@vps-host:/opt/copybot/
```

## 2. Настройка переменных окружения (.env.docker)

Все сервисы Docker Compose читают переменные из файла `.env.docker` в корне проекта. Скопируйте шаблон и заполните его:

```shell
cp .env.docker .env.docker.local   # (опционально, бэкап шаблона)
nano .env.docker
```

Пример заполненного файла:

```dotenv
# Application
PORT=8080
NODE_ENV=development

# Telegram (впишите свой токен от @BotFather)
TELEGRAM_BOT_TOKEN=1234567890:AA...ваш_токен...

# Yandex Cloud Document API (DynamoDB-совместимый)
DOCUMENT_API_ENDPOINT=https://docapi.serverless.yandexcloud.net/ru-central1/<folder-id>/<table-id>
DOCUMENT_API_REGION=ru-central1
AWS_ACCESS_KEY_ID=<статический ключ сервисного аккаунта Yandex>
AWS_SECRET_ACCESS_KEY=<секретная часть статического ключа>
USE_DATABASE=true
```

Пояснения:

| Переменная                                    | Что указать                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                          | Токен бота, полученный у @BotFather — вводите сами.                                                |
| `DOCUMENT_API_ENDPOINT`                       | Endpoint Document API вашей таблицы в Yandex Cloud (тот же, что используется в текущем окружении). |
| `DOCUMENT_API_REGION`                         | `ru-central1` для Yandex Cloud.                                                                    |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Статический ключ доступа сервисного аккаунта Yandex Cloud с правами на таблицу.                    |
| `USE_DATABASE=true`                           | Включает реальную БД; при `false` приложение работает на мок-данных.                               |

> Если таблицы в Yandex Cloud ещё нет — создайте её (Document API, DynamoDB-совместимый режим) и возьмите её endpoint. Локальная `dynamodb-local` из compose используется только для разработки.

## 3. Запуск приложения

```shell
docker compose up -d
```

Compose поднимет `app` (Next.js на порту 8080); миграции применяются автоматически при старте контейнера. Проверить статус:

```shell
docker compose ps
```

## 4. Применение миграций БД

Миграции уже выполнены при старте `app`, но при необходимости их можно запустить вручную:

```shell
docker compose exec app npm run db:migrate
```

## 5. Автозапуск Telegram-бота (long polling)

Бот должен работать постоянно и переживать перезагрузку VPS. Есть два варианта.

### Вариант A (рекомендуется): docker-сервис `bot` в Compose

В `docker-compose.yml` уже добавлен сервис `bot` (профиль `bot`), который запускает `npm run bot:polling` рядом с приложением и автоматически перезапускается:

```shell
docker compose --profile bot up -d
```

Чтобы профиль `bot` включался автоматически (в том числе после перезагрузки VPS), добавьте в `.env.docker` строку:

```dotenv
COMPOSE_PROFILES=bot
```

и выполните `docker compose up -d` ещё раз. С `restart: on-failure` контейнер бота перезапускается Docker'ом автоматически; убедитесь, что Docker-демон стартует при загрузке системы (`sudo systemctl enable docker`).

> Важно: одновременно может работать только один процесс polling. Если бот запущен через Compose, не запускайте `npm run bot:polling` вручную на хосте.

### Вариант B: systemd-юнит на хосте

Если предпочитаете запускать polling без Docker (нужны Node.js на хосте, `npm ci` в каталоге проекта и файл `.env` с теми же переменными, что и в `.env.docker` — скрипт читает его через `dotenv`):

Создайте `/etc/systemd/system/copybot-polling.service`:

```ini
[Unit]
Description=Telegram copy-trading bot (long polling)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/copybot
ExecStart=/usr/bin/npm run bot:polling
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Включите и запустите:

```shell
sudo systemctl daemon-reload
sudo systemctl enable --now copybot-polling
sudo journalctl -u copybot-polling -f   # логи бота
```

## 6. Проверка работоспособности

1. Health-эндпоинт приложения:

   ```shell
   curl http://localhost:8080/api/health
   ```

   Ожидается JSON-ответ со статусом `ok`.

2. Telegram-бот: напишите боту `/start` в Telegram — он должен ответить. Логи polling-процесса:

   ```shell
   docker compose logs -f bot          # вариант A
   sudo journalctl -u copybot-polling -f   # вариант B
   ```

   При старте бот валидирует токен (`getMe`) и снимает webhook — в логах должны быть сообщения «Токен валиден».

## 7. Обновление версии на VPS

```shell
git pull                      # или повторный rsync
docker compose up -d          # перезапуск приложения
docker compose exec app npm run db:migrate   # если менялась схема
# бот в docker-варианте подхватит код автоматически (код примаунчен);
# в systemd-варианте: sudo systemctl restart copybot-polling
```

## Используемые npm-скрипты

| Скрипт                | Назначение                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `npm run bot:polling` | Long polling Telegram-бота (постоянный процесс).                           |
| `npm run db:migrate`  | Применение миграций DynamoDB-схемы (`scripts/migrate.ts`).                 |
| `npm run dev:docker`  | Запуск Next.js dev-сервера на порту 8080 (используется контейнером `app`). |
