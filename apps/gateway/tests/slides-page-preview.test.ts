import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlidesLayouterAgentTools } from "../src/modules/subagents/slides-agent-tools.js";
import {
  dropPagePreview,
  getPagePreview,
  registerPagePreview,
  wasPagePreviewed,
} from "../src/modules/slides-layout/page-preview-context.js";
import type { LayoutContract } from "../src/modules/slides-layout/tree/layout-contract.js";

const TOKEN = "test:preview";

function register(): void {
  registerPagePreview(TOKEN, {
    contract: {} as LayoutContract,
    imageArs: new Map(),
    pageCount: 2,
    previewed: new Set(),
    render: vi.fn(async () => ({
      defects: [],
      png: Buffer.from([1, 2, 3]),
      visual: { status: "issues" as const, issues: [{ item: "flat_background" as const, where: "整页", severity: "major" as const }] },
    })),
  });
}

afterEach(() => dropPagePreview(TOKEN));

describe("slides_page_preview tool", () => {
  it("renders a temporary preview and records the previewed page", async () => {
    register();
    const tool = createSlidesLayouterAgentTools().find((item) => item.name === "slides_page_preview")!;
    const result = await tool.execute({} as never, { deckToken: TOKEN, pageIndex: 1, tree: { version: 2 } });
    const payload = JSON.parse(result.content);
    expect(payload.pageIndex).toBe(1);
    expect(payload.visual.issues[0].item).toBe("flat_background");
    expect(wasPagePreviewed(TOKEN, 1)).toBe(true);
    expect(getPagePreview(TOKEN)?.previewed.has(1)).toBe(true);
  });

  it("returns skipped when no preview renderer is registered", async () => {
    const tool = createSlidesLayouterAgentTools().find((item) => item.name === "slides_page_preview")!;
    const result = await tool.execute({} as never, { deckToken: "missing", pageIndex: 0, tree: {} });
    expect(JSON.parse(result.content).skipped).toBe(true);
  });
});
