import { z } from "zod";
import type { InlineKeyboardMarkup } from "./api";
import { answerCallbackQuery, editMessageText, sendMessage } from "./api";
import { decryptSecret, encryptSecret, maskApiKey } from "./crypto";
import {
  UpscaleApiError,
  fetchAccountsWithRiskStatus,
} from "@/lib/upscale/client";
import { formatFp9 } from "@/lib/upscale/fp9";
import {
  deleteBotState,
  deleteUpscaleBinding,
  deleteUpscaleBindingsByKind,
  listUpscaleBindings,
  putBotState,
  putUpscaleBinding,
  type UpscaleAccountInfo,
  type UpscaleBinding,
  type UpscaleBindingKind,
} from "@/lib/models";

const MAX_ADDITIONAL_KEYS = 10;
const MAX_ACCOUNTS_PER_BINDING = 10;

/** Значения состояния «ожидаем API-ключ» в bot_states. */
export const AWAITING_UPSCALE_KEY_PRIMARY = "upscale_key_primary";
export const AWAITING_UPSCALE_KEY_ADDITIONAL = "upscale_key_additional";

/** Префикс callback-дат раздела «Мои счета». */
export const CALLBACK_ACCOUNTS_PREFIX = "accounts:";

export const upscaleApiKeySchema = z
  .string()
  .trim()
  .regex(
    /^usk_[A-Za-z0-9_-]{8,128}$/,
    "Неверный формат ключа: API-ключ UpScale должен начинаться с usk_ и содержать только латинские буквы, цифры, дефисы и подчёркивания."
  );

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toAwaitingValue(kind: UpscaleBindingKind): string {
  return kind === "primary"
    ? AWAITING_UPSCALE_KEY_PRIMARY
    : AWAITING_UPSCALE_KEY_ADDITIONAL;
}

function toKind(awaiting: string): UpscaleBindingKind | null {
  if (awaiting === AWAITING_UPSCALE_KEY_PRIMARY) return "primary";
  if (awaiting === AWAITING_UPSCALE_KEY_ADDITIONAL) return "additional";
  return null;
}

function backToMenuRow(): InlineKeyboardMarkup["inline_keyboard"][number] {
  return [{ text: "⬅️ В главное меню", callback_data: "menu" }];
}

function formatAccountLine(account: UpscaleAccountInfo, index: number): string {
  const phase = account.phase ? escapeHtml(account.phase) : "фаза неизвестна";
  const balance = formatFp9(account.balanceFp9);
  const equity = formatFp9(account.equityFp9);
  const trading = account.apiTrading
    ? "API-торговля: ✅ включена"
    : "API-торговля: ⛔️ выключена — непригоден для копирования";

  return [
    `  ${index + 1}) Счет <code>${escapeHtml(account.accountId)}</code> — ${phase}`,
    `     Баланс: ${balance} · Эквити: ${equity}`,
    `     ${trading}`,
  ].join("\n");
}

function formatBindingAccounts(binding: UpscaleBinding): string {
  const accounts =
    binding.accounts.length > 0
      ? binding.accounts
          .slice(0, MAX_ACCOUNTS_PER_BINDING)
          .map(formatAccountLine)
          .join("\n")
      : "  Счета не найдены.";

  return [
    `Ключ: <code>${escapeHtml(binding.apiKeyMasked)}</code>`,
    accounts,
  ].join("\n");
}

export async function buildAccountsScreen(
  telegramId: string
): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
  const bindings = await listUpscaleBindings(telegramId);
  const primary = bindings
    .filter((b) => b.kind === "primary")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
  const additional = bindings
    .filter((b) => b.kind === "additional")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const blocks: string[] = [];

  if (primary) {
    blocks.push(
      "<b>🔑 Основной счет</b> — источник сделок",
      formatBindingAccounts(primary)
    );
  } else {
    blocks.push(
      "<b>🔑 Основной счет</b> — источник сделок",
      "Еще не привязан. Добавьте API-ключ, чтобы бот мог копировать сделки."
    );
  }

  blocks.push("");

  if (additional.length > 0) {
    blocks.push(
      `<b>Дополнительные счета</b> — для копирования (${additional.length}):`,
      "",
      ...additional.map(
        (binding, index) =>
          `${index + 1}. 🔑 Дополнительный счет ${index + 1}\n${formatBindingAccounts(binding)}`
      )
    );
  } else {
    blocks.push(
      "<b>Дополнительные счета</b> — для копирования",
      "Не привязаны. Добавьте API-ключ дополнительного счета, чтобы бот открывал на нем копии сделок."
    );
  }

  blocks.push("");

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: "🔑 Привязать основной счет",
          callback_data: "accounts:add:primary",
        },
      ],
      [
        {
          text: "🔑 Привязать дополнительный счет",
          callback_data: "accounts:add:additional",
        },
      ],
    ],
  };

  if (primary) {
    keyboard.inline_keyboard.push([
      {
        text: "🗑 Удалить основной ключ",
        callback_data: `accounts:del:${primary.bindingId}`,
      },
    ]);
  }

  additional.forEach((binding, index) => {
    keyboard.inline_keyboard.push([
      {
        text: `🗑 Удалить доп. ключ ${index + 1}`,
        callback_data: `accounts:del:${binding.bindingId}`,
      },
    ]);
  });

  keyboard.inline_keyboard.push(backToMenuRow());

  return { text: [`<b>💼 Мои счета</b>`, "", ...blocks].join("\n"), keyboard };
}

function buildAddKeyScreen(kind: UpscaleBindingKind): {
  text: string;
  keyboard: InlineKeyboardMarkup;
} {
  const title =
    kind === "primary"
      ? "<b>🔑 Привязка основного счета</b>"
      : "<b>🔑 Привязка дополнительного счета</b>";

  const roleNote =
    kind === "primary"
      ? "Основной счет — источник сделок: по нему бот отслеживает позиции. Повторная привязка заменит текущий основной ключ."
      : "На дополнительных счетах бот открывает копии позиций.";

  const text = [
    title,
    "",
    roleNote,
    "",
    "Отправьте API-ключ UpScale следующим сообщением.",
    "Ключ начинается с <code>usk_</code> и создаётся в личном кабинете UpScale.",
    "По ключу бот проверит счета через GET /accounts/with-risk-status и покажет баланс, эквити, фазу и статус API-торговли.",
    "",
    "🔒 Ключ хранится защищённо (шифруется перед записью в базу) и в чате отображается только маскированным.",
  ].join("\n");

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: "❌ Отмена", callback_data: "accounts:cancel" }],
        backToMenuRow(),
      ],
    },
  };
}

function buildDeleteConfirmScreen(binding: UpscaleBinding): {
  text: string;
  keyboard: InlineKeyboardMarkup;
} {
  const kindLabel =
    binding.kind === "primary" ? "основного счета" : "дополнительного счета";

  const text = [
    `<b>🗑 Удалить привязку ${kindLabel}?</b>`,
    "",
    `Ключ: <code>${escapeHtml(binding.apiKeyMasked)}</code>`,
    "",
    "После удаления бот перестанет работать с этим счетом.",
  ].join("\n");

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [
          {
            text: "✅ Удалить",
            callback_data: `accounts:delc:${binding.bindingId}`,
          },
          { text: "❌ Отмена", callback_data: "accounts:view" },
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
        [{ text: "❌ Отмена", callback_data: "accounts:cancel" }],
        backToMenuRow(),
      ],
    },
  };
}

/**
 * Обрабатывает callback-запросы раздела «Мои счета».
 * Возвращает true, если callback относится к разделу.
 */
export async function handleAccountsCallback(
  token: string,
  chatId: number,
  telegramId: string,
  messageId: number | undefined,
  callbackQueryId: string,
  data: string
): Promise<boolean> {
  if (!data.startsWith(CALLBACK_ACCOUNTS_PREFIX)) return false;

  const action = data.slice(CALLBACK_ACCOUNTS_PREFIX.length);

  try {
    if (action === "view") {
      await deleteBotState(telegramId);
      const screen = await buildAccountsScreen(telegramId);
      await renderScreen(token, chatId, messageId, screen);
      return true;
    }

    if (action === "cancel") {
      await deleteBotState(telegramId);
      const screen = await buildAccountsScreen(telegramId);
      await renderScreen(token, chatId, messageId, screen);
      return true;
    }

    if (action === "add:primary" || action === "add:additional") {
      const kind: UpscaleBindingKind =
        action === "add:primary" ? "primary" : "additional";

      if (kind === "additional") {
        const bindings = await listUpscaleBindings(telegramId);
        const additionalCount = bindings.filter(
          (b) => b.kind === "additional"
        ).length;
        if (additionalCount >= MAX_ADDITIONAL_KEYS) {
          await renderScreen(
            token,
            chatId,
            messageId,
            buildErrorScreen(
              `Можно привязать не более ${MAX_ADDITIONAL_KEYS} дополнительных ключей. Удалите ненужную привязку и попробуйте снова.`
            )
          );
          return true;
        }
      }

      await putBotState({
        telegramId,
        awaiting: toAwaitingValue(kind),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await renderScreen(token, chatId, messageId, buildAddKeyScreen(kind));
      return true;
    }

    if (action.startsWith("del:")) {
      const bindingId = action.slice("del:".length);
      const binding = await listUpscaleBindings(telegramId).then((bindings) =>
        bindings.find((b) => b.bindingId === bindingId)
      );

      if (!binding) {
        await renderScreen(
          token,
          chatId,
          messageId,
          buildErrorScreen("Привязка не найдена или уже удалена.")
        );
        return true;
      }

      await renderScreen(
        token,
        chatId,
        messageId,
        buildDeleteConfirmScreen(binding)
      );
      return true;
    }

    if (action.startsWith("delc:")) {
      const bindingId = action.slice("delc:".length);
      await deleteUpscaleBinding(telegramId, bindingId);
      await deleteBotState(telegramId);
      const screen = await buildAccountsScreen(telegramId);
      await renderScreen(token, chatId, messageId, screen);
      await sendMessage(
        token,
        chatId,
        "✅ Привязка удалена. Бот больше не работает с этим счетом."
      );
      return true;
    }

    await sendMessage(
      token,
      chatId,
      "Неизвестное действие раздела «Мои счета»."
    );
    return true;
  } finally {
    // callback-запрос всегда подтверждаем, чтобы убрать «часики» в клиенте
    await answerCallbackQuery(token, callbackQueryId);
  }
}

async function renderScreen(
  token: string,
  chatId: number,
  messageId: number | undefined,
  screen: { text: string; keyboard: InlineKeyboardMarkup }
): Promise<void> {
  if (messageId) {
    await editMessageText(
      token,
      chatId,
      messageId,
      screen.text,
      screen.keyboard
    );
  } else {
    await sendMessage(token, chatId, screen.text, screen.keyboard);
  }
}

/**
 * Обрабатывает текстовое сообщение, когда бот ожидает ввод API-ключа.
 * Возвращает true, если ожидающее состояние обработано.
 */
export async function handleUpscaleKeyInput(
  token: string,
  chatId: number,
  telegramId: string,
  awaiting: string,
  text: string
): Promise<boolean> {
  const kind = toKind(awaiting);

  if (!kind) return false;

  const parsed = upscaleApiKeySchema.safeParse(text);

  if (!parsed.success) {
    await sendMessage(
      token,
      chatId,
      [
        "⚠️ <b>Неверный формат API-ключа</b>",
        "",
        escapeHtml(
          parsed.error.issues[0]?.message ??
            "Проверьте ключ и попробуйте снова."
        ),
        "",
        "Отправьте ключ еще раз или нажмите «Отмена».",
      ].join("\n"),
      {
        inline_keyboard: [
          [{ text: "❌ Отмена", callback_data: "accounts:cancel" }],
        ],
      }
    );
    return true;
  }

  try {
    const accounts = await fetchAccountsWithRiskStatus(parsed.data);

    if (accounts.length === 0) {
      await sendMessage(
        token,
        chatId,
        [
          "⚠️ <b>Счета не найдены</b>",
          "",
          "По этому ключу UpScale не вернул ни одного счета.",
          "Проверьте, что ключ действителен и имеет доступ к счетам, и отправьте его еще раз.",
        ].join("\n"),
        {
          inline_keyboard: [
            [{ text: "❌ Отмена", callback_data: "accounts:cancel" }],
          ],
        }
      );
      return true;
    }

    const existing = await listUpscaleBindings(telegramId);
    const now = new Date().toISOString();

    const findDuplicateAdditional =
      async (): Promise<UpscaleBinding | null> => {
        for (const binding of existing) {
          if (binding.kind !== "additional") continue;
          try {
            if (decryptSecret(binding.apiKeyEncrypted) === parsed.data) {
              return binding;
            }
          } catch {
            if (binding.apiKeyMasked === maskApiKey(parsed.data)) {
              return binding;
            }
          }
        }
        return null;
      };

    const duplicate = await findDuplicateAdditional();

    if (duplicate && kind === "additional") {
      await putUpscaleBinding({ ...duplicate, accounts, updatedAt: now });
    } else {
      if (kind === "primary") {
        await deleteUpscaleBindingsByKind(telegramId, "primary");
      }

      if (duplicate && kind === "primary") {
        await putUpscaleBinding({
          ...duplicate,
          kind: "primary",
          accounts,
          updatedAt: now,
        });
      } else {
        await putUpscaleBinding({
          telegramId,
          bindingId: crypto.randomUUID(),
          kind,
          apiKeyEncrypted: encryptSecret(parsed.data),
          apiKeyMasked: maskApiKey(parsed.data),
          accounts,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    await deleteBotState(telegramId);

    const screen = await buildAccountsScreen(telegramId);
    const intro = duplicate
      ? "ℹ️ Этот ключ уже был привязан — привязка обновлена."
      : `✅ <b>Привязка сохранена</b>. Найдено счетов: ${accounts.length}.`;

    await sendMessage(token, chatId, intro);
    await sendMessage(token, chatId, screen.text, screen.keyboard);

    return true;
  } catch (error) {
    const userMessage =
      error instanceof UpscaleApiError
        ? error.userMessage
        : "⚠️ Ошибка базы данных. Попробуйте позже.";

    if (!(error instanceof UpscaleApiError)) {
      console.error("Failed to bind UpScale key:", error);
    }

    await sendMessage(token, chatId, userMessage, {
      inline_keyboard: [
        [{ text: "❌ Отмена", callback_data: "accounts:cancel" }],
      ],
    });

    return true;
  }
}
