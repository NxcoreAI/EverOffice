/**
 * 当前 deck 的风格卡上下文：slides_draft 编排在派发 builder 时按 Room 存入，
 * set_page 展开预设时读取——模型不必每次调用携带 styleParams。
 * 网关进程内有效；重启后丢失则回落缺省主题（可接受的降级）。
 */

import type { StyleParamsInput } from "./theme.js";

const activeByRoom = new Map<string, StyleParamsInput>();

export function setActiveDeckStyle(roomId: string, styleParams: unknown): void {
  if (typeof styleParams === "object" && styleParams !== null) {
    activeByRoom.set(roomId, styleParams as StyleParamsInput);
  }
}

export function getActiveDeckStyle(roomId: string): StyleParamsInput | undefined {
  return activeByRoom.get(roomId);
}
