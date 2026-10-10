import { z } from "zod";
import type { InlineKeyboardMarkup } from "./api";
import { answerCallbackQuery, editMessageText, sendMessage } from "./api";
import {
  COEFFICIENT_PRESETS,
  formatCoefficient,
  subscriptionCoefficientSchema,
} from "@/lib/validation/subscriptions";
import {
  deleteBotState,
  deleteTraderSubscription,
  getBotUser,
  getTraderSubscription,
  listTraderSubscriptions,
  listUpscaleBindings,
  putBotState,
  putTraderSubscription,
  updateTraderSubscription,
  type BotUser,
  type TraderSubscription,
} from "@/lib/models";

/** Префикс callback-дат раздела «Мои подписки». */
export const CALLBACK_SUBSCRIPTIONS_PREFIX = "subs:";

/** Префикс состояния «ожидаем ввод произвольного коэффициента» в bot_states. */
export const AWAITING_SUB_COEFFICIENT_PREFIX = "sub_coef:";

const traderIdSchema = z.string().regex(/^\d{1,20}$/);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function backToMenuRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ В главное меню", callback_data: "menu" }];
}

function backToSubsRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ К списку подписок", callback_data: "subs:list" }];
}

function displayName(user: BotUser): string {
  return user.tag ?? user.username ?? `ID ${user.telegramId}`;
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

/**
 * Проверяет готовность участника к копированию: нужен привязанный основной
 * счет (источник сделок) и хотя бы один дополнительный счет с включённой
 * API-торговлей (на нем открываются копии). Возвращает текст ошибки или null.
 */
async function checkCopyAccounts(telegramId: string): Promise<string | null> {
  const bindings = await listUpscaleBindings(telegramId);
  const primary = bindings.find((binding) => binding.kind === "primary");
  const additional = bindings.filter(
    (binding) => binding.kind === "additional"
  );

  if (!primary || primary.accounts.length === 0) {
    return "Подписка требует привязанных счетов. Сначала привяжите основной счет в разделе «💼 Мои счета» — он будет источником сделок.";
  }

  if (additional.length === 0) {
    return "Подписка требует дополнительных счетов. Основной счет не копируется — привяжите хотя бы один дополнительный счет в разделе «💼 Мои счета», на нем будут открываться копии.";
  }

  const hasApiTrading = additional.some((binding) =>
    binding.accounts.some((account) => account.apiTrading)
  );

  if (!hasApiTrading) {
    return "На ваших дополнительных счетах не включена API-торговля — копирование невозможно. Включите API-торговлю в UpScale и обновите привязку в разделе «💼 Мои счета».";
  }

  return null;
}

async function loadTrader(traderTelegramId: string): Promise<BotUser | null> {
  const user = await getBotUser(traderTelegramId);
  return user && user.role === "trader" ? user : null;
}

export async function buildSubscriptionsScreen(
  telegramId: string
): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
  const subscriptions = await listTraderSubscriptions(telegramId);

  if (subscriptions.length === 0) {
    return {
      text: [
        "<b>🔗 Мои подписки</b>",
        "",
        "Активных подписок нет.",
        "Откройте раздел «📈 Активные трейдеры», выберите трейдера и нажмите «Подписаться», выбрав коэффициент копирования.",
      ].join("\n"),
      keyboard: { inline_keyboard: [backToMenuRow()] },
    };
  }

  const lines: string[] = [
    "<b>🔗 Мои подписки</b>",
    "",
    "Ваши активные подписки. Копии позиций открываются на ваших дополнительных счетах с выбранным коэффициентом.",
    "",
  ];
  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };

  const sorted = [...subscriptions].sort((a, b) =>
    a.traderTelegramId.localeCompare(b.traderTelegramId)
  );

  for (let index = 0; index < sorted.length; index++) {
    const subscription = sorted[index];
    const trader = await loadTrader(subscription.traderTelegramId);
    const name = trader
      ? escapeHtml(displayName(trader))
      : "трейдер недоступен";

    lines.push(
      `${index + 1}. <b>${name}</b> — коэффициент <b>${escapeHtml(
        formatCoefficient(subscription.coefficient)
      )}:1</b>`,
      `     Трейдер: <code>${escapeHtml(subscription.traderTelegramId)}</code>`
    );

    keyboard.inline_keyboard.push([
      {
        text: `⚙️ Коэффициент ${escapeHtml(
          formatCoefficient(subscription.coefficient)
        )}`,
        callback_data: `subs:set:${subscription.traderTelegramId}`,
      },
      {
        text: "✖️ Отписаться",
        callback_data: `subs:unsub:${subscription.traderTelegramId}`,
      },
    ]);
  }

  keyboard.inline_keyboard.push(backToMenuRow());

  return { text: lines.join("\n"), keyboard };
}

function buildCoefficientScreen(
  trader: BotUser,
  current: TraderSubscription | null
): { text: string; keyboard: InlineKeyboardMarkup } {
  const isChange = current !== null;

  const lines: string[] = [
    isChange
      ? "<b>⚙️ Смена коэффициента</b>"
      : "<b>🔗 Подписка на трейдера</b>",
    "",
    `Трейдер: <b>${escapeHtml(displayName(trader))}</b>`,
  ];

  if (isChange) {
    lines.push(
      `Текущий коэффициент: <b>${escapeHtml(
        formatCoefficient(current.coefficient)
      )}:1</b>`
    );
  }

  lines.push(
    "",
    "Выберите соотношение копирования — во сколько раз объем копии отличается от пропорции по размерам счетов:",
    "• 2:1 — копия вдвое больше пропорции",
    "• 1:1 — копия равна пропорции",
    "• 0,5:1 — копия вдвое меньше пропорции",
    "",
    "Основной счет не копируется: копии открываются на ваших дополнительных счетах."
  );

  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };

  for (const preset of COEFFICIENT_PRESETS) {
    keyboard.inline_keyboard.push([
      {
        text: `${isChange ? "Сменить на" : "Выбрать"} ${preset.label}`,
        callback_data: `subs:coef:${trader.telegramId}:${preset.value}`,
      },
    ]);
  }

  keyboard.inline_keyboard.push([
    {
      text: "✍️ Ввести свой коэффициент",
      callback_data: `subs:custom:${trader.telegramId}`,
    },
  ]);
  keyboard.inline_keyboard.push(backToSubsRow());
  keyboard.inline_keyboard.push(backToMenuRow());

  return { text: lines.join("\n"), keyboard };
}

function buildCustomInputScreen(trader: BotUser): {
  text: string;
  keyboard: InlineKeyboardMarkup;
} {
  return {
    text: [
      "<b>✍️ Свой коэффициент копирования</b>",
      "",
      `Трейдер: <b>${escapeHtml(displayName(trader))}</b>`,
      "",
      "Введите коэффициент числом — во сколько раз объем копии отличается от пропорции по размерам счетов.",
      "Примеры: <code>1.5</code>, <code>0.75</code>, <code>3</code>.",
      "Допустимый диапазон: от 0,01 до 100, не более двух знаков после запятой.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "❌ Отмена", callback_data: "subs:cancel" }],
        backToMenuRow(),
      ],
    },
  };
}

function buildUnsubConfirmScreen(
  trader: BotUser,
  subscription: TraderSubscription
): { text: string; keyboard: InlineKeyboardMarkup } {
  return {
    text: [
      "<b>✖️ Отписаться от трейдера?</b>",
      "",
      `Трейдер: <b>${escapeHtml(displayName(trader))}</b>`,
      `Коэффициент: <b>${escapeHtml(
        formatCoefficient(subscription.coefficient)
      )}:1</b>`,
      "",
      "После отписки копирование позиций этого трейдера прекратится. Уже открытые копии не закрываются автоматически.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          {
            text: "✅ Отписаться",
            callback_data: `subs:unsubc:${trader.telegramId}`,
          },
          { text: "❌ Отмена", callback_data: "subs:list" },
        ],
        backToMenuRow(),
      ],
    },
  };
}

function buildErrorScreen(message: string): {
  text: string;
  keyboard: InlineKeyboardMarkup;
} {
  return {
    text: [`⚠️ <b>Ошибка</b>`, "", message].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "❌ Отмена", callback_data: "subs:cancel" }],
        backToMenuRow(),
      ],
    },
  };
}

async function subscribeWithCoefficient(
  telegramId: string,
  traderTelegramId: string,
  coefficient: string
): Promise<void> {
  const existing = await getTraderSubscription(telegramId, traderTelegramId);

  if (existing) {
    await updateTraderSubscription(telegramId, traderTelegramId, coefficient);
  } else {
    await putTraderSubscription({
      subscriberTelegramId: telegramId,
      traderTelegramId,
      coefficient,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * Обрабатывает callback-запросы раздела «Мои подписки».
 * Возвращает true, если callback относится к разделу.
 */
export async function handleSubscriptionsCallback(
  token: string,
  chatId: number,
  telegramId: string,
  messageId: number | undefined,
  callbackQueryId: string,
  data: string
): Promise<boolean> {
  if (!data.startsWith(CALLBACK_SUBSCRIPTIONS_PREFIX)) return false;

  const action = data.slice(CALLBACK_SUBSCRIPTIONS_PREFIX.length);
  let alert: string | undefined;

  try {
    if (action === "list" || action === "cancel") {
      await deleteBotState(telegramId).catch(() => {});
      await renderScreen(
        token,
        chatId,
        messageId,
        await buildSubscriptionsScreen(telegramId)
      );
      return true;
    }

    if (action.startsWith("set:") || action.startsWith("sub:")) {
      const traderId = action.slice(action.indexOf(":") + 1);
      const parsed = traderIdSchema.safeParse(traderId);

      if (!parsed.success) {
        alert = "Неизвестное действие раздела «Мои подписки».";
        return true;
      }

      const trader = await loadTrader(parsed.data);

      if (!trader) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen("Трейдер не найден или больше не активен.")
        );
        return true;
      }

      if (parsed.data === telegramId) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen("Нельзя подписаться на себя.")
        );
        return true;
      }

      const accountsError = await checkCopyAccounts(telegramId);

      if (accountsError) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen(accountsError)
        );
        return true;
      }

      const current = await getTraderSubscription(telegramId, parsed.data);
      await renderScreen(
        token,
        chatId,
        messageId,
        buildCoefficientScreen(trader, current)
      );
      return true;
    }

    if (action.startsWith("coef:")) {
      const [traderId, coefficient] = action.slice("coef:".length).split(":");

      const parsedId = traderIdSchema.safeParse(traderId ?? "");
      const parsedCoefficient = subscriptionCoefficientSchema.safeParse(
        coefficient ?? ""
      );

      if (!parsedId.success || !parsedCoefficient.success) {
        alert = "Неизвестное действие раздела «Мои подписки».";
        return true;
      }

      const trader = await loadTrader(parsedId.data);

      if (!trader) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen("Трейдер не найден или больше не активен.")
        );
        return true;
      }

      const accountsError = await checkCopyAccounts(telegramId);

      if (accountsError) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen(accountsError)
        );
        return true;
      }

      const existing = await getTraderSubscription(telegramId, parsedId.data);
      await subscribeWithCoefficient(
        telegramId,
        parsedId.data,
        parsedCoefficient.data
      );
      await deleteBotState(telegramId).catch(() => {});

      await renderScreen(
        token,
        chatId,
        messageId,
        await buildSubscriptionsScreen(telegramId)
      );

      alert = existing
        ? `Коэффициент изменен на ${formatCoefficient(parsedCoefficient.data)}:1`
        : `Подписка оформлена, коэффициент ${formatCoefficient(parsedCoefficient.data)}:1`;
      return true;
    }

    if (action.startsWith("custom:")) {
      const traderId = action.slice("custom:".length);
      const parsed = traderIdSchema.safeParse(traderId);

      if (!parsed.success) {
        alert = "Неизвестное действие раздела «Мои подписки».";
        return true;
      }

      const trader = await loadTrader(parsed.data);

      if (!trader) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen("Трейдер не найден или больше не активен.")
        );
        return true;
      }

      await putBotState({
        telegramId,
        awaiting: `${AWAITING_SUB_COEFFICIENT_PREFIX}${parsed.data}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await renderScreen(
        token,
        chatId,
        messageId,
        buildCustomInputScreen(trader)
      );
      return true;
    }

    if (action.startsWith("unsubc:")) {
      const traderId = action.slice("unsubc:".length);
      const parsed = traderIdSchema.safeParse(traderId);

      if (!parsed.success) {
        alert = "Неизвестное действие раздела «Мои подписки».";
        return true;
      }

      await deleteTraderSubscription(telegramId, parsed.data);
      await deleteBotState(telegramId).catch(() => {});

      await renderScreen(
        token,
        chatId,
        messageId,
        await buildSubscriptionsScreen(telegramId)
      );
      await sendMessage(
        token,
        chatId,
        "✅ Вы отписались. Копирование позиций этого трейдера прекращено."
      );
      return true;
    }

    if (action.startsWith("unsub:")) {
      const traderId = action.slice("unsub:".length);
      const parsed = traderIdSchema.safeParse(traderId);

      if (!parsed.success) {
        alert = "Неизвестное действие раздела «Мои подписки».";
        return true;
      }

      const subscription = await getTraderSubscription(telegramId, parsed.data);

      if (!subscription) {
        alert = "Подписка не найдена.";
        await renderScreen(
          token,
          chatId,
          messageId,
          await buildSubscriptionsScreen(telegramId)
        );
        return true;
      }

      const trader = await loadTrader(parsed.data);

      if (!trader) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen("Трейдер не найден или больше не активен.")
        );
        return true;
      }

      await renderScreen(
        token,
        chatId,
        messageId,
        buildUnsubConfirmScreen(trader, subscription)
      );
      return true;
    }

    alert = "Неизвестное действие раздела «Мои подписки».";
    return true;
  } finally {
    await answerCallbackQuery(token, callbackQueryId, alert);
  }
}

/**
 * Обрабатывает текстовое сообщение, когда бот ожидает ввод произвольного
 * коэффициента подписки. Возвращает true, если ожидающее состояние обработано.
 */
export async function handleSubscriptionCoefficientInput(
  token: string,
  chatId: number,
  telegramId: string,
  awaiting: string,
  text: string
): Promise<boolean> {
  if (!awaiting.startsWith(AWAITING_SUB_COEFFICIENT_PREFIX)) return false;

  const traderId = awaiting.slice(AWAITING_SUB_COEFFICIENT_PREFIX.length);
  const parsedId = traderIdSchema.safeParse(traderId);

  if (!parsedId.success) {
    await deleteBotState(telegramId).catch(() => {});
    await sendMessage(
      token,
      chatId,
      "⚠️ Состояние подписки устарело. Начните заново из карточки трейдера."
    );
    return true;
  }

  const parsed = subscriptionCoefficientSchema.safeParse(text);

  if (!parsed.success) {
    await sendMessage(
      token,
      chatId,
      [
        "⚠️ <b>Некорректный коэффициент</b>",
        "",
        escapeHtml(
          parsed.error.issues[0]?.message ??
            "Введите число, например 1.5 или 0.75."
        ),
        "",
        "Отправьте коэффициент еще раз или нажмите «Отмена».",
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "❌ Отмена", callback_data: "subs:cancel" }],
        ],
      }
    );
    return true;
  }

  try {
    const trader = await loadTrader(parsedId.data);

    if (!trader) {
      await deleteBotState(telegramId).catch(() => {});
      await sendMessage(
        token,
        chatId,
        "⚠️ Трейдер не найден или больше не активен. Подписка не изменена."
      );
      return true;
    }

    const accountsError = await checkCopyAccounts(telegramId);

    if (accountsError) {
      await deleteBotState(telegramId).catch(() => {});
      await sendMessage(token, chatId, accountsError);
      return true;
    }

    const existing = await getTraderSubscription(telegramId, parsedId.data);
    await subscribeWithCoefficient(telegramId, parsedId.data, parsed.data);
    await deleteBotState(telegramId).catch(() => {});

    const screen = await buildSubscriptionsScreen(telegramId);
    await sendMessage(
      token,
      chatId,
      existing
        ? `✅ Коэффициент изменен на <b>${escapeHtml(
            formatCoefficient(parsed.data)
          )}:1</b>.`
        : `✅ Подписка оформлена с коэффициентом <b>${escapeHtml(
            formatCoefficient(parsed.data)
          )}:1</b>.`
    );
    await sendMessage(token, chatId, screen.text, screen.keyboard);

    return true;
  } catch (error) {
    console.error("Failed to save subscription coefficient:", error);
    await sendMessage(
      token,
      chatId,
      "⚠️ Ошибка базы данных. Попробуйте позже.",
      {
        inline_keyboard: [
          [{ text: "❌ Отмена", callback_data: "subs:cancel" }],
        ],
      }
    );
    return true;
  }
}
