import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleTelegramUpdate } from "@/lib/telegram/handler";

const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      chat: z.object({ id: z.number() }),
      from: z
        .object({
          id: z.number(),
          username: z.string().optional(),
        })
        .optional(),
      text: z.string().optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({
        id: z.number(),
        username: z.string().optional(),
      }),
      data: z.string().optional(),
      message: z
        .object({
          chat: z.object({ id: z.number() }),
          message_id: z.number(),
        })
        .optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN is not configured" },
      { status: 503 }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = telegramUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Некорректные данные", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    await handleTelegramUpdate(parsed.data);
  } catch (error) {
    console.error("Failed to handle Telegram update:", error);
  }

  return NextResponse.json({ ok: true });
}
