/**
 * Native-messaging relay for the content script (task 3-a).
 *
 * Content scripts cannot call chrome.runtime.connectNative — only the
 * service worker may. This module forwards a native command through the
 * service worker's existing "native-bridge-call" handler and resolves
 * with the host's NativeResponse envelope. It mirrors the sendNativeViaSW
 * helper in suggestion-engine.ts; the separate module exists so the
 * floating widget / tone detection / synonyms card can share one typed
 * transport instead of each re-implementing the message dance.
 */

import { NativeResponse } from "../shared/types";

/**
 * Forward a native-messaging call to the service worker and resolve with
 * the host response. Rejects on relay timeout, on chrome.runtime.lastError
 * (extension context invalidated, no listener, …), or when the SW replies
 * with no payload at all.
 */
export function sendNativeViaRelay(
  command: string,
  payload: unknown,
  timeoutMs: number,
): Promise<NativeResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay timeout")), timeoutMs);
    chrome.runtime.sendMessage(
      { type: "native-bridge-call", command, payload },
      (resp: NativeResponse | undefined) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (!resp) reject(new Error("no relay response"));
        else resolve(resp);
      },
    );
  });
}
