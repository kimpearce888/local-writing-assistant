/**
 * Localized message lookups. Centralized so source files never hard-code
 * UI strings (section 44).
 */

export function t(
  messageName: string,
  substitutions?: string | string[],
): string {
  if (typeof chrome !== "undefined" && chrome.i18n?.getMessage) {
    const msg = chrome.i18n.getMessage(messageName, substitutions);
    if (msg) return msg;
  }
  return messageName;
}

export function getUILanguage(): string {
  if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
    return chrome.i18n.getUILanguage();
  }
  return "en";
}
