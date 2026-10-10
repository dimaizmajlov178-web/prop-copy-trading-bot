import type { BotRole } from "@/lib/models";
import type { InlineKeyboardMarkup } from "./api";

export interface MenuSection {
  id: string;
  title: string;
  description: string;
}

/** Callback-дата кнопки «в главное меню». */
export const CALLBACK_MAIN_MENU = "menu";
/** Префикс callback-дат кнопок разделов. */
export const SECTION_CALLBACK_PREFIX = "section:";

const ADMIN_SECTIONS: MenuSection[] = [
  {
    id: "access",
    title: "👥 Управление доступом",
    description: "",
  },
  {
    id: "admin-stats",
    title: "📊 Статистика сервиса",
    description:
      "Общая статистика по участникам, трейдерам и сделкам. Раздел в разработке.",
  },
];

const MEMBER_SECTIONS: MenuSection[] = [
  {
    id: "accounts",
    title: "💼 Мои счета",
    description:
      "Привязка API-ключей UpScale: основной счет (источник сделок) и дополнительные счета для копирования.",
  },
  {
    id: "traders",
    title: "📈 Активные трейдеры",
    description:
      "Список трейдеров-сигнальщиков сервиса и их статистика: сделки, винрейт, RR, время удержания.",
  },
  {
    id: "subscriptions",
    title: "🔗 Мои подписки",
    description:
      "Подписки на трейдеров: коэффициенты копирования, смена коэффициента и отписка.",
  },
  {
    id: "my-stats",
    title: "📊 Моя статистика",
    description:
      "История скопированных сделок: актив, направление, результат (PnL), время удержания.",
  },
  {
    id: "drawdown",
    title: "🛡 Лимит просадки",
    description:
      "Дневной лимит просадки для защиты счета: при достижении лимита копирование останавливается до конца дня.",
  },
];

const TRADER_SECTIONS: MenuSection[] = [
  {
    id: "signals",
    title: "📣 Мои сигналы",
    description:
      "Ваши сделки используются как сигналы для копирования. Раздел в разработке.",
  },
];

export function getMenuSections(role: BotRole): MenuSection[] {
  switch (role) {
    case "owner":
    case "admin":
      return [...ADMIN_SECTIONS, ...MEMBER_SECTIONS];
    case "trader":
      return [...TRADER_SECTIONS, ...MEMBER_SECTIONS];
    case "member":
      return MEMBER_SECTIONS;
  }
}

export function getSection(
  role: BotRole,
  sectionId: string
): MenuSection | null {
  return getMenuSections(role).find((s) => s.id === sectionId) ?? null;
}

export const ROLE_LABELS: Record<BotRole, string> = {
  owner: "Владелец",
  admin: "Админ",
  trader: "Трейдер-сигнальщик",
  member: "Участник",
};

export function buildMainMenu(
  role: BotRole,
  username?: string
): { text: string; keyboard: InlineKeyboardMarkup } {
  const sections = getMenuSections(role);
  const greeting = username ? `, ${username}` : "";

  const text = [
    `<b>Prop Copy Trading Bot</b>`,
    ``,
    `Привет${greeting}! Ваша роль: <b>${ROLE_LABELS[role]}</b>.`,
    `Выберите раздел:`,
  ].join("\n");

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      ...sections.map((section) => [
        {
          text: section.title,
          callback_data: `${SECTION_CALLBACK_PREFIX}${section.id}`,
        },
      ]),
    ],
  };

  return { text, keyboard };
}

export function buildSectionScreen(
  role: BotRole,
  sectionId: string
): { text: string; keyboard: InlineKeyboardMarkup } | null {
  const section = getSection(role, sectionId);

  if (!section) return null;

  const text =
    section.id === "access"
      ? buildAccessScreenText(role)
      : [`<b>${section.title}</b>`, ``, section.description].join("\n");

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: "⬅️ В главное меню", callback_data: CALLBACK_MAIN_MENU }],
      ],
    },
  };
}

function buildAccessScreenText(role: BotRole): string {
  const lines = [
    `<b>👥 Управление доступом</b>`,
    ``,
    `<b>Команды:</b>`,
    `<code>/add &lt;Telegram ID&gt; &lt;дней&gt; &lt;тег&gt;</code> — добавить участника и задать срок доступа`,
  ];

  if (role === "owner") {
    lines.push(
      `<code>/admin &lt;Telegram ID&gt;</code> — назначить админа`,
      `<code>/unadmin &lt;Telegram ID&gt;</code> — снять админа`
    );
  }

  lines.push(
    `<code>/trader &lt;Telegram ID&gt;</code> — назначить трейдером-сигнальщиком`,
    `<code>/untrader &lt;Telegram ID&gt;</code> — снять роль трейдера`
  );

  if (role === "owner") {
    lines.push(
      `<code>/users</code> — список пользователей с ролями и сроками доступа`
    );
  }

  return lines.join("\n");
}

export function buildCommandsHint(role: BotRole): string {
  const isManager = role === "owner" || role === "admin";

  if (!isManager) {
    return "Используйте меню для навигации по разделам.";
  }

  return [
    `<b>Команды:</b>`,
    `<code>/add &lt;Telegram ID&gt; &lt;дней&gt; &lt;тег&gt;</code> — добавить участника`,
    ...(role === "owner"
      ? [
          `<code>/admin &lt;Telegram ID&gt;</code> — назначить админа`,
          `<code>/unadmin &lt;Telegram ID&gt;</code> — снять админа`,
        ]
      : []),
    `<code>/trader &lt;Telegram ID&gt;</code> — назначить трейдером`,
    `<code>/untrader &lt;Telegram ID&gt;</code> — снять трейдера`,
    ...(role === "owner" ? [`<code>/users</code> — список пользователей`] : []),
  ].join("\n");
}

export const ACCESS_DENIED_TEXTS = {
  unknown: [
    "🚫 <b>Доступ отсутствует</b>",
    "",
    "Вы не добавлены в сервис копитрейдинга.",
    "Обратитесь к администратору, чтобы получить доступ.",
  ].join("\n"),
  expired: [
    "⏰ <b>Срок доступа истёк</b>",
    "",
    "Ваша подписка на сервис завершена.",
    "Чтобы продолжить, свяжитесь с администратором.",
  ].join("\n"),
};
