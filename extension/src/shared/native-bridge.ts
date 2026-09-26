/**
 * Native messaging bridge from the extension to the local Go host.
 *
 * Chrome's runtime.connectNative spawns the host executable, then sends
 * length-prefixed JSON messages over stdin/stdout. We use a long-lived
 * port so we can multiplex requests, support cancellation, and detect
 * crashes.
 */

import {
  NativeRequest,
  NativeResponse,
  NATIVE_HOST_NAME,
} from "./types";

type PendingEntry = {
  resolve: (resp: NativeResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let port: chrome.runtime.Port | null = null;
const pending = new Map<string, PendingEntry>();
let nextSeq = 1;
let lastError: string | null = null;

function ensurePort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port.onMessage.addListener((msg: NativeResponse) => {
    if (!msg.requestId) return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.requestId);
    entry.resolve(msg);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message ?? "native host disconnected";
    lastError = err;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error(err));
    }
    port = null;
  });
  return port;
}

export function getNativeHostLastError(): string | null {
  return lastError;
}

export function resetNativeHostLastError(): void {
  lastError = null;
}

/**
 * Send a request to the native host. Resolves with the host response.
 * Throws on disconnect / timeout.
 */
export function sendNative(
  command: NativeRequest["command"],
  payload?: unknown,
  timeoutMs = 30000,
): Promise<NativeResponse> {
  const requestId = `r${nextSeq++}`;
  const req: NativeRequest = { command, requestId, payload };
  return new Promise<NativeResponse>((resolve, reject) => {
    let p: chrome.runtime.Port;
    try {
      p = ensurePort();
    } catch (e) {
      reject(e as Error);
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("native host timeout"));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try {
      p.postMessage(req);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(e as Error);
    }
  });
}

/** Force a clean disconnect (used by tests / reload flows). */
export function disconnectNative(): void {
  if (port) {
    try {
      port.disconnect();
    } catch {
      // ignore
    }
    port = null;
  }
}

/** True if the port is currently connected. */
export function isNativeConnected(): boolean {
  return port !== null;
}
