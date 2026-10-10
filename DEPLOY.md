# Деплой Telegram-бота копитрейдинга на VPS

Инструкция по переносу проекта на свой сервер (VPS) и запуску Next.js-приложения и Telegram-бота (long polling) в Docker Compose с **локальной DynamoDB** (DynamoDB Local) — без Yandex Cloud и AWS. Все данные хранятся на вашем сервере в Docker-volume.

## Требования

- VPS с Linux (проверено на Ubuntu 22.04/24.04), минимум 2 ГБ RAM.
- Установленные [Docker Engine](https://docs.docker.com/engine/install/) и Docker Compose plugin (`docker compose version` — v2.24+).
- Git (или другой способ переноса репозитория).
- Открытый порт **8080** (или reverse-proxy: nginx/Caddy) для доступа к приложению.
- Токен Telegram-бота от [@BotFather](https://t.me/BotFather).

Реквизиты Yandex Cloud / AWS **не требуются**: база поднимается локально сервисом `dynamodb-local` из compose.

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

## 2. Настройка переменных окружения (.env)

Создайте в корне проекта файл `.env` с одним обязательным параметром — токеном бота:

```shell
nano .env
```

```dotenv
# Telegram (впишите свой токен от @BotFather)
TELEGRAM_BOT_TOKEN=1234567890:AA...ваш_токен...
```

Больше ничего указывать не нужно: при отсутствии внешних реквизитов Document API (`DOCUMENT_API_ENDPOINT` и ключей) приложение, миграции и бот автоматически работают с локальной DynamoDB по эндпоинту `http://dynamodb-local:8000` внутри compose-сети.

Пояснения:

| Переменная                             | Что указать                                                          |
| -------------------------------------- | -------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                   | Токен бота, полученный у @BotFather — вводите сами.                  |
| `USE_DATABASE=true` (из `.env.docker`) | Включает реальную БД; при `false` приложение работает на мок-данных. |

Дополнительные дефолты берутся из `.env.docker` в корне проекта (порт приложения, режим БД). При желании их можно переопределить в своём `.env`.

### Опционально: внешняя база Document API (Yandex Cloud)

Если позже захотите хранить данные в Yandex Cloud вместо локальной базы, добавьте в `.env` реквизиты — приложение автоматически начнёт использовать их вместо DynamoDB Local:

```dotenv
DOCUMENT_API_ENDPOINT=https://docapi.serverless.yandexcloud.net/ru-central1/<folder-id>/<table-id>
DOCUMENT_API_REGION=ru-central1
AWS_ACCESS_KEY_ID=<статический ключ сервисного аккаунта>
AWS_SECRET_ACCESS_KEY=<секретная часть ключа>
```

## 3. Запуск приложения

```shell
docker compose up -d
```

Compose поднимет два сервиса:

- `dynamodb-local` — локальная DynamoDB (порт 8000 доступен только внутри compose-сети);
- `app` — Next.js на порту 8080.

Проверить статус:

```shell
docker compose ps
```

## 4. Применение миграций БД

Миграции выполняются автоматически при старте `app`, но при необходимости их можно запустить вручную:

```shell
docker compose exec app npm run db:migrate
```

## 5. Запуск Telegram-бота (long polling)

```shell
docker compose --profile bot up -d bot
```

Сервис `bot` запускает `npm run bot:polling` рядом с приложением и автоматически перезапускается (`restart: on-failure`).

Чтобы бот включался автоматически (в том числе после перезагрузки VPS), добавьте в `.env` строку:

```dotenv
COMPOSE_PROFILES=bot
```

и выполните `docker compose up -d` ещё раз. Убедитесь, что Docker-демон стартует при загрузке системы (`sudo systemctl enable docker`).

> Важно: одновременно может работать только один процесс polling. Если бот запущен через Compose, не запускайте `npm run bot:polling` вручную на хосте.

## 6. Проверка работоспособности

1. Health-эндпоинт приложения:

   ```shell
   curl http://localhost:8080/api/health
   ```

   Ожидается JSON-ответ со статусом `ok`.

2. Telegram-бот: напишите боту `/start` в Telegram — он должен ответить. Логи:

   ```shell
   docker compose logs -f bot
   ```

   При старте бот валидирует токен (`getMe`) и снимает webhook — в логах должны быть сообщения «Токен валиден».

## Хранение данных

Все данные (пользователи, счета, подписки, позиции-копии и т.д.) хранятся в локальной DynamoDB в Docker-volume `dynamodb_data` на вашем сервере. Volume переживает перезапуск контейнеров, пересоздание через `docker compose up -d --force-recreate` и перезагрузку VPS. Для бэкапа можно скопировать данные volume (например, `docker run --rm -v <project>_dynamodb_data:/data -v $(pwd):/backup alpine tar czf /backup/dynamodb-data.tgz -C /data .`).

## 7. Обновление версии на VPS

```shell
git pull                                        # или повторный rsync
docker compose up -d                            # перезапуск приложения
docker compose exec app npm run db:migrate      # если менялась схема
docker compose --profile bot up -d bot          # если бот ещё не запущен
```

## Используемые npm-скрипты

| Скрипт                | Назначение                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `npm run bot:polling` | Long polling Telegram-бота (постоянный процесс).                           |
| `npm run db:migrate`  | Применение миграций DynamoDB-схемы (`scripts/migrate.ts`).                 |
| `npm run dev:docker`  | Запуск Next.js dev-сервера на порту 8080 (используется контейнером `app`). |
