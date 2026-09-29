/**
 * Localized message lookups. Centralized so source files never hard-code
 * UI strings (section 44).
 *
 * If a message key is missing from the locale catalog, chrome.i18n.getMessage
 * returns "" (empty string). The previous fallback returned the message KEY
 * itself (e.g., "suggestionReplace"), which would show as raw UI text. We now
 * convert the key to a human-readable fallback by replacing camelCase with
 * spaces and capitalizing the first letter.
 */

export function t(
  messageName: string,
  substitutions?: string | string[],
): string {
  if (typeof chrome !== "undefined" && chrome.i18n?.getMessage) {
    const msg = chrome.i18n.getMessage(messageName, substitutions);
    if (msg) return msg;
  }
  // Fallback: convert camelCase key to a readable string.
  // "suggestionReplace" → "Suggestion replace"
  return messageName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^([a-z])/, (_, c) => c.toUpperCase());
}

export function getUILanguage(): string {
  if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
    return chrome.i18n.getUILanguage();
  }
  return "en";
}
