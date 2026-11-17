import { describe, expect, it } from "vitest";

import { friendlyRunError } from "../src/index.js";

describe("friendlyRunError", () => {
  it("上游 404 model_not_found 的原始 JSON 串翻成可读提示", () => {
    const raw = '404: {"message":"Model not exist.","type":"invalid_request_error","param":"","code":"model_not_found"}';
    expect(friendlyRunError(raw)).toContain("模型在服务端不可用");
    expect(friendlyRunError(raw)).not.toContain("Model not exist");
    expect(friendlyRunError('404: {"code":"model_not_found"}')).toContain("模型在服务端不可用");
  });

  it("未识别的错误保持原文", () => {
    expect(friendlyRunError("HTTP 502 upstream error")).toBe("HTTP 502 upstream error");
    expect(friendlyRunError("")).toBe("");
  });

  it("中转 503 ai_relay_not_ready 的原始 JSON 串翻成可读提示", () => {
    const raw = '503: {"message":"AI relay session is not active","type":"ai_relay_not_ready","code":"ai_relay_not_ready"}';
    expect(friendlyRunError(raw)).toContain("AI 模型服务暂时不可用");
    expect(friendlyRunError(raw)).not.toContain("ai_relay_not_ready");
    expect(friendlyRunError(raw)).not.toContain("503:");
  });

  it("中转 402 额度耗尽翻成充值指引", () => {
    const raw = '402: {"error":"ai_quota_exhausted","message":"insufficient_user_quota"}';
    expect(friendlyRunError(raw)).toContain("额度不足");
    expect(friendlyRunError(raw)).toContain("设置");
    // 顺序敏感：额度文本里夹带 503/超时字样时仍按额度翻译，不落网络故障文案。
    expect(friendlyRunError('insufficient quota (503 service unavailable)')).toContain("额度不足");
    expect(friendlyRunError('insufficient quota (503 service unavailable)')).not.toContain("连接模型服务失败");
  });
});
