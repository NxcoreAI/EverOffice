import { createHash } from "node:crypto";
// 时区换算已迁到 infrastructure/time（日历调度器等存活模块共用）：
// 这里再导出，diary 内部调用点无需改动，Phase 2 删除 diary 时一并消失。
export { dateInTimezone, localDateTime, zonedTimeToUtc } from "../../infrastructure/time/zone-time.js";

export function iso(date: Date): string { return date.toISOString(); }
export function dateOnly(date: Date): string { return date.toISOString().slice(0, 10); }
export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function clampDate(value: Date, minimum: Date, maximum: Date): Date {
  return new Date(Math.min(maximum.getTime(), Math.max(minimum.getTime(), value.getTime())));
}
