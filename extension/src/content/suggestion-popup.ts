/**
 * Suggestion popup (section 14).
 *
 * Single floating element attached to documentElement. Positions itself
 * with collision detection against viewport + fixed headers. Closes on
 * Escape, outside click, or explicit close button.
 *
 * Task 3-a addition: an "✎ Edit" button lets the user fine-tune the
 * replacement in an inline textarea before applying it (the edited value
 * is what the Apply button dispatches). While the textarea has focus the
 * outside-click handler must NOT close the popup — it already only closes
 * for clicks outside the root, and the textarea lives inside the root.
 */

import { escapeHtml } from "../shared/ai-validation";
import { t } from "../shared/i18n";
import { TaggedIssue } from "./suggestion-engine";

export interface PopupCallbacks {
  onReplace: (issue: TaggedIssue) => void;
  onIgnore: (issue: TaggedIssue) => void;
  onIgnoreWord: (issue: TaggedIssue) => void;
  onAddToDictionary: (issue: TaggedIssue) => void;
  onClose: () => void;
}

export class SuggestionPopup {
  private root: HTMLDivElement | null = null;
  private issue: TaggedIssue | null = null;
  /** Replacement fine-tuned via the "✎ Edit" textarea. Null when the user
   *  never touched it — in that case the model's original is dispatched. */
  private editedReplacement: string | null = null;
  private cbs: PopupCallbacks;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(cbs: PopupCallbacks) {
    this.cbs = cbs;
  }

  show(issue: TaggedIssue, anchorRect: DOMRect): void {
    this.hide();
    this.issue = issue;
    this.editedReplacement = null;
    const root = document.createElement("div");
    root.setAttribute("data-lwa-popup", "true");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.setAttribute("aria-label", "Writing suggestion");
    root.style.cssText = [
      "all:initial",
      "position:fixed",
      "z-index:2147483647",
      "max-width:340px",
      "min-width:240px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
      "font-size:13px",
      "color:#1f2328",
      "background:#ffffff",
      "border:1px solid #d0d7de",
      "border-radius:10px",
      "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
      "padding:10px 12px",
      "box-sizing:border-box",
    ].join(";");

    const cat = document.createElement("div");
    cat.textContent = prettyCategory(issue.category);
    cat.style.cssText =
      "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#6e7681;margin-bottom:6px";

    const explanation = document.createElement("div");
    explanation.textContent = issue.explanation || "—";
    explanation.style.cssText = "margin-bottom:8px;line-height:1.4";

    const replacementBlock = document.createElement("div");
    replacementBlock.style.cssText =
      "display:flex;flex-direction:column;gap:4px;margin-bottom:8px";
    const originalLine = document.createElement("div");
    originalLine.innerHTML = `<span style="color:#6e7681">${escapeHtml(t("suggestionReplace"))}: </span><span style="text-decoration:line-through;color:#9a6700">${escapeHtml(issue.original)}</span>`;
    const arrow = document.createElement("div");
    arrow.textContent = "↓";
    arrow.style.cssText = "text-align:center;color:#6e7681";
    // Kept as a live element so the "✎ Edit" textarea can update the
    // preview while the user types.
    const replacementPreview = document.createElement("strong");
    replacementPreview.textContent = issue.replacement;
    const newLine = document.createElement("div");
    const arrowPrefix = document.createElement("span");
    arrowPrefix.style.color = "#6e7681";
    arrowPrefix.textContent = "→ ";
    newLine.appendChild(arrowPrefix);
    newLine.appendChild(replacementPreview);
    replacementBlock.appendChild(originalLine);
    replacementBlock.appendChild(arrow);
    replacementBlock.appendChild(newLine);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";

    const replaceBtn = this._button(t("suggestionReplace"), true);
    replaceBtn.addEventListener("click", () => {
      if (this.issue) {
        // Dispatch the EDITED replacement when the user fine-tuned it via
        // "✎ Edit" — falls back to the model's original otherwise.
        this.cbs.onReplace({
          ...this.issue,
          replacement: this.editedReplacement ?? this.issue.replacement,
        });
      }
    });
    btnRow.appendChild(replaceBtn);

    // "✎ Edit" — inline replacement editor (better than Grammarly).
    // Only meaningful when there is a replacement to edit. While the
    // textarea has focus the outside-click handler does NOT close the
    // popup: it already only fires for clicks outside the root, and this
    // textarea lives INSIDE the root.
    if (issue.replacement.length > 0) {
      const editBtn = this._button("✎ Edit", false);
      let editArea: HTMLTextAreaElement | null = null;
      const commitEdit = (): void => {
        if (editArea) this.editedReplacement = editArea.value;
      };
      editBtn.addEventListener("click", () => {
        if (!editArea) {
          editArea = document.createElement("textarea");
          editArea.rows = 2;
          editArea.value = this.editedReplacement ?? issue.replacement;
          editArea.setAttribute("aria-label", "Edit replacement");
          editArea.setAttribute("data-lwa-popup", "true");
          editArea.style.cssText = [
            "width:100%",
            "box-sizing:border-box",
            "margin-top:6px",
            "padding:6px 8px",
            "border:1px solid #d0d7de",
            "border-radius:6px",
            "font-family:inherit",
            "font-size:13px",
            "line-height:1.4",
            "color:#1f2328",
            "background:#ffffff",
            "resize:vertical",
          ].join(";");
          editArea.addEventListener("input", () => {
            if (editArea) {
              this.editedReplacement = editArea.value;
              replacementPreview.textContent = editArea.value;
            }
          });
          // blur + change commit the value even if the user never clicks
          // "Done" (e.g. they go straight for the Apply button).
          editArea.addEventListener("blur", commitEdit);
          editArea.addEventListener("change", commitEdit);
          root.insertBefore(editArea, btnRow);
          editArea.focus();
          editBtn.textContent = "Done";
        } else {
          commitEdit();
          editArea.remove();
          editArea = null;
          editBtn.textContent = "✎ Edit";
        }
      });
      btnRow.appendChild(editBtn);
    }

    const ignoreBtn = this._button(t("suggestionIgnore"), false);
    ignoreBtn.addEventListener("click", () => {
      if (this.issue) this.cbs.onIgnore(this.issue);
    });
    btnRow.appendChild(ignoreBtn);

    if (issue.category === "spelling" && issue.original.trim().length > 0) {
      const addBtn = this._button(t("suggestionAddToDict"), false);
      addBtn.addEventListener("click", () => {
        if (this.issue) this.cbs.onAddToDictionary(this.issue);
      });
      const ignoreWordBtn = this._button(t("suggestionIgnoreWord"), false);
      ignoreWordBtn.addEventListener("click", () => {
        if (this.issue) this.cbs.onIgnoreWord(this.issue);
      });
      btnRow.appendChild(addBtn);
      btnRow.appendChild(ignoreWordBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", t("suggestionClose"));
    closeBtn.style.cssText = [
      "all:unset",
      "position:absolute",
      "top:4px",
      "right:6px",
      "width:22px",
      "height:22px",
      "line-height:22px",
      "text-align:center",
      "border-radius:4px",
      "cursor:pointer",
      "font-size:16px",
      "color:#6e7681",
    ].join(";");
    closeBtn.addEventListener("click", () => this.cbs.onClose());
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.background = "#f3f4f6";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.background = "transparent";
    });

    root.style.position = "fixed";
    root.appendChild(closeBtn);
    root.appendChild(cat);
    root.appendChild(explanation);
    root.appendChild(replacementBlock);
    root.appendChild(btnRow);
    document.documentElement.appendChild(root);
    this.root = root;

    // Position with collision detection.
    const popupRect = root.getBoundingClientRect();
    const margin = 8;
    const fixedHeaderHeight = this._estimateFixedHeaderHeight();

    let left = anchorRect.left;
    let top = anchorRect.bottom + 4;
    // If overflow right, flip to the left side of the anchor.
    if (left + popupRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - popupRect.width - margin);
    }
    // If overflow bottom, flip above the anchor.
    if (top + popupRect.height > window.innerHeight - margin) {
      const above = anchorRect.top - popupRect.height - 4;
      if (above >= fixedHeaderHeight + margin) {
        top = above;
      } else {
        top = Math.max(fixedHeaderHeight + margin, window.innerHeight - popupRect.height - margin);
      }
    }
    left = Math.max(margin, left);
    top = Math.max(fixedHeaderHeight + margin, top);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;

    this.outsideClickHandler = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) this.cbs.onClose();
    };
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.cbs.onClose();
    };
    document.addEventListener("mousedown", this.outsideClickHandler, true);
    document.addEventListener("keydown", this.escapeHandler, true);
  }

  /** True when this popup is currently visible and showing `issueId`.
   *  Used by the hover-suggestion wiring to skip re-showing the same
   *  issue (hover events re-fire constantly → popup would flicker). */
  isShowing(issueId: string): boolean {
    return this.root !== null && this.issue?.id === issueId;
  }

  hide(): void {
    this.issue = null;
    this.editedReplacement = null;
    if (this.outsideClickHandler) {
      document.removeEventListener("mousedown", this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler, true);
      this.escapeHandler = null;
    }
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
  }

  private _button(label: string, primary: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = primary
      ? [
          "all:unset",
          "cursor:pointer",
          "padding:5px 10px",
          "border-radius:6px",
          "background:#1f6feb",
          "color:#ffffff",
          "font-weight:600",
          "font-size:12px",
        ].join(";")
      : [
          "all:unset",
          "cursor:pointer",
          "padding:5px 10px",
          "border-radius:6px",
          "background:#f0f3f6",
          "color:#1f2328",
          "font-size:12px",
          "border:1px solid #d0d7de",
        ].join(";");
    b.addEventListener("mouseenter", () => {
      b.style.filter = "brightness(0.97)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.filter = "none";
    });
    return b;
  }

  private _estimateFixedHeaderHeight(): number {
    // Walk fixed/sticky elements at the top of the page and find the max
    // bottom edge — used to avoid covering the popup with site headers.
    let maxBottom = 0;
    try {
      const candidates = document.querySelectorAll(
        "header, [role='banner'], [data-lwa-skip], nav",
      );
      candidates.forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        if (cs.position === "fixed" || cs.position === "sticky") {
          if (r.bottom > maxBottom && r.bottom < window.innerHeight / 2) {
            maxBottom = r.bottom;
          }
        }
      });
    } catch {
      // ignore — sites can throw on access to computed styles for cross-origin elements
    }
    return maxBottom;
  }
}

function prettyCategory(c: string): string {
  const map: Record<string, string> = {
    spelling: "Spelling",
    grammar: "Grammar",
    punctuation: "Punctuation",
    clarity: "Clarity",
    word_choice: "Word choice",
    style: "Style",
  };
  return map[c] ?? c;
}
