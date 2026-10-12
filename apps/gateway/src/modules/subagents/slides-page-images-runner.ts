/**
 * 正文配图后台生成循环：decision=generate 后立即返回，逐张生图在后台推进。
 * 每张结算只写会话库（单一事实来源），前端过目卡靠 HTTP 轮询刷新——工具调用
 * 结束后其 onUpdate 通道在渲染层会被终态丢弃，不能借用。
 *
 * 并发不变式：循环只给「尚无图」的页写 hash/materials；用户的打回/恢复/重生成
 * 只作用于「已有图」的页。两边写入前都重读会话合并（单线程异步下安全），
 * accept/skip 通过 abort 取消循环，会话被覆盖重建（id 变化）时循环自行退出。
 */

import {
  composePageImagePrompt,
  PAGE_IMAGES_DEADLINE_MS,
  PAGE_IMAGE_RETRY_DELAYS_MS,
} from "./slides-page-images.js";
import type {
  SlidesPageImagePage,
  SlidesPageImageSessionData,
} from "./slides-page-images-store.js";
import type { SlidesPageImagesStageDeps } from "./slides-page-images-stage.js";

interface RunningEntry {
  controller: AbortController;
  done: Promise<void>;
}

export class SlidesPageImageRunner {
  private readonly active = new Map<string, RunningEntry>();

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** 取消某会话的后台生成（accept/skip 落页、会话覆盖时调用）；进行中的那张作废。 */
  abort(sessionId: string): void {
    this.active.get(sessionId)?.controller.abort();
  }

  /** 测试与诊断用：等待某会话的后台循环结束。 */
  settle(sessionId: string): Promise<void> {
    return this.active.get(sessionId)?.done ?? Promise.resolve();
  }

  /** 启动（或续跑）某会话的逐张生成。返回循环结束的 Promise；生产侧 fire-and-forget。 */
  start(
    input: { roomId: string; draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
  ): Promise<void> {
    const existing = this.active.get(deps.sessionId);
    if (existing) return existing.done;
    const controller = new AbortController();
    const done = this.loop(input, deps, controller).finally(() => {
      this.active.delete(deps.sessionId);
    });
    this.active.set(deps.sessionId, { controller, done });
    return done;
  }

  private async loop(
    input: { roomId: string; draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
    controller: AbortController,
  ): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      if (controller.signal.aborted) return;
      if (Date.now() - startedAt > PAGE_IMAGES_DEADLINE_MS) return;
      const session = this.readSession(input, deps);
      if (!session) return;
      const next = session.pages.find((page) => !page.contentHash && !page.failed);
      if (!next) return;

      let hash: string;
      try {
        const result = await deps.images.generateImage({
          prompt: composePageImagePrompt(next.imagePrompt, session.stylePalette),
          retryDelaysMs: PAGE_IMAGE_RETRY_DELAYS_MS,
        });
        hash = result.contentHash;
      } catch (error) {
        // 无中转会话是环境性失败：整轮停止（用户可稍后重试或跳过）。
        if (error instanceof Error && error.message.includes("中转会话不可用")) return;
        this.patchPage(input, deps, next.pageIndex, { failed: true });
        continue;
      }
      if (controller.signal.aborted) return;
      this.patchPage(input, deps, next.pageIndex, {
        contentHash: hash,
        failed: false,
        rejected: false,
      });
    }
  }

  /** 会话有效性：存在、id 未变、仍在 review（accept/skip 落定或覆盖重建即停）。 */
  private readSession(
    input: { roomId: string; draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
  ): SlidesPageImageSessionData | null {
    const session = deps.sessions.byDraftId(input.roomId, input.draftDocumentId);
    if (!session || session.id !== deps.sessionId || session.stage !== "review") return null;
    return session;
  }

  /** 写前重读合并：只动目标页，保留期间用户对其他页的打回/重生成结果。 */
  private patchPage(
    input: { roomId: string; draftDocumentId: string },
    deps: SlidesPageImagesStageDeps & { sessionId: string },
    pageIndex: number,
    fields: Partial<Pick<SlidesPageImagePage, "contentHash" | "failed" | "rejected">>,
  ): void {
    const session = this.readSession(input, deps);
    if (!session) return;
    const pages = session.pages.map((page) =>
      page.pageIndex === pageIndex ? { ...page, ...fields } : page);
    const plan = structuredClone(session.plan);
    const planPages = Array.isArray(plan.pages) ? plan.pages : [];
    const target = planPages[pageIndex];
    if (target && typeof target === "object" && !Array.isArray(target)) {
      if (fields.contentHash) {
        const page = session.pages.find((item) => item.pageIndex === pageIndex);
        (target as Record<string, unknown>).materials = [{
          url: `everroom-material://${fields.contentHash}`,
          desc: `AI 生成配图：${(page?.imagePrompt ?? "").slice(0, 180)}`,
        }];
      } else {
        delete (target as Record<string, unknown>).materials;
      }
    }
    deps.sessions.patch(deps.sessionId, { pages, plan });
  }
}
