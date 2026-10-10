import type { BotRole, BotUser } from "@/lib/models";
import { getBotUser, listBotUsers, upsertBotUser } from "@/lib/models";
import { OWNER_TELEGRAM_ID, addDaysUtc, remainingDaysUtc } from "./access";
import { sendMessage } from "./api";
import { ROLE_LABELS, buildCommandsHint, buildSectionScreen } from "./menu";
import {
  addArgsSchema,
  parseCommand,
  targetArgsSchema,
  type ParsedCommand,
} from "./commands";

const MANAGE_ROLES: BotRole[] = ["owner", "admin"];

const DB_ERROR_TEXT = "⚠️ Ошибка базы данных. Попробуйте позже.";

const ADD_USAGE_TEXT = [
  "Использование: <code>/add &lt;Telegram ID&gt; &lt;дней&gt; &lt;тег&gt;</code>",
  "",
  "Пример: <code>/add 123456789 30 Иван</code>",
  "Тег может содержать пробелы.",
].join("\n");

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatUserLine(user: BotUser): string {
  const name = user.tag ?? user.username ?? user.telegramId;
  const username = user.username && user.tag ? ` (@${user.username})` : "";
  const remaining = remainingDaysUtc(user.accessExpiresAt);

  let access: string;
  if (remaining === null) {
    access = "бессрочно";
  } else if (remaining > 0) {
    access = `осталось ${remaining} дн. (до ${user.accessExpiresAt})`;
  } else if (remaining === 0) {
    access = `истекает сегодня (до ${user.accessExpiresAt})`;
  } else {
    access = `истёк (${user.accessExpiresAt})`;
  }

  return `• <b>${escapeHtml(name)}</b>${escapeHtml(username)} — ${
    ROLE_LABELS[user.role]
  }, ${access}`;
}

function formatZodIssues(issues: { message: string }[]): string {
  return issues.map((issue) => `• ${issue.message}`).join("\n");
}

function targetUsageText(commandName: string): string {
  return `Использование: <code>/${commandName} &lt;Telegram ID&gt;</code>`;
}

async function resolveTarget(
  token: string,
  chatId: number,
  commandName: string,
  args: string[]
): Promise<BotUser | null> {
  const parsed = targetArgsSchema.safeParse({ telegramId: args[0] });

  if (!parsed.success) {
    await sendMessage(
      token,
      chatId,
      [
        targetUsageText(commandName),
        "",
        formatZodIssues(parsed.error.issues),
      ].join("\n")
    );
    return null;
  }

  if (parsed.data.telegramId === OWNER_TELEGRAM_ID) {
    await sendMessage(token, chatId, "Нельзя изменять роль владельца.");
    return null;
  }

  const target = await getBotUser(parsed.data.telegramId);

  if (!target) {
    await sendMessage(
      token,
      chatId,
      "Пользователь не найден. Сначала добавьте его командой /add."
    );
    return null;
  }

  return target;
}

async function notifyUser(
  token: string,
  telegramId: string,
  text: string
): Promise<void> {
  await sendMessage(token, Number(telegramId), text);
}

async function handleAdd(
  token: string,
  chatId: number,
  args: string[]
): Promise<void> {
  const parsed = addArgsSchema.safeParse({
    telegramId: args[0],
    days: args[1],
    tag: args.slice(2).join(" "),
  });

  if (!parsed.success) {
    await sendMessage(
      token,
      chatId,
      [ADD_USAGE_TEXT, "", formatZodIssues(parsed.error.issues)].join("\n")
    );
    return;
  }

  const { telegramId, days, tag } = parsed.data;

  if (telegramId === OWNER_TELEGRAM_ID) {
    await sendMessage(token, chatId, "Нельзя изменять роль владельца.");
    return;
  }

  const expiresAt = addDaysUtc(days);
  const user = await upsertBotUser(telegramId, {
    tag,
    role: "member",
    accessExpiresAt: expiresAt,
  });

  await notifyUser(
    token,
    telegramId,
    [
      "✅ <b>Вы добавлены в сервис копитрейдинга</b>",
      "",
      `Тег: <b>${escapeHtml(user.tag ?? tag)}</b>`,
      `Срок доступа: до <b>${user.accessExpiresAt}</b> (включительно)`,
      "",
      "Отправьте /start, чтобы открыть меню.",
    ].join("\n")
  );

  await sendMessage(
    token,
    chatId,
    `✅ Пользователь ${escapeHtml(tag)} (<code>${escapeHtml(telegramId)}</code>) добавлен. Доступ до ${expiresAt}.`
  );
}

async function handleSetAdmin(
  token: string,
  chatId: number,
  args: string[],
  makeAdmin: boolean
): Promise<void> {
  const commandName = makeAdmin ? "admin" : "unadmin";
  const target = await resolveTarget(token, chatId, commandName, args);

  if (!target) return;

  if (makeAdmin) {
    if (target.role === "admin") {
      await sendMessage(token, chatId, "Пользователь уже является админом.");
      return;
    }
    await upsertBotUser(target.telegramId, { role: "admin" });
    await notifyUser(
      token,
      target.telegramId,
      "🛡 Вам назначена роль <b>админа</b>. Теперь вы можете добавлять участников командой /add."
    );
    await sendMessage(
      token,
      chatId,
      `✅ ${escapeHtml(target.tag ?? target.telegramId)} назначен админом.`
    );
    return;
  }

  if (target.role !== "admin") {
    await sendMessage(token, chatId, "Пользователь не является админом.");
    return;
  }

  await upsertBotUser(target.telegramId, { role: "member" });
  await notifyUser(
    token,
    target.telegramId,
    "С вас снята роль админа. Ваша роль теперь: <b>участник</b>."
  );
  await sendMessage(
    token,
    chatId,
    `✅ С ${escapeHtml(target.tag ?? target.telegramId)} снята роль админа.`
  );
}

async function handleSetTrader(
  token: string,
  chatId: number,
  args: string[],
  makeTrader: boolean
): Promise<void> {
  const commandName = makeTrader ? "trader" : "untrader";
  const target = await resolveTarget(token, chatId, commandName, args);

  if (!target) return;

  if (makeTrader) {
    if (target.role === "trader") {
      await sendMessage(
        token,
        chatId,
        "Пользователь уже является трейдером-сигнальщиком."
      );
      return;
    }
    if (target.role === "admin") {
      await sendMessage(
        token,
        chatId,
        "Нельзя назначить трейдером админа. Сначала снимите роль админа командой /unadmin."
      );
      return;
    }
    await upsertBotUser(target.telegramId, { role: "trader" });
    await notifyUser(
      token,
      target.telegramId,
      "📣 Вам назначена роль <b>трейдера-сигнальщика</b>. Ваши сделки будут использоваться как сигналы."
    );
    await sendMessage(
      token,
      chatId,
      `✅ ${escapeHtml(target.tag ?? target.telegramId)} назначен трейдером-сигнальщиком.`
    );
    return;
  }

  if (target.role !== "trader") {
    await sendMessage(
      token,
      chatId,
      "Пользователь не является трейдером-сигнальщиком."
    );
    return;
  }

  await upsertBotUser(target.telegramId, { role: "member" });
  await notifyUser(
    token,
    target.telegramId,
    "С вас снята роль трейдера-сигнальщика. Ваша роль теперь: <b>участник</b>."
  );
  await sendMessage(
    token,
    chatId,
    `✅ С ${escapeHtml(target.tag ?? target.telegramId)} снята роль трейдера-сигнальщика.`
  );
}

async function handleUsers(token: string, chatId: number): Promise<void> {
  const users = await listBotUsers();
  users.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  );

  const text = [
    "<b>👥 Пользователи сервиса</b>",
    "",
    users.length > 0
      ? users.map(formatUserLine).join("\n")
      : "Пока нет добавленных пользователей.",
  ].join("\n");

  await sendMessage(token, chatId, text);
}

export async function handleTextCommand(
  token: string,
  chatId: number,
  text: string,
  role: BotRole
): Promise<void> {
  const command: ParsedCommand | null = parseCommand(text);

  if (!command) {
    await sendMessage(token, chatId, buildCommandsHint(role));
    return;
  }

  const canManage = MANAGE_ROLES.includes(role);

  try {
    switch (command.name) {
      case "/help": {
        await sendMessage(token, chatId, buildCommandsHint(role));
        return;
      }
      case "/access": {
        const screen = buildSectionScreen(role, "access");
        if (screen) {
          await sendMessage(token, chatId, screen.text, screen.keyboard);
        }
        return;
      }
      case "/add": {
        if (!canManage) {
          await sendMessage(
            token,
            chatId,
            "Добавлять пользователей могут только владелец и админы."
          );
          return;
        }
        await handleAdd(token, chatId, command.args);
        return;
      }
      case "/admin":
      case "/unadmin": {
        if (role !== "owner") {
          await sendMessage(
            token,
            chatId,
            "Назначать и снимать админов может только владелец."
          );
          return;
        }
        await handleSetAdmin(
          token,
          chatId,
          command.args,
          command.name === "/admin"
        );
        return;
      }
      case "/trader":
      case "/untrader": {
        if (!canManage) {
          await sendMessage(
            token,
            chatId,
            "Назначать трейдеров могут только владелец и админы."
          );
          return;
        }
        await handleSetTrader(
          token,
          chatId,
          command.args,
          command.name === "/trader"
        );
        return;
      }
      case "/users": {
        if (role !== "owner") {
          await sendMessage(
            token,
            chatId,
            "Список пользователей доступен только владельцу."
          );
          return;
        }
        await handleUsers(token, chatId);
        return;
      }
      default: {
        await sendMessage(
          token,
          chatId,
          `Неизвестная команда <code>${escapeHtml(command.name)}</code>.\n\n${buildCommandsHint(role)}`
        );
      }
    }
  } catch (error) {
    console.error(`Command ${command.name} failed:`, error);
    await sendMessage(token, chatId, DB_ERROR_TEXT);
  }
}
