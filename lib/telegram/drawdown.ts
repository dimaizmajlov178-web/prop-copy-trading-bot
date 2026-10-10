import type { InlineKeyboardMarkup } from "./api";
import { answerCallbackQuery, editMessageText, sendMessage } from "./api";
import {
  DRAWDOWN_LIMIT_PRESETS,
  drawdownLimitSchema,
  formatDrawdownLimit,
} from "@/lib/validation/drawdown";
import {
  deleteBotState,
  getDrawdownSettings,
  listDrawdownStates,
  putBotState,
  putDrawdownSettings,
  type DrawdownSettings,
} from "@/lib/models";
import { todayUtc } from "@/lib/copy/drawdown";

/** Префикс callback-дат раздела «Лимит просадки». */
export const CALLBACK_DRAWDOWN_PREFIX = "dd:";

/** Префикс состояния «ожидаем ввод произвольного лимита» в bot_states. */
export const AWAITING_DRAWDOWN_LIMIT = "dd_limit";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function backToMenuRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ В главное меню", callback_data: "menu" }];
}

function renderScreen(
  token: string,
  chatId: number,
  messageId: number | undefined,
  screen: { text: string; keyboard: InlineKeyboardMarkup }
): Promise<void> {
  if (messageId) {
    return editMessageText(
      token,
      chatId,
      messageId,
      screen.text,
      screen.keyboard
    );
  }
  return sendMessage(token, chatId, screen.text, screen.keyboard);
}

async function loadSettings(telegramId: string): Promise<DrawdownSettings> {
  const existing = await getDrawdownSettings(telegramId);
  const now = new Date().toISOString();

  if (existing) return existing;

  return {
    telegramId,
    dailyLimitPercent: null,
    closePositionsOnBreach: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function buildDrawdownScreen(
  telegramId: string
): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
  const settings = await loadSettings(telegramId);
  const states = await listDrawdownStates(telegramId);
  const today = todayUtc();
  const triggeredToday = states.filter((state) => state.tradingDay === today);

  const lines: string[] = ["<b>🛡 Лимит дневной просадки</b>", ""];

  if (settings.dailyLimitPercent) {
    lines.push(
      `Текущий лимит: <b>${escapeHtml(
        formatDrawdownLimit(settings.dailyLimitPercent)
      )}%</b> от счета за день.`,
      `Автозакрытие позиций при срабатывании: <b>${
        settings.closePositionsOnBreach ? "включено" : "выключено"
      }</b>.`
    );
  } else {
    lines.push(
      "Лимит не задан — копирование продолжается независимо от дневного убытка.",
      "Задайте процент от счета, который вы готовы потерять за день: когда убыток от эквити на начало дня достигнет лимита, бот прекратит открывать новые копии на счете до конца дня и уведомит вас."
    );
  }

  if (triggeredToday.length > 0) {
    lines.push("", "<b>⚠️ Сработало сегодня:</b>");
    for (const state of triggeredToday) {
      lines.push(
        `• Счет <code>${escapeHtml(state.accountId)}</code> — лимит ${escapeHtml(
          formatDrawdownLimit(state.limitPercent)
        )}%, новые копии не открываются до конца дня${
          state.closePositions
            ? state.positionsClosed
              ? ", позиции закрыты"
              : ", закрытие позиций запланировано"
            : ""
        }.`
      );
    }
  }

  lines.push(
    "",
    "Лимит можно изменить в любой момент. На следующий день срабатывание сбрасывается и копирование возобновляется."
  );

  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };

  if (settings.dailyLimitPercent) {
    for (const preset of DRAWDOWN_LIMIT_PRESETS) {
      keyboard.inline_keyboard.push([
        {
          text: `Сменить на ${preset.label}`,
          callback_data: `dd:set:${preset.value}`,
        },
      ]);
    }
    keyboard.inline_keyboard.push([
      {
        text: "✍️ Ввести свой лимит",
        callback_data: "dd:custom",
      },
    ]);
    keyboard.inline_keyboard.push([
      {
        text: `🧹 Автозакрытие (close-all): ${
          settings.closePositionsOnBreach ? "выключить" : "включить"
        }`,
        callback_data: "dd:toggle-close",
      },
    ]);
    keyboard.inline_keyboard.push([
      {
        text: "🚫 Убрать лимит",
        callback_data: "dd:clear",
      },
    ]);
  } else {
    for (const preset of DRAWDOWN_LIMIT_PRESETS) {
      keyboard.inline_keyboard.push([
        {
          text: `Задать ${preset.label}`,
          callback_data: `dd:set:${preset.value}`,
        },
      ]);
    }
    keyboard.inline_keyboard.push([
      {
        text: "✍️ Ввести свой лимит",
        callback_data: "dd:custom",
      },
    ]);
  }

  keyboard.inline_keyboard.push(backToMenuRow());

  return { text: lines.join("\n"), keyboard };
}

function buildCustomInputScreen(): {
  text: string;
  keyboard: InlineKeyboardMarkup;
} {
  return {
    text: [
      "<b>✍️ Свой дневной лимит просадки</b>",
      "",
      "Введите лимит в процентах от счета — сколько вы готовы потерять за день.",
      "Примеры: <code>2</code>, <code>2.5</code>, <code>10</code>.",
      "Допустимый диапазон: от 0.1 до 100, не более двух знаков после запятой.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "❌ Отмена", callback_data: "dd:cancel" }],
        backToMenuRow(),
      ],
    },
  };
}

async function saveLimit(
  telegramId: string,
  limitPercent: string | null
): Promise<void> {
  const settings = await loadSettings(telegramId);
  await putDrawdownSettings({
    ...settings,
    dailyLimitPercent: limitPercent,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Обрабатывает callback-запросы раздела «Лимит просадки».
 * Возвращает true, если callback относится к разделу.
 */
export async function handleDrawdownCallback(
  token: string,
  chatId: number,
  telegramId: string,
  messageId: number | undefined,
  callbackQueryId: string,
  data: string
): Promise<boolean> {
  if (!data.startsWith(CALLBACK_DRAWDOWN_PREFIX)) return false;

  const action = data.slice(CALLBACK_DRAWDOWN_PREFIX.length);
  let alert: string | undefined;

  try {
    if (action === "list" || action === "cancel") {
      await deleteBotState(telegramId).catch(() => {});
      await renderScreen(
        token,
        chatId,
        messageId,
        await buildDrawdownScreen(telegramId)
      );
      return true;
    }

    if (action.startsWith("set:")) {
      const parsed = drawdownLimitSchema.safeParse(action.slice("set:".length));

      if (!parsed.success) {
        alert = "Некорректное значение лимита.";
        return true;
      }

      await saveLimit(telegramId, parsed.data);
      await deleteBotState(telegramId).catch(() => {});

      await renderScreen(
        token,
        chatId,
        messageId,
        await buildDrawdownScreen(telegramId)
      );
      alert = `Дневной лимит просадки: ${formatDrawdownLimit(parsed.data)}%`;
      return true;
    }

    if (action === "custom") {
      await putBotState({
        telegramId,
        awaiting: AWAITING_DRAWDOWN_LIMIT,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await renderScreen(token, chatId, messageId, buildCustomInputScreen());
      return true;
    }

    if (action === "clear") {
      await saveLimit(telegramId, null);
      await deleteBotState(telegramId).catch(() => {});

      await renderScreen(
        token,
        chatId,
        messageId,
        await buildDrawdownScreen(telegramId)
      );
      alert = "Лимит просадки убран.";
      return true;
    }

    if (action === "toggle-close") {
      const settings = await loadSettings(telegramId);
      await putDrawdownSettings({
        ...settings,
        closePositionsOnBreach: !settings.closePositionsOnBreach,
        updatedAt: new Date().toISOString(),
      });

      await renderScreen(
        token,
        chatId,
        messageId,
        await buildDrawdownScreen(telegramId)
      );
      alert = !settings.closePositionsOnBreach
        ? "Автозакрытие позиций (close-all) включено."
        : "Автозакрытие позиций (close-all) выключено.";
      return true;
    }

    alert = "Неизвестное действие раздела «Лимит просадки».";
    return true;
  } finally {
    await answerCallbackQuery(token, callbackQueryId, alert);
  }
}

/**
 * Обрабатывает текстовое сообщение, когда бот ожидает ввод произвольного
 * дневного лимита. Возвращает true, если ожидающее состояние обработано.
 */
export async function handleDrawdownLimitInput(
  token: string,
  chatId: number,
  telegramId: string,
  awaiting: string,
  text: string
): Promise<boolean> {
  if (awaiting !== AWAITING_DRAWDOWN_LIMIT) return false;

  const parsed = drawdownLimitSchema.safeParse(text);

  if (!parsed.success) {
    await sendMessage(
      token,
      chatId,
      [
        "⚠️ <b>Некорректный лимит</b>",
        "",
        escapeHtml(
          parsed.error.issues[0]?.message ??
            "Введите число от 0.1 до 100, например 2 или 2.5."
        ),
        "",
        "Отправьте лимит еще раз или нажмите «Отмена».",
      ].join("\n"),
      {
        inline_keyboard: [[{ text: "❌ Отмена", callback_data: "dd:cancel" }]],
      }
    );
    return true;
  }

  try {
    await saveLimit(telegramId, parsed.data);
    await deleteBotState(telegramId).catch(() => {});

    const screen = await buildDrawdownScreen(telegramId);
    await sendMessage(
      token,
      chatId,
      `✅ Дневной лимит просадки установлен: <b>${escapeHtml(
        formatDrawdownLimit(parsed.data)
      )}%</b>.`
    );
    await sendMessage(token, chatId, screen.text, screen.keyboard);

    return true;
  } catch (error) {
    console.error("Failed to save drawdown limit:", error);
    await sendMessage(
      token,
      chatId,
      "⚠️ Ошибка базы данных. Попробуйте позже.",
      {
        inline_keyboard: [[{ text: "❌ Отмена", callback_data: "dd:cancel" }]],
      }
    );
    return true;
  }
}
