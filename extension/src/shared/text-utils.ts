/**
 * Text utilities used for stale-suggestion detection and hashing.
 *
 * No crypto secrets here — the hash is just for cache-key / staleness,
 * so a fast non-cryptographic hash is appropriate and avoids relying on
 * subtle-crypto availability in service workers.
 */

export function hashText(input: string): string {
  // FNV-1a 53-bit, string form, sufficient for cache keys / staleness.
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return out.toString(36);
}

/** Split a string into sentences (very small heuristic). */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const parts = text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?。！？])\s+|\n+/u);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Build a context window of size `windowChars` around the given offset. */
export function contextWindow(
  text: string,
  offset: number,
  windowChars: number,
): { before: string; after: string } {
  const start = Math.max(0, offset - Math.floor(windowChars / 2));
  const end = Math.min(text.length, offset + Math.ceil(windowChars / 2));
  return { before: text.slice(start, offset), after: text.slice(offset, end) };
}

/** Strip control chars but preserve whitespace and newlines. */
export function normalizeText(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * Truncate a string so its UTF-8 encoding is at most `maxBytes` bytes,
 * cutting at a UTF-16 code-unit boundary that never splits a surrogate
 * pair. The native host clamps payloads to a UTF-8 byte limit, so the
 * extension must measure in the SAME unit — truncating by UTF-16 chars
 * silently sends non-ASCII text that the host then byte-clamps, and the
 * returned offsets no longer line up with the text the UI validated.
 */
export function truncateToUtf8Bytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes < 0) return { text: "", truncated: text.length > 0 };
  let bytes = 0;
  let end = 0; // UTF-16 index after the last fully-included char
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    let charBytes: number;
    let units: number;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        charBytes = 4; // surrogate pair → one astral code point
        units = 2;
      } else {
        charBytes = 3; // unpaired high surrogate → U+FFFD on encode
        units = 1;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      charBytes = 3; // unpaired low surrogate → U+FFFD on encode
      units = 1;
    } else if (code < 0x80) {
      charBytes = 1;
      units = 1;
    } else if (code < 0x800) {
      charBytes = 2;
      units = 1;
    } else {
      charBytes = 3;
      units = 1;
    }
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += units;
    end = i;
  }
  return { text: text.slice(0, end), truncated: end < text.length };
}
