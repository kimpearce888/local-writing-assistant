// @vitest-environment jsdom
/**
 * Side-panel layout contract: the working area (Selected text / Custom
 * instruction / Result) must sit ABOVE the action menu, and the menu must
 * render as collapsible groups with only "Rewrite" expanded by default.
 * This guards against the panel regressing to the old 40-row action wall
 * that pushed the result out of view.
 *
 * Note: tests share one DOM (the module renders once on import) and run in
 * declaration order — the toggle test runs last because it mutates state.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

beforeAll(() => {
  // The side panel is an extension page; stub the chrome APIs it touches.
  (globalThis as any).chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async () => ({ ok: false, error: "stub" }),
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async () => {},
    },
  };
  // jsdom does not implement scrollIntoView.
  (HTMLElement.prototype as any).scrollIntoView = function (): void {};

  const html = fs.readFileSync(
    path.join(__dirname, "..", "extension", "sidepanel.html"),
    "utf8",
  );
  document.body.innerHTML = html;
});

const visibleActionItems = () =>
  [...document.querySelectorAll<HTMLElement>(".action-item")].filter(
    (b) => !b.closest(".cat-actions.collapsed"),
  );

describe("side panel layout", () => {
  it("renders the working area above the action menu", async () => {
    await import("../extension/src/sidepanel/index");
    const main = document.querySelector("main")!;
    const ids = [...main.children].filter((el) => el.id).map((el) => el.id);
    expect(ids.indexOf("resultSection")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("resultSection")).toBeLessThan(ids.indexOf("actionMenu"));
  });

  it("renders four collapsible groups with only Rewrite expanded", async () => {
    await import("../extension/src/sidepanel/index");
    const cats = [...document.querySelectorAll<HTMLElement>(".action-cat")];
    expect(cats.length).toBe(4);
    expect(
      cats.map((c) => c.querySelector<HTMLElement>(".cat-title > span:last-child")!.textContent?.trim()),
    ).toEqual([
      "Rewrite",
      "Write",
      "Evaluate",
      "Adjust tone",
    ]);
    expect(
      cats.map((c) => c.querySelector<HTMLElement>(".cat-title")!.getAttribute("aria-expanded")),
    ).toEqual(["true", "false", "false", "false"]);

    expect(document.querySelectorAll(".action-item").length).toBe(37); // 16+2+3+16
    expect(visibleActionItems().length).toBe(16);
    expect(visibleActionItems()[0].textContent).toContain("Improve it");
  });

  it("keeps the e2e target (Improve it) visible in the default state", async () => {
    // The Playwright manual-flow spec clicks
    // #actionMenu .action-item:has-text("Improve it") without expanding
    // anything; the default-expanded Rewrite group must keep it reachable.
    const improve = visibleActionItems().find((b) => b.textContent?.includes("Improve it"));
    expect(improve).toBeDefined();
  });

  it("toggles groups open and closed", async () => {
    await import("../extension/src/sidepanel/index");
    const cats = [...document.querySelectorAll<HTMLElement>(".action-cat")];
    const writeHeader = cats[1].querySelector<HTMLElement>(".cat-title")!;
    const rewriteHeader = cats[0].querySelector<HTMLElement>(".cat-title")!;

    writeHeader.click();
    expect(writeHeader.getAttribute("aria-expanded")).toBe("true");

    rewriteHeader.click();
    expect(rewriteHeader.getAttribute("aria-expanded")).toBe("false");

    const visible = visibleActionItems();
    expect(visible.length).toBe(2); // only Write's two actions remain open
    expect(visible.map((b) => b.textContent)).toEqual([
      expect.stringContaining("Create a TL;DR"),
      expect.stringContaining("Turn bullets to prose"),
    ]);
  });
});
