import { sendMessage } from "./api";

/**
 * Отправляет уведомление пользователю бота. Токен берётся из окружения;
 * при его отсутствии или ошибке отправки уведомление тихо пропускается —
 * сбой рассылки не должен останавливать торговый цикл.
 */
export async function notifyUser(
  telegramId: string,
  text: string
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) return;

  try {
    await sendMessage(token, Number(telegramId), text);
  } catch (error) {
    console.error(`Failed to notify user ${telegramId}:`, error);
  }
}
