#!/usr/bin/env python3
"""
Human-like X11 input driver for the Local Writing Assistant E2E session.

Uses python-xlib's XTEST extension to send REAL input events to the
Xvfb display - exactly like a human moving the mouse and clicking.
Also captures full-screen screenshots (python-xlib get_image + Pillow)
so browser-drawn UI like Chrome's native context menu is captured.

Subcommands:
  move   X Y                 move the pointer
  click  X Y [BUTTON]        move + click (1=left 2=middle 3=right)
  dclick X Y                 double click
  key    KEYSPEC             press special key (keysym name, e.g. Down, Return, ctrl+a)
  type   TEXT                type text string
  drag   X1 Y1 X2 Y2         press, move in steps, release (text selection)
  shot   PATH                full-screen screenshot (includes browser chrome)
  diff   A B X Y W H         mean abs pixel diff of a region (menu detection)
  scroll X Y AMOUNT          scroll wheel (button 4/5), AMOUNT ticks
"""

import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

try:
    from PIL import Image
except ImportError:
    Image = None

D = display.Display()
ROOT = D.screen().root

KEYSYMS = {
    "Down": 65364, "Up": 65365, "Left": 65361, "Right": 65362,
    "Return": 65293, "Enter": 65293, "Escape": 65307, "Tab": 65289,
    "space": 32, "BackSpace": 65288, "Delete": 65535, "Home": 65360,
    "End": 65363, "Page_Down": 65366, "Page_Up": 65365,
}


def flush():
    D.sync()


def move(x, y):
    xtest.fake_input(D, X.MotionNotify, x=int(x), y=int(y))
    flush()


def press_button(button, press=True):
    detail = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5}[button]
    if press:
        xtest.fake_input(D, X.ButtonPress, detail)
    else:
        xtest.fake_input(D, X.ButtonRelease, detail)
    flush()


def click(x, y, button=1):
    move(x, y)
    time.sleep(0.15)
    press_button(button, True)
    time.sleep(0.06)
    press_button(button, False)
    flush()
    time.sleep(0.25)


def dclick(x, y):
    move(x, y)
    time.sleep(0.15)
    for _ in range(2):
        press_button(1, True)
        time.sleep(0.05)
        press_button(1, False)
        time.sleep(0.09)
    flush()
    time.sleep(0.25)


def press_keycode(kc, need_shift=False):
    shift_kc = D.keysym_to_keycode(65505)
    if need_shift:
        xtest.fake_input(D, X.KeyPress, shift_kc)
        flush()
    xtest.fake_input(D, X.KeyPress, kc)
    flush()
    time.sleep(0.02)
    xtest.fake_input(D, X.KeyRelease, kc)
    if need_shift:
        xtest.fake_input(D, X.KeyRelease, shift_kc)
        flush()
    time.sleep(0.04)


def key(keyspec):
    """Press a special key, or a single printable character."""
    if keyspec.startswith("ctrl+"):
        base = keyspec[5:]
        ctrl = D.keysym_to_keycode(65507)
        xtest.fake_input(D, X.KeyPress, ctrl)
        flush()
        kc = D.keysym_to_keycode(ord(base) if len(base) == 1 else KEYSYMS[base])
        press_keycode(kc)
        xtest.fake_input(D, X.KeyRelease, ctrl)
        flush()
        time.sleep(0.2)
        return
    code = KEYSYMS.get(keyspec)
    if code is None:
        if len(keyspec) == 1:
            type_text(keyspec)
            return
        raise SystemExit(f"unknown keyspec {keyspec}")
    kc = D.keysym_to_keycode(code)
    press_keycode(kc)
    flush()
    time.sleep(0.15)


def type_text(text):
    shifted = set("~!@#$%^&*()_+{}|:\"<>?")
    for ch in text:
        if ch == "\n":
            kc = D.keysym_to_keycode(65293)
            press_keycode(kc)
            time.sleep(0.05)
            continue
        if ch == " ":
            kc = D.keysym_to_keycode(32)
            press_keycode(kc)
            time.sleep(0.05)
            continue
        if ch.isalnum():
            kc = D.keysym_to_keycode(ord(ch.lower()))
            press_keycode(kc, need_shift=ch.isupper())
            time.sleep(0.05)
        elif ch in shifted:
            base = {
                "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
                "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-",
                "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
                "<": ",", ">": ".", "?": "/",
            }[ch]
            kc = D.keysym_to_keycode(ord(base))
            press_keycode(kc, need_shift=True)
            time.sleep(0.05)
        elif ch in ",./;='[]-\\":
            kc = D.keysym_to_keycode(ord(ch))
            press_keycode(kc)
            time.sleep(0.05)
        else:
            raise SystemExit(f"cannot type char {ch!r}")
    flush()


def drag(x1, y1, x2, y2):
    move(x1, y1)
    time.sleep(0.2)
    press_button(1, True)
    time.sleep(0.15)
    steps = 24
    for i in range(1, steps + 1):
        nx = x1 + (x2 - x1) * i / steps
        ny = y1 + (y2 - y1) * i / steps
        move(nx, ny)
        time.sleep(0.02)
    time.sleep(0.15)
    press_button(1, False)
    flush()
    time.sleep(0.3)


def scroll(x, y, amount):
    move(x, y)
    time.sleep(0.1)
    btn = 4 if amount > 0 else 5
    for _ in range(abs(int(amount))):
        xtest.fake_input(D, X.ButtonPress, btn)
        xtest.fake_input(D, X.ButtonRelease, btn)
        flush()
        time.sleep(0.05)
    time.sleep(0.2)


def shot(path):
    if Image is None:
        raise SystemExit("Pillow not installed")
    W = D.screen().width_in_pixels
    H = D.screen().height_in_pixels
    raw = ROOT.get_image(0, 0, W, H, X.ZPixmap, 0xFFFFFFFF).data
    img = Image.frombytes("RGB", (W, H), raw, "raw", "BGRX")
    img.save(path)
    print(f"saved {path} ({W}x{H})")


def diff(path_a, path_b, x, y, w, h):
    """Mean absolute pixel difference between two screenshots inside a
    region - used to detect whether browser-drawn UI (native menus) is
    visible, which DOM/CDP cannot see."""
    if Image is None:
        raise SystemExit("Pillow not installed")
    a = Image.open(path_a).crop((x, y, x + w, y + h)).convert("RGB")
    b = Image.open(path_b).crop((x, y, x + w, y + h)).convert("RGB")
    pa, pb = a.tobytes(), b.tobytes()
    total = 0
    n = len(pa)
    step = 3 * 7  # sample every 7th pixel for speed
    cnt = 0
    for i in range(0, n - step, step):
        total += abs(pa[i] - pb[i]) + abs(pa[i + 1] - pb[i + 1]) + abs(pa[i + 2] - pb[i + 2])
        cnt += 3
    print(f"{total / max(cnt, 1):.2f}")


def main():
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "move":
        move(int(args[0]), int(args[1]))
    elif cmd == "click":
        click(int(args[0]), int(args[1]), int(args[2]) if len(args) > 2 else 1)
    elif cmd == "dclick":
        dclick(int(args[0]), int(args[1]))
    elif cmd == "key":
        key(args[0])
    elif cmd == "type":
        type_text(args[0])
    elif cmd == "drag":
        drag(int(args[0]), int(args[1]), int(args[2]), int(args[3]))
    elif cmd == "scroll":
        scroll(int(args[0]), int(args[1]), int(args[2]))
    elif cmd == "shot":
        shot(args[0])
    elif cmd == "diff":
        diff(args[0], args[1], int(args[2]), int(args[3]), int(args[4]), int(args[5]))
    else:
        raise SystemExit(__doc__)
    flush()


if __name__ == "__main__":
    main()
