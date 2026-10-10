import { upsertBotUser, deleteBotState, getBotState } from "@/lib/models";
import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
  type InlineKeyboardMarkup,
} from "./api";
import { resolveAccess } from "./access";
import { handleTextCommand } from "./admin";
import {
  buildAccountsScreen,
  handleAccountsCallback,
  handleUpscaleKeyInput,
  CALLBACK_ACCOUNTS_PREFIX,
} from "./accounts";
import {
  buildTradersScreen,
  handleTradersCallback,
  CALLBACK_TRADERS_PREFIX,
} from "./traders";
import {
  buildSubscriptionsScreen,
  handleSubscriptionCoefficientInput,
  handleSubscriptionsCallback,
  CALLBACK_SUBSCRIPTIONS_PREFIX,
} from "./subscriptions";
import {
  buildDrawdownScreen,
  handleDrawdownCallback,
  handleDrawdownLimitInput,
  CALLBACK_DRAWDOWN_PREFIX,
} from "./drawdown";
import {
  buildMyStatsScreen,
  handleMyStatsCallback,
  CALLBACK_MY_STATS_PREFIX,
} from "./my-stats";
import {
  ACCESS_DENIED_TEXTS,
  buildMainMenu,
  buildSectionScreen,
  CALLBACK_MAIN_MENU,
  SECTION_CALLBACK_PREFIX,
} from "./menu";

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

export async function handleTelegramUpdate(
  update: TelegramUpdate
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set; skipping update handling");
    return;
  }

  if (update.message?.text) {
    if (update.message.text.startsWith("/start")) {
      await handleStart(token, update.message);
    } else {
      await handleText(token, update.message, update.message.text);
    }
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(token, update.callback_query);
  }
}

async function handleText(
  token: string,
  message: NonNullable<TelegramUpdate["message"]>,
  text: string
): Promise<void> {
  const from = message.from;

  if (!from) return;

  const telegramId = String(from.id);
  const access = await resolveAccess(telegramId, from.username);

  if (!access.allowed) {
    await sendMessage(
      token,
      message.chat.id,
      ACCESS_DENIED_TEXTS[access.reason ?? "unknown"]
    );
    return;
  }

  if (text.startsWith("/")) {
    const state = await getBotState(telegramId);

    if (state?.awaiting) {
      try {
        await deleteBotState(telegramId);
      } catch (error) {
        console.error("Failed to clear bot state:", error);
      }
    }
  } else {
    const state = await getBotState(telegramId);

    if (state?.awaiting) {
      const handledDrawdown = await handleDrawdownLimitInput(
        token,
        message.chat.id,
        telegramId,
        state.awaiting,
        text
      );

      if (handledDrawdown) {
        return;
      }

      const handledSubscription = await handleSubscriptionCoefficientInput(
        token,
        message.chat.id,
        telegramId,
        state.awaiting,
        text
      );

      if (!handledSubscription) {
        await handleUpscaleKeyInput(
          token,
          message.chat.id,
          telegramId,
          state.awaiting,
          text
        );
      }
      return;
    }
  }

  await handleTextCommand(token, message.chat.id, text, access.role!);
}

async function handleStart(
  token: string,
  message: NonNullable<TelegramUpdate["message"]>
): Promise<void> {
  const from = message.from;

  if (!from) return;

  const telegramId = String(from.id);
  const username = from.username;

  const access = await resolveAccess(telegramId, username);

  if (!access.allowed) {
    await sendMessage(
      token,
      message.chat.id,
      ACCESS_DENIED_TEXTS[access.reason ?? "unknown"]
    );
    return;
  }

  if (username && access.user?.username !== username) {
    try {
      await upsertBotUser(telegramId, { username, role: access.role! });
    } catch (error) {
      console.error("Failed to update username:", error);
    }
  }

  const menu = buildMainMenu(access.role!, username);
  await sendMessage(token, message.chat.id, menu.text, menu.keyboard);
}

async function handleCallbackQuery(
  token: string,
  callbackQuery: NonNullable<TelegramUpdate["callback_query"]>
): Promise<void> {
  const from = callbackQuery.from;
  const telegramId = String(from.id);
  const data = callbackQuery.data ?? "";
  const message = callbackQuery.message;

  const access = await resolveAccess(telegramId, from.username);

  if (!access.allowed) {
    await answerCallbackQuery(token, callbackQuery.id);
    if (message) {
      await sendMessage(
        token,
        message.chat.id,
        ACCESS_DENIED_TEXTS[access.reason ?? "unknown"]
      );
    }
    return;
  }

  if (data === CALLBACK_MAIN_MENU) {
    const menu = buildMainMenu(access.role!, from.username);
    if (message) {
      await editMessageText(
        token,
        message.chat.id,
        message.message_id,
        menu.text,
        menu.keyboard
      );
    } else {
      await sendMessage(token, from.id, menu.text, menu.keyboard);
    }
    await answerCallbackQuery(token, callbackQuery.id);
    return;
  }

  if (data.startsWith(CALLBACK_ACCOUNTS_PREFIX)) {
    const chatId = message?.chat.id ?? from.id;
    await handleAccountsCallback(
      token,
      chatId,
      telegramId,
      message?.message_id,
      callbackQuery.id,
      data
    );
    return;
  }

  if (data.startsWith(CALLBACK_TRADERS_PREFIX)) {
    const chatId = message?.chat.id ?? from.id;
    await handleTradersCallback(
      token,
      chatId,
      telegramId,
      message?.message_id,
      callbackQuery.id,
      data
    );
    return;
  }

  if (data.startsWith(CALLBACK_SUBSCRIPTIONS_PREFIX)) {
    const chatId = message?.chat.id ?? from.id;
    await handleSubscriptionsCallback(
      token,
      chatId,
      telegramId,
      message?.message_id,
      callbackQuery.id,
      data
    );
    return;
  }

  if (data.startsWith(CALLBACK_DRAWDOWN_PREFIX)) {
    const chatId = message?.chat.id ?? from.id;
    await handleDrawdownCallback(
      token,
      chatId,
      telegramId,
      message?.message_id,
      callbackQuery.id,
      data
    );
    return;
  }

  if (data.startsWith(CALLBACK_MY_STATS_PREFIX)) {
    const chatId = message?.chat.id ?? from.id;
    await handleMyStatsCallback(
      token,
      chatId,
      telegramId,
      message?.message_id,
      callbackQuery.id,
      data
    );
    return;
  }

  if (data.startsWith(SECTION_CALLBACK_PREFIX)) {
    const sectionId = data.slice(SECTION_CALLBACK_PREFIX.length);

    if (sectionId === "accounts") {
      try {
        const screen = await buildAccountsScreen(telegramId);

        if (message) {
          await editMessageText(
            token,
            message.chat.id,
            message.message_id,
            screen.text,
            screen.keyboard
          );
        } else {
          await sendMessage(token, from.id, screen.text, screen.keyboard);
        }
      } catch (error) {
        console.error("Failed to render accounts section:", error);
        await sendMessage(
          token,
          message?.chat.id ?? from.id,
          "⚠️ Ошибка базы данных. Попробуйте позже."
        );
      }

      await answerCallbackQuery(token, callbackQuery.id);
      return;
    }

    if (sectionId === "subscriptions") {
      try {
        const screen = await buildSubscriptionsScreen(telegramId);

        if (message) {
          await editMessageText(
            token,
            message.chat.id,
            message.message_id,
            screen.text,
            screen.keyboard
          );
        } else {
          await sendMessage(token, from.id, screen.text, screen.keyboard);
        }
      } catch (error) {
        console.error("Failed to render subscriptions section:", error);
        await sendMessage(
          token,
          message?.chat.id ?? from.id,
          "⚠️ Ошибка базы данных. Попробуйте позже."
        );
      }

      await answerCallbackQuery(token, callbackQuery.id);
      return;
    }

    if (sectionId === "traders") {
      try {
        const screen = await buildTradersScreen();

        if (message) {
          await editMessageText(
            token,
            message.chat.id,
            message.message_id,
            screen.text,
            screen.keyboard
          );
        } else {
          await sendMessage(token, from.id, screen.text, screen.keyboard);
        }
      } catch (error) {
        console.error("Failed to render traders section:", error);
        await sendMessage(
          token,
          message?.chat.id ?? from.id,
          "⚠️ Ошибка базы данных. Попробуйте позже."
        );
      }

      await answerCallbackQuery(token, callbackQuery.id);
      return;
    }

    if (sectionId === "drawdown") {
      try {
        const screen = await buildDrawdownScreen(telegramId);

        if (message) {
          await editMessageText(
            token,
            message.chat.id,
            message.message_id,
            screen.text,
            screen.keyboard
          );
        } else {
          await sendMessage(token, from.id, screen.text, screen.keyboard);
        }
      } catch (error) {
        console.error("Failed to render drawdown section:", error);
        await sendMessage(
          token,
          message?.chat.id ?? from.id,
          "⚠️ Ошибка базы данных. Попробуйте позже."
        );
      }

      await answerCallbackQuery(token, callbackQuery.id);
      return;
    }

    if (sectionId === "my-stats") {
      try {
        const screen = await buildMyStatsScreen(telegramId);

        if (message) {
          await editMessageText(
            token,
            message.chat.id,
            message.message_id,
            screen.text,
            screen.keyboard
          );
        } else {
          await sendMessage(token, from.id, screen.text, screen.keyboard);
        }
      } catch (error) {
        console.error("Failed to render my-stats section:", error);
        await sendMessage(
          token,
          message?.chat.id ?? from.id,
          "⚠️ Ошибка базы данных. Попробуйте позже."
        );
      }

      await answerCallbackQuery(token, callbackQuery.id);
      return;
    }

    const screen: { text: string; keyboard: InlineKeyboardMarkup } | null =
      buildSectionScreen(access.role!, sectionId);

    if (!screen) {
      await answerCallbackQuery(token, callbackQuery.id, "Неизвестный раздел");
      return;
    }

    if (message) {
      await editMessageText(
        token,
        message.chat.id,
        message.message_id,
        screen.text,
        screen.keyboard
      );
    } else {
      await sendMessage(token, from.id, screen.text, screen.keyboard);
    }
    await answerCallbackQuery(token, callbackQuery.id);
    return;
  }

  await answerCallbackQuery(token, callbackQuery.id, "Неизвестная команда");
}
