/**
 * Grammarly-style floating widget (task 3-a).
 *
 * A 40px circular trigger docked just OUTSIDE the focused editor's
 * bottom-right corner. Editors shorter than 38px are skipped — a big
 * circle hovering over a one-line search input is pure noise (Grammarly
 * skips tiny fields the same way).
 *
 * States:
 *  - checking  → "⟳" glyph with a rotation animation (Web Animations API,
 *                so no stylesheet/keyframes are needed on the host page)
 *                and aria-busy on the trigger.
 *  - clean     → green "✓" in the circle + green corner badge (#1a7f37).
 *  - issues    → red issue count in the circle + red badge (#d33b3b).
 *  - score     → tooltip title "Overall 92 · Correctness 95 · …" (generic
 *                title until the first analysis completes).
 *  - tones     → strongest detected tone's emoji as a 16px chip at the
 *                widget's top-left corner, only when the text is long
 *                enough (≥150 chars) for tone to be meaningful; the full
 *                reading is appended to the tooltip title.
 *
 * Clicking the circle toggles a right-aligned dropdown menu (open panel /
 * check now / detect tone / pause-resume this site / settings). The pause
 * item is handled internally via shared/storage and the pause state is
 * re-read on EVERY menu open (async-safe: it may have been flipped from
 * the toolbar popup or another tab).
 *
 * Every element created here carries data-lwa-widget="true" so the
 * content script's MutationObserver filter keeps skipping our own DOM
 * (hasLwaMarker / isInsideLwa in index.ts). All styles are inline
 * cssText — content pages must not rely on our stylesheet (the content
 * bundle ships no CSS file).
 */

import { EditorAdapter } from "./adapters/adapter";
import { isHostPaused, setHostPaused } from "../shared/storage";
import { toneEmoji } from "../shared/tone";
import { ScoreBreakdown, ToneReading } from "../shared/types";

const WIDGET_ATTR = "data-lwa-widget";
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const CIRCLE_SIZE = 40;
/** Editors shorter than this get no widget (Grammarly skips tiny fields). */
const MIN_EDITOR_HEIGHT = 38;
const VIEWPORT_MARGIN = 8;
/** Text shorter than this is too little signal for a tone chip. */
const MIN_TONE_TEXT_CHARS = 150;

export interface FloatingWidgetOptions {
  onOpenPanel: () => void;
  onCheckNow: () => void;
  onDetectTone: () => void;
  onOpenSettings: () => void;
}

/** Clamp `v` into [min, max] without ever letting max < min. */
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

export class FloatingWidget {
  private opts: FloatingWidgetOptions;
  /** The editor the widget is currently docked to. */
  private adapter: EditorAdapter | null = null;

  private root: HTMLDivElement | null = null;
  private trigger: HTMLButtonElement | null = null;
  private badge: HTMLDivElement | null = null;
  private toneChip: HTMLDivElement | null = null;
  private menu: HTMLDivElement | null = null;
  private spinAnimation: Animation | null = null;

  private checking = false;
  private issueCount = 0;
  private score: ScoreBreakdown | null = null;
  private tones: ToneReading[] = [];
  private hidden = true;

  /** Reposition wiring — same pattern as HighlightLayer. */
  private scrollResizeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedEl: HTMLElement | null = null;
  private outsideMousedownHandler: ((e: MouseEvent) => void) | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(opts: FloatingWidgetOptions) {
    this.opts = opts;
  }

  /**
   * Dock the widget to `adapter`'s bottom-right corner, OUTSIDE the
   * editor rect. Safe to call repeatedly (re-focus) and with a different
   * adapter (editor switch) — listeners are attached once, the
   * ResizeObserver is re-pointed at the new element.
   */
  attach(adapter: EditorAdapter): void {
    this.adapter = adapter;
    const rect = adapter.el.getBoundingClientRect();
    // Grammarly skips tiny fields — a 40px circle over a 20px input is noise.
    if (rect.height < MIN_EDITOR_HEIGHT) {
      this.hide();
      return;
    }
    this.closeMenu();
    const root = this.ensureRoot();
    this.hidden = false;
    root.style.display = "block";
    this.positionFor(rect);
    this.attachScrollResizeListener();
    this.renderTrigger();
    this.renderBadge();
    this.renderToneChip();
    this.updateTitle();
  }

  /** Visually hide the widget (state is kept — highlights/issues persist). */
  hide(): void {
    this.closeMenu();
    this.hidden = true;
    if (this.root) this.root.style.display = "none";
  }

  /** Remove every listener, observer and DOM node created by the widget. */
  dispose(): void {
    this.detach();
  }

  /** Internal teardown shared by dispose() and the dead-editor path. */
  private detach(): void {
    this.adapter = null;
    this.observedEl = null;
    this.closeMenu();
    if (this.scrollResizeHandler) {
      window.removeEventListener("scroll", this.scrollResizeHandler, { capture: true });
      window.removeEventListener("resize", this.scrollResizeHandler);
      this.scrollResizeHandler = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.stopSpin();
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    this.trigger = null;
    this.badge = null;
    this.toneChip = null;
    this.hidden = true;
  }

  /* ---------------- Public state setters ---------------- */

  /** Show the spinning "⟳" while an analysis is in flight (aria-busy). */
  setChecking(on: boolean): void {
    if (this.checking === on) return;
    this.checking = on;
    if (this.trigger) {
      this.trigger.setAttribute("aria-busy", on ? "true" : "false");
    }
    this.renderTrigger();
  }

  /** Update the issue count badge: green when 0, red when > 0. */
  setIssues(count: number): void {
    const c = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    if (this.issueCount === c) return;
    this.issueCount = c;
    this.renderTrigger();
    this.renderBadge();
  }

  /** Update the score tooltip (null → generic title). */
  setScore(score: ScoreBreakdown | null): void {
    this.score = score;
    this.updateTitle();
  }

  /** Update the tone chip + tooltip. Empty list hides the chip. */
  setTones(tones: ToneReading[]): void {
    this.tones = Array.isArray(tones) ? tones : [];
    this.renderToneChip();
    this.updateTitle();
  }

  /* ---------------- DOM construction ---------------- */

  private ensureRoot(): HTMLDivElement {
    if (this.root && this.root.isConnected) return this.root;
    const root = document.createElement("div");
    root.setAttribute(WIDGET_ATTR, "true");
    root.style.cssText = [
      "all:initial",
      "position:fixed",
      "z-index:2147483647",
      `width:${CIRCLE_SIZE}px`,
      `height:${CIRCLE_SIZE}px`,
      "display:none",
      "box-sizing:border-box",
    ].join(";");

    const trigger = document.createElement("button");
    trigger.setAttribute("type", "button");
    trigger.setAttribute("role", "button");
    trigger.setAttribute("aria-label", "Writing assistant");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute(WIDGET_ATTR, "true");
    trigger.style.cssText = [
      "all:unset",
      "cursor:pointer",
      `width:${CIRCLE_SIZE}px`,
      `height:${CIRCLE_SIZE}px`,
      "box-sizing:border-box",
      "border-radius:50%",
      "background:#ffffff",
      "border:1px solid #d0d7de",
      "box-shadow:0 2px 8px rgba(0,0,0,0.22)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      `font-family:${FONT_STACK}`,
      "font-size:15px",
      "font-weight:700",
      "color:#1a7f37",
      "user-select:none",
    ].join(";");
    trigger.addEventListener("click", () => this.toggleMenu());
    trigger.addEventListener("mouseenter", () => {
      trigger.style.boxShadow = "0 3px 12px rgba(0,0,0,0.28)";
    });
    trigger.addEventListener("mouseleave", () => {
      trigger.style.boxShadow = "0 2px 8px rgba(0,0,0,0.22)";
    });

    const badge = document.createElement("div");
    badge.setAttribute(WIDGET_ATTR, "true");
    badge.setAttribute("aria-hidden", "true");
    badge.style.cssText = [
      "position:absolute",
      "top:-2px",
      "right:-2px",
      "width:10px",
      "height:10px",
      "border-radius:50%",
      "background:#1a7f37",
      "border:1.5px solid #ffffff",
      "box-sizing:border-box",
      "pointer-events:none",
    ].join(";");

    const toneChip = document.createElement("div");
    toneChip.setAttribute(WIDGET_ATTR, "true");
    toneChip.setAttribute("aria-hidden", "true");
    toneChip.style.cssText = [
      "position:absolute",
      "top:-6px",
      "left:-6px",
      "width:16px",
      "height:16px",
      "border-radius:50%",
      "background:#ffffff",
      "border:1px solid #d0d7de",
      "box-shadow:0 1px 3px rgba(0,0,0,0.2)",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "font-size:10px",
      "line-height:1",
      "pointer-events:none",
    ].join(";");

    root.appendChild(trigger);
    root.appendChild(badge);
    root.appendChild(toneChip);
    document.documentElement.appendChild(root);
    this.root = root;
    this.trigger = trigger;
    this.badge = badge;
    this.toneChip = toneChip;
    return root;
  }

  /* ---------------- Rendering ---------------- */

  private renderTrigger(): void {
    const trigger = this.trigger;
    if (!trigger) return;
    if (this.checking) {
      trigger.textContent = "⟳";
      trigger.style.color = "#57606a";
      this.startSpin();
      return;
    }
    this.stopSpin();
    if (this.issueCount === 0) {
      trigger.textContent = "✓";
      trigger.style.color = "#1a7f37";
    } else {
      trigger.textContent =
        this.issueCount > 99 ? "99+" : String(this.issueCount);
      trigger.style.color = "#d33b3b";
    }
  }

  private renderBadge(): void {
    const badge = this.badge;
    if (!badge) return;
    badge.style.background = this.issueCount > 0 ? "#d33b3b" : "#1a7f37";
  }

  private renderToneChip(): void {
    const chip = this.toneChip;
    if (!chip) return;
    const first = this.tones[0];
    const textLen = this.adapter ? this.adapter.getText().length : 0;
    if (first && textLen >= MIN_TONE_TEXT_CHARS) {
      chip.textContent = toneEmoji(first.tone);
      chip.style.display = "flex";
    } else {
      chip.textContent = "";
      chip.style.display = "none";
    }
  }

  private updateTitle(): void {
    const trigger = this.trigger;
    if (!trigger) return;
    const parts: string[] = [];
    if (this.score) {
      parts.push(
        `Overall ${this.score.overall}`,
        `Correctness ${this.score.correctness}`,
        `Clarity ${this.score.clarity}`,
        `Engagement ${this.score.engagement}`,
        `Delivery ${this.score.delivery}`,
      );
    } else {
      parts.push("Writing assistant");
    }
    if (this.tones.length > 0) {
      parts.push(
        "Tone: " +
          this.tones
            .map((tone) => `${tone.tone} ${Math.round(tone.score * 100)}%`)
            .join(", "),
      );
    }
    trigger.title = parts.join(" · ");
  }

  /* ---------------- Spinner (Web Animations API — no stylesheet) ------- */

  private startSpin(): void {
    if (this.spinAnimation || !this.trigger) return;
    try {
      this.spinAnimation = this.trigger.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 900, iterations: Infinity },
      );
    } catch {
      // element.animate unsupported — the glyph still shows, just static.
    }
  }

  private stopSpin(): void {
    if (this.spinAnimation) {
      try {
        this.spinAnimation.cancel();
      } catch {
        // Already finished/cancelled — nothing to do.
      }
      this.spinAnimation = null;
    }
  }

  /* ---------------- Positioning ---------------- */

  /** Dock position: bottom-right OUTSIDE the editor rect, clamped to the
   *  viewport with 8px margins. */
  private positionFor(rect: DOMRect): void {
    const root = this.root;
    if (!root) return;
    const left = clamp(
      rect.right - 44,
      VIEWPORT_MARGIN,
      window.innerWidth - CIRCLE_SIZE - VIEWPORT_MARGIN,
    );
    const top = clamp(
      rect.bottom + 6,
      VIEWPORT_MARGIN,
      window.innerHeight - CIRCLE_SIZE - VIEWPORT_MARGIN,
    );
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  private reposition(): void {
    if (this.hidden || !this.adapter || !this.root) return;
    // SPA view switches remove the editor from the DOM; the
    // ResizeObserver fires one last time on detach — treat a
    // disconnected editor as the teardown signal (no polling interval).
    if (!this.adapter.el.isConnected) {
      this.detach();
      return;
    }
    this.positionFor(this.adapter.el.getBoundingClientRect());
  }

  /** Attach (once) scroll + resize + ResizeObserver repositioning —
   *  copied from HighlightLayer.attachScrollResizeListener: capture+
   *  passive scroll so inner scrollable containers (Gmail/Slack/Notion)
   *  are caught without ever blocking scrolling, plus ResizeObserver on
   *  the editor and document.body for layout shifts that fire no events. */
  private attachScrollResizeListener(): void {
    if (!this.scrollResizeHandler) {
      const handler = (): void => this.reposition();
      this.scrollResizeHandler = handler;
      window.addEventListener("scroll", handler, { capture: true, passive: true });
      window.addEventListener("resize", handler, { passive: true });
    }
    if (typeof ResizeObserver !== "undefined") {
      try {
        if (!this.resizeObserver) {
          this.resizeObserver = new ResizeObserver(() => this.reposition());
        }
        const el = this.adapter?.el ?? null;
        if (el && el !== this.observedEl) {
          this.resizeObserver.disconnect();
          this.resizeObserver.observe(el);
          // A layout change anywhere on the page can shift the editor.
          this.resizeObserver.observe(document.body);
          this.observedEl = el;
        }
      } catch {
        // ResizeObserver may throw if the element is detached; ignore.
      }
    }
  }

  /* ---------------- Dropdown menu ---------------- */

  private toggleMenu(): void {
    if (this.menu) this.closeMenu();
    else this.openMenu();
  }

  private openMenu(): void {
    const root = this.root;
    const trigger = this.trigger;
    if (!root || !trigger) return;
    this.closeMenu();

    const menu = document.createElement("div");
    menu.setAttribute(WIDGET_ATTR, "true");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Writing assistant menu");
    menu.style.cssText = [
      "all:initial",
      "position:absolute",
      "top:46px",
      "right:0",
      "max-width:220px",
      "min-width:160px",
      "background:#ffffff",
      "border:1px solid #d0d7de",
      "border-radius:10px",
      "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
      `font-family:${FONT_STACK}`,
      "font-size:13px",
      "color:#1f2328",
      "padding:6px",
      "display:flex",
      "flex-direction:column",
      "gap:2px",
      "box-sizing:border-box",
    ].join(";");

    const mkItem = (label: string, run: () => void): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("role", "menuitem");
      btn.setAttribute(WIDGET_ATTR, "true");
      btn.textContent = label;
      btn.style.cssText = [
        "all:unset",
        "cursor:pointer",
        "text-align:left",
        "padding:7px 10px",
        "border-radius:6px",
        `font-family:${FONT_STACK}`,
        "font-size:13px",
        "color:#1f2328",
        "white-space:nowrap",
      ].join(";");
      btn.addEventListener("click", () => {
        run();
        this.closeMenu();
      });
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "#f3f4f6";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "transparent";
      });
      return btn;
    };

    menu.appendChild(mkItem("Open writing panel", () => this.opts.onOpenPanel()));
    menu.appendChild(mkItem("Check now", () => this.opts.onCheckNow()));
    menu.appendChild(mkItem("Detect tone", () => this.opts.onDetectTone()));
    // Pause/Resume is handled internally: read the CURRENT state at click
    // time (async-safe) and flip it — the label below is refreshed as soon
    // as the open-time read resolves, and re-read fresh on every open.
    const pauseBtn = mkItem("Pause on this site", () => {
      void isHostPaused(location.host)
        .then((paused) => setHostPaused(location.host, !paused))
        .catch(() => undefined);
    });
    menu.appendChild(pauseBtn);
    menu.appendChild(mkItem("Settings", () => this.opts.onOpenSettings()));

    root.appendChild(menu);
    this.menu = menu;
    trigger.setAttribute("aria-expanded", "true");

    // Refresh the pause label from storage (storage.local read always
    // resolves in a microtask, i.e. after this synchronous block, so
    // this.menu is already set — and this menu may have been closed
    // again by then, which the identity check guards against).
    void isHostPaused(location.host)
      .then((paused) => {
        if (this.menu === menu) {
          pauseBtn.textContent = paused
            ? "Resume on this site"
            : "Pause on this site";
        }
      })
      .catch(() => undefined);

    // Collision-aware flip: open the menu ABOVE the widget when it would
    // overflow the bottom of the viewport (menu content is fully built
    // synchronously, so this measurement is accurate).
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - VIEWPORT_MARGIN) {
      menu.style.top = "auto";
      menu.style.bottom = "46px";
    }

    this.outsideMousedownHandler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // Clicks on the trigger itself are handled by the toggle click.
      if (
        this.menu &&
        !this.menu.contains(target) &&
        !trigger.contains(target)
      ) {
        this.closeMenu();
      }
    };
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeMenu();
    };
    document.addEventListener("mousedown", this.outsideMousedownHandler, true);
    document.addEventListener("keydown", this.escapeHandler, true);
  }

  private closeMenu(): void {
    if (this.outsideMousedownHandler) {
      document.removeEventListener("mousedown", this.outsideMousedownHandler, true);
      this.outsideMousedownHandler = null;
    }
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler, true);
      this.escapeHandler = null;
    }
    if (this.menu) {
      this.menu.remove();
      this.menu = null;
    }
    if (this.trigger) {
      this.trigger.setAttribute("aria-expanded", "false");
    }
  }
}
