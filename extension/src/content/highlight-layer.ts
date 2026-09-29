/**
 * Highlight layer.
 *
 * For <textarea> / <input> we cannot directly underline substrings inside
 * the field — the browser owns the rendering. Instead, we render a
 * positioned overlay above the field, sized to the element rect, that
 * draws small underline markers at the right pixel positions.
 *
 * For contenteditable we use a much lighter approach: a single floating
 * marker is positioned at the caret rect for the highest-priority issue
 * near the cursor. (We do NOT inject <span> wrappers into the user's
 * contenteditable — that's the classic way to break rich editors.)
 *
 * The overlay uses `position: fixed` because `getBoundingClientRect()`
 * returns viewport-relative coordinates. With `position: absolute` the
 * overlay would be anchored at the document origin and drift by
 * `scrollY` pixels every time the page is scrolled, putting markers in
 * the wrong place on any scrolled page (Gmail, Slack, Notion, …).
 *
 * Per spec section 11: never replace the editor's DOM, never destroy
 * undo/redo, never trigger mutation loops.
 */

import { EditorAdapter } from "./adapters/adapter";
import { Issue } from "../shared/types";

const HIGHLIGHT_ATTR = "data-lwa-highlight";

interface MarkerEl {
  el: HTMLDivElement;
  issueId: string;
}

export class HighlightLayer {
  private hostEl: HTMLElement;
  private markers: MarkerEl[] = [];
  private overlay: HTMLDivElement | null = null;
  private clickHandler: ((e: Event) => void) | null = null;
  private scrollResizeHandler: (() => void) | null = null;

  constructor(hostEl: HTMLElement) {
    this.hostEl = hostEl;
  }

  private ensureOverlay(): HTMLDivElement {
    if (this.overlay && this.overlay.isConnected) return this.overlay;
    const overlay = document.createElement("div");
    overlay.setAttribute(HIGHLIGHT_ATTR, "true");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483646",
      "left:0",
      "top:0",
      "width:0",
      "height:0",
    ].join(";");
    document.documentElement.appendChild(overlay);
    this.overlay = overlay;
    return overlay;
  }

  /** Position the overlay so it covers the editor's rect.
   *  Called once per render and again on every scroll/resize. */
  private syncOverlayPosition() {
    const overlay = this.ensureOverlay();
    const rect = this.hostEl.getBoundingClientRect();
    overlay.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  }

  /** Render markers for `issues` relative to `adapter`. */
  render(adapter: EditorAdapter, issues: Issue[]): void {
    this.clear();
    if (issues.length === 0) return;
    this.syncOverlayPosition();
    const rect = this.hostEl.getBoundingClientRect();
    // Sort by priority: high confidence first.
    const sorted = [...issues].sort((a, b) => b.confidence - a.confidence);
    const max = Math.min(sorted.length, 12);
    for (let i = 0; i < max; i++) {
      const issue = sorted[i];
      const caret = adapter.getCaretRect(issue.start);
      if (!caret) continue;
      const marker = document.createElement("div");
      marker.setAttribute(HIGHLIGHT_ATTR, "marker");
      marker.setAttribute("data-issue-id", issue.id);
      marker.setAttribute("data-category", issue.category);
      marker.setAttribute("role", "button");
      marker.setAttribute("tabindex", "0");
      marker.setAttribute(
        "aria-label",
        `${issue.category} issue: ${issue.explanation}`,
      );
      const width = Math.max(
        8,
        caret.width || Math.max(8, issue.end - issue.start) * 8,
      );
      marker.style.cssText = [
        "position:absolute",
        `left:${caret.left - rect.left}px`,
        `top:${caret.bottom - rect.top - 2}px`,
        `width:${width}px`,
        "height:3px",
        "border-radius:2px",
        "pointer-events:auto",
        "cursor:pointer",
        categoryColor(issue.category),
      ].join(";");
      // Keyboard accessibility — activate on Enter / Space.
      marker.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          marker.click();
        }
      });
      this.markers.push({ el: marker, issueId: issue.id });
      this.ensureOverlay().appendChild(marker);
    }
    this.attachScrollResizeListener();
  }

  /** Attach (once) a scroll + resize listener that re-syncs the overlay
   *  position so markers stay glued to the editor when the page scrolls
   *  or the viewport changes. Without this, any layout shift would leave
   *  markers floating at stale coordinates. */
  private attachScrollResizeListener(): void {
    if (this.scrollResizeHandler) return;
    const handler = (): void => this.syncOverlayPosition();
    this.scrollResizeHandler = handler;
    // capture:true so we catch scroll events from scrollable inner
    // containers (very common in Gmail / Slack / Notion) before they
    // bubble. passive:true so we never block scrolling.
    window.addEventListener("scroll", handler, { capture: true, passive: true });
    window.addEventListener("resize", handler, { passive: true });
  }

  clear(): void {
    for (const m of this.markers) {
      m.el.remove();
    }
    this.markers = [];
  }

  dispose(): void {
    this.clear();
    if (this.clickHandler) {
      this.overlay?.removeEventListener("click", this.clickHandler);
      this.clickHandler = null;
    }
    if (this.scrollResizeHandler) {
      window.removeEventListener("scroll", this.scrollResizeHandler, { capture: true });
      window.removeEventListener("resize", this.scrollResizeHandler);
      this.scrollResizeHandler = null;
    }
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  /** Attach a click handler for issue markers. Returns an unsubscribe
   *  function — the caller MUST capture it and call it before attaching
   *  a new handler; otherwise every re-analysis would stack another
   *  listener on the overlay and a single click would fire the
   *  callback N times. */
  onClick(cb: (issueId: string) => void): () => void {
    const overlay = this.ensureOverlay();
    // If a previous handler is attached, remove it first.
    if (this.clickHandler) {
      overlay.removeEventListener("click", this.clickHandler);
    }
    const handler = (e: Event) => {
      const target = e.target as HTMLElement;
      const id = target?.getAttribute("data-issue-id");
      if (id) cb(id);
    };
    this.clickHandler = handler;
    overlay.addEventListener("click", handler);
    return () => {
      overlay.removeEventListener("click", handler);
      if (this.clickHandler === handler) this.clickHandler = null;
    };
  }
}

function categoryColor(category: string): string {
  switch (category) {
    case "spelling":
      return "background:#d33b3b";
    case "grammar":
      return "background:#e09b1a";
    case "punctuation":
      return "background:#7a4dd6";
    case "clarity":
      return "background:#1c8ad6";
    case "word_choice":
      return "background:#1f9d6b";
    case "style":
      return "background:#8a8f98";
    default:
      return "background:#8a8f98";
  }
}
