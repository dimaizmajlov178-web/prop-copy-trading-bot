/**
 * Точка входа сервера Next.js: запускает планировщик движка копирования
 * в nodejs-рантайме.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.COPY_ENGINE_DISABLED === "true") return;

  const { startCopyEngineScheduler } = await import("./lib/copy/scheduler");
  startCopyEngineScheduler();
}
