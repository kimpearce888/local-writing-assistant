/**
 * Double-click thesaurus (Grammarly parity — task 3-a).
 *
 * requestSynonyms() round-trips through the native host's `rewrite`
 * command with the shared thesaurus prompt and validates the untrusted
 * model output with parseSynonymsResponse. Every failure path resolves
 * to [] — the synonyms card is a nice-to-have and must never surface an
 * error into the page.
 *
 * SynonymsCard renders a small chip card anchored to the double-clicked
 * word (collision-aware, mirrors SuggestionPopup positioning). All styles
 * are inline cssText and every element carries data-lwa-popup="true" so
 * the content script's MutationObserver filter keeps skipping our DOM.
 */

import { buildSynonymsPrompt } from "../shared/prompts";
import { parseSynonymsResponse } from "../shared/ai-validation";
import { getSettings } from "../shared/storage";
import { sendNativeViaRelay } from "./relay";

const POPUP_ATTR = "data-lwa-popup";
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Ask the local model for synonyms of `word` (with surrounding `context`
 * so senses are plausible). Resolves to [] on ANY failure — offline host,
 * invalid response, timeout — never throws into the page.
 */
export async function requestSynonyms(
  word: string,
  context: string,
): Promise<string[]> {
  try {
    const settings = await getSettings();
    const prompt = buildSynonymsPrompt({ word, context });
    const resp = await sendNativeViaRelay(
      "rewrite",
      {
        text: word,
        systemPrompt: prompt.system,
        model: settings.model,
        temperature: 0.3,
        maxTokens: 200,
        timeoutMs: settings.requestTimeoutMs,
      },
      settings.requestTimeoutMs + 5000,
    );
    if (!resp.ok) return [];
    const data = resp.data as { raw?: string } | undefined;
    if (!data || typeof data.raw !== "string") return [];
    return parseSynonymsResponse(data.raw, word);
  } catch {
    return [];
  }
}

export interface SynonymsCardCallbacks {
  onPick: (syn: string) => void;
  onClose: () => void;
}

/** The card currently visible, if any ( backs the module-level hide()). */
let activeCard: SynonymsCard | null = null;

export class SynonymsCard {
  private cbs: SynonymsCardCallbacks;
  private root: HTMLDivElement | null = null;
  private outsideMousedownHandler: ((e: MouseEvent) => void) | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(cbs: SynonymsCardCallbacks) {
    this.cbs = cbs;
  }

  /**
   * Show the synonyms card for `word` anchored at `anchorRect`.
   * `start`/`end` identify the word's range in the editor text; the
   * stale-check + replace live in the caller's onPick closure, so the
   * card itself only renders and reports picks.
   */
  show(
    word: string,
    start: number,
    end: number,
    anchorRect: DOMRect,
    synonyms: string[],
  ): void {
    // NOTE: start/end are intentionally unused here — the stale-check and
    // the actual replaceRange live in the caller's onPick closure, which
    // closes over the same selection offsets.
    this.hide();

    const root = document.createElement("div");
    root.setAttribute(POPUP_ATTR, "true");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.setAttribute("aria-label", "Synonyms");
    root.style.cssText = [
      "all:initial",
      "position:fixed",
      "z-index:2147483647",
      "max-width:300px",
      "min-width:200px",
      `font-family:${FONT_STACK}`,
      "font-size:13px",
      "color:#1f2328",
      "background:#ffffff",
      "border:1px solid #d0d7de",
      "border-radius:10px",
      "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
      "padding:10px 12px",
      "box-sizing:border-box",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = `Synonyms — ${word}`;
    title.setAttribute(POPUP_ATTR, "true");
    title.style.cssText =
      "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#6e7681;margin-bottom:8px";

    const chipRow = document.createElement("div");
    chipRow.setAttribute(POPUP_ATTR, "true");
    chipRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";

    for (const syn of synonyms) {
      const chip = document.createElement("button");
      chip.setAttribute("type", "button");
      chip.setAttribute(POPUP_ATTR, "true");
      chip.textContent = syn;
      chip.style.cssText = [
        "all:unset",
        "cursor:pointer",
        "border:1px solid #d0d7de",
        "border-radius:999px",
        "padding:3px 10px",
        "font-size:12px",
        "color:#1f2328",
        "background:#ffffff",
        `font-family:${FONT_STACK}`,
      ].join(";");
      chip.addEventListener("mouseenter", () => {
        chip.style.filter = "brightness(0.95)";
      });
      chip.addEventListener("mouseleave", () => {
        chip.style.filter = "none";
      });
      chip.addEventListener("click", () => {
        this.cbs.onPick(syn);
      });
      chipRow.appendChild(chip);
    }

    root.appendChild(title);
    root.appendChild(chipRow);
    document.documentElement.appendChild(root);
    this.root = root;
    activeCard = this;

    // Collision-aware positioning (mirrors SuggestionPopup): flip above
    // the anchor when the card would overflow the bottom of the viewport.
    const cardRect = root.getBoundingClientRect();
    const margin = 8;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 4;
    if (left + cardRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - cardRect.width - margin);
    }
    if (top + cardRect.height > window.innerHeight - margin) {
      const above = anchorRect.top - cardRect.height - 4;
      top = above >= margin
        ? above
        : Math.max(margin, window.innerHeight - cardRect.height - margin);
    }
    left = Math.max(margin, left);
    top = Math.max(margin, top);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;

    this.outsideMousedownHandler = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) this.cbs.onClose();
    };
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.cbs.onClose();
    };
    document.addEventListener("mousedown", this.outsideMousedownHandler, true);
    document.addEventListener("keydown", this.escapeHandler, true);
  }

  hide(): void {
    if (this.outsideMousedownHandler) {
      document.removeEventListener("mousedown", this.outsideMousedownHandler, true);
      this.outsideMousedownHandler = null;
    }
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler, true);
      this.escapeHandler = null;
    }
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    if (activeCard === this) activeCard = null;
  }
}

/** Close whichever synonyms card is currently visible, if any. */
export function hide(): void {
  activeCard?.hide();
}
