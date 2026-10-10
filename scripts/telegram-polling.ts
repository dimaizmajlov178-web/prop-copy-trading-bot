import "dotenv/config";
import {
  handleTelegramUpdate,
  type TelegramUpdate,
} from "@/lib/telegram/handler";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error(
    "❌ Переменная окружения TELEGRAM_BOT_TOKEN не задана.\n" +
      "   Установите её в .env или в окружении и перезапустите скрипт."
  );
  process.exit(1);
}

let running = true;

process.on("SIGINT", () => {
  console.log("\n⏹ Остановка polling по Ctrl+C...");
  running = false;
});

process.on("SIGTERM", () => {
  running = false;
});

async function callApi<T>(
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<TelegramApiResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    return (await response.json()) as TelegramApiResponse<T>;
  } finally {
    clearTimeout(timer);
  }
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    /abort/i.test(message) ||
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR/i.test(
      message
    )
  );
}

function reportNetworkProblem(): void {
  console.error(
    "🚫 Нет доступа к api.telegram.org из этого окружения (таймаут соединения).\n" +
      "   Webhook и long polling не смогут работать отсюда.\n" +
      "   ➡ Запустите бота из окружения с доступом к api.telegram.org:\n" +
      "       npm run bot:polling\n" +
      "   (не забудьте задать TELEGRAM_BOT_TOKEN и доступ к DynamoDB).\n" +
      "   После запуска бот начнёт отвечать на /start и остальные команды."
  );
}

async function checkConnection(): Promise<boolean> {
  console.log("🔌 Проверка доступа к api.telegram.org (getMe)...");

  try {
    const me = await callApi<{ id: number; username?: string }>(
      "getMe",
      {},
      15_000
    );

    if (!me.ok) {
      if (me.error_code === 401) {
        console.error(
          "❌ TELEGRAM_BOT_TOKEN недействителен (401 Unauthorized).\n" +
            "   Проверьте токен, полученный у @BotFather."
        );
      } else {
        console.error(
          `❌ Telegram API вернул ошибку: ${me.error_code} ${me.description}`
        );
      }
      return false;
    }

    console.log(
      `✅ Токен валиден, бот: @${me.result?.username ?? me.result?.id}`
    );
    return true;
  } catch (error) {
    if (isNetworkError(error)) {
      reportNetworkProblem();
    } else {
      console.error("❌ Неизвестная ошибка при проверке getMe:", error);
    }
    return false;
  }
}

async function main(): Promise<void> {
  const ok = await checkConnection();

  if (!ok) process.exit(1);

  console.log(
    "🗑 Снятие webhook (long polling и webhook не могут работать одновременно)..."
  );

  try {
    const deleted = await callApi<boolean>(
      "deleteWebhook",
      { drop_pending_updates: false },
      15_000
    );

    if (deleted.ok) {
      console.log(
        "✅ Webhook снят (роут /api/telegram/webhook сохранён и может быть включён позже)."
      );
    } else if (deleted.error_code === 404) {
      console.log("ℹ️ Webhook не был установлен — продолжаем.");
    } else {
      console.warn(
        `⚠️ deleteWebhook: ${deleted.error_code} ${deleted.description} — пробуем продолжить.`
      );
    }
  } catch (error) {
    if (isNetworkError(error)) {
      reportNetworkProblem();
      process.exit(1);
    }
    console.warn("⚠️ Не удалось снять webhook:", error);
  }

  console.log(
    "🔁 Запуск long polling (getUpdates)... Нажмите Ctrl+C для остановки."
  );

  let offset = 0;

  while (running) {
    let updates: TelegramUpdate[] = [];

    try {
      const result = await callApi<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
        35_000
      );

      if (!result.ok) {
        if (result.error_code === 409) {
          console.warn(
            "⚠️ Конфликт 409: активен webhook или другой экземпляр polling. Снимаем webhook и повторяем..."
          );

          await callApi("deleteWebhook", {}, 15_000).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }

        console.error(
          `⚠️ getUpdates: ${result.error_code} ${result.description} — повтор через 5с`
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      updates = result.result ?? [];
    } catch (error) {
      if (!running) break;

      if (isNetworkError(error)) {
        console.warn(
          "⚠️ Сеть до api.telegram.org потеряна — повтор через 5с..."
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      console.error("⚠️ Ошибка getUpdates:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    for (const update of updates) {
      if (typeof update.update_id === "number") {
        offset = update.update_id + 1;
      }

      try {
        await handleTelegramUpdate(update);
      } catch (error) {
        console.error(`⚠️ Ошибка обработки update ${update.update_id}:`, error);
      }
    }
  }

  console.log("✅ Polling остановлен.");
  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Фатальная ошибка:", error);
  process.exit(1);
});
