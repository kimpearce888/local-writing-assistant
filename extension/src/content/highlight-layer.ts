/**
 * Highlight layer.
 *
 * For <textarea> / <input> we cannot directly underline substrings inside
 * the field — the browser owns the rendering. Instead, we render a
 * positioned overlay absolutely above the field, sized to the element
 * rect, that draws small underline markers at the right pixel positions.
 *
 * For contenteditable we use a much lighter approach: a single floating
 * marker is positioned at the caret rect for the highest-priority issue
 * near the cursor. (We do NOT inject <span> wrappers into the user's
 * contenteditable — that's the classic way to break rich editors.)
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

  constructor(hostEl: HTMLElement) {
    this.hostEl = hostEl;
  }

  private ensureOverlay(): HTMLDivElement {
    if (this.overlay && this.overlay.isConnected) return this.overlay;
    const overlay = document.createElement("div");
    overlay.setAttribute(HIGHLIGHT_ATTR, "true");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = [
      "position:absolute",
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

  /** Position the overlay so it covers the editor's rect. */
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
      this.markers.push({ el: marker, issueId: issue.id });
      this.ensureOverlay().appendChild(marker);
    }
  }

  clear(): void {
    for (const m of this.markers) {
      m.el.remove();
    }
    this.markers = [];
  }

  dispose(): void {
    this.clear();
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  /** Attach a click handler for issue markers. */
  onClick(cb: (issueId: string) => void): () => void {
    const handler = (e: Event) => {
      const target = e.target as HTMLElement;
      const id = target?.getAttribute("data-issue-id");
      if (id) cb(id);
    };
    const overlay = this.ensureOverlay();
    overlay.addEventListener("click", handler);
    return () => overlay.removeEventListener("click", handler);
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
