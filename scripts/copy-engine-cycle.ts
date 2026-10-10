import "dotenv/config";
import { runCopyEngineCycle } from "../lib/copy/engine";

/**
 * Разовый цикл движка копирования — для ручного запуска или внешнего cron.
 */
const stats = await runCopyEngineCycle();

console.log("Цикл копирования завершен:");
console.log(`  Трейдеров обработано: ${stats.tradersProcessed}`);
console.log(`  Открыто копий: ${stats.copiesOpened}`);
console.log(`  Увеличено копий: ${stats.copiesIncreased}`);
console.log(`  Закрыто копий: ${stats.copiesClosed}`);
console.log(`  Сбоев: ${stats.failures}`);

if (stats.errors.length > 0) {
  console.log("Ошибки:");
  for (const error of stats.errors) {
    console.log(`  - ${error}`);
  }
}
