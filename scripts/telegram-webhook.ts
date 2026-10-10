import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("❌ Переменная окружения TELEGRAM_BOT_TOKEN не задана");
  process.exit(1);
}

const action = process.argv[2] ?? "set";
const url = process.argv[3];

const api = (method: string, payload: Record<string, unknown>) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

async function main() {
  if (action === "delete") {
    console.log("🗑 Снятие webhook...");
    console.log(JSON.stringify(await api("deleteWebhook", {}), null, 2));
    return;
  }

  if (!url || !url.startsWith("https://")) {
    console.error(
      "❌ Укажите публичный HTTPS URL: npm run bot:webhook -- set https://<домен>/api/telegram/webhook"
    );
    process.exit(1);
  }

  console.log(`🔗 Установка webhook: ${url}`);
  const result = await api("setWebhook", { url });
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error("❌ Ошибка:", e);
  process.exit(1);
});
