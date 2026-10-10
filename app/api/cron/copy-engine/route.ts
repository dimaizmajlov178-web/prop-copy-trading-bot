import { NextRequest, NextResponse } from "next/server";
import { runCopyEngineCycle } from "@/lib/copy/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * HTTP-триггер одного цикла автокопирования (для внешнего планировщика).
 * Если задан CRON_SECRET, запрос должен передать его в заголовке
 * x-cron-secret или параметре ?secret=.
 */
async function handle(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;

  if (secret) {
    const provided =
      request.headers.get("x-cron-secret") ??
      request.nextUrl.searchParams.get("secret");

    if (provided !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const stats = await runCopyEngineCycle();

  return NextResponse.json({ ok: true, ...stats });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
