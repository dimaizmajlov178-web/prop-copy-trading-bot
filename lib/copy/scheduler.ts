import { runCopyEngineCycle } from "./engine";
import { runDrawdownCheckCycle } from "./drawdown";

const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 3_000;

const globalForScheduler = globalThis as unknown as {
  _copyEngineTimer: NodeJS.Timeout | undefined;
};

/**
 * Запускает периодический цикл автокопирования внутри процесса сервера.
 * Повторный вызов безопасен: таймер создается один раз.
 */
export function startCopyEngineScheduler(): void {
  if (globalForScheduler._copyEngineTimer) return;

  if (process.env.COPY_ENGINE_DISABLED === "true") return;

  const parsed = Number(process.env.COPY_ENGINE_INTERVAL_MS);
  const interval =
    Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS
      ? parsed
      : DEFAULT_INTERVAL_MS;

  const tick = (): void => {
    runDrawdownCheckCycle().catch((error) => {
      console.error("Drawdown check cycle failed:", error);
    });
    runCopyEngineCycle().catch((error) => {
      console.error("Copy engine cycle failed:", error);
    });
  };

  const timer = setInterval(tick, interval);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  globalForScheduler._copyEngineTimer = timer;
  console.info(`Copy engine scheduler started (interval: ${interval} ms)`);
}
