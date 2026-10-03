/**
 * Telegram voice speech-text normalization
 * Zones: telegram outbound, voice delivery, shared utils
 * Owns deterministic Markdown and URL removal immediately before TTS delivery
 */

const MARKDOWN_LINK_RE = /!?(?:\[([^\]]*)\])\((?:[^()\\]|\\.)*\)/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const AUTOLINK_RE = /<https?:\/\/[^>\s]+>/gi;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const EMPHASIS_RE = /(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1/g;
const WHITESPACE_RE = /[ \t]+/g;

/**
 * Converts arbitrary assistant-authored Markdown into safe, readable TTS input.
 * Visual Telegram delivery is intentionally untouched; this is the voice boundary only.
 */
export function sanitizeTelegramVoiceText(text: string): string {
  let sanitized = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(FENCED_CODE_RE, "")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(AUTOLINK_RE, "")
    .replace(URL_RE, "")
    .replace(INLINE_CODE_RE, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");

  // Repeatedly unwrap nested emphasis such as ***important***.
  let previous: string;
  do {
    previous = sanitized;
    sanitized = sanitized.replace(EMPHASIS_RE, "$2");
  } while (sanitized !== previous);

  return sanitized
    .replace(/\\([\\`*{}_\[\]()#+\-.!])/g, "$1")
    // Do not let malformed emphasis make its punctuation through to TTS.
    .replace(/\*+/g, "")
    .replace(/(^|[^\w])_+(?=\S)/g, "$1")
    .replace(/(?<=\S)_+($|[^\w])/g, "$1")
    .replace(/[|]/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(WHITESPACE_RE, " ")
    .trim();
}
