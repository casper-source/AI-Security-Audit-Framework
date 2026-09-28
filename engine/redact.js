// Masks configured needles in text that is about to leave the machine.
// Longest needle wins so a short needle cannot split a longer one.
// Must not be used on the target request, and must not log a needle.

const MASK = "[redacted]";

/**
 * @param {string} text
 * @param {string[]} needles
 * @returns {string}
 */
export function redact(text, needles) {
  const list = (needles ?? [])
    .filter((needle) => typeof needle === "string" && needle.length > 0)
    .sort((left, right) => right.length - left.length);
  let masked = String(text ?? "");
  for (const needle of list) masked = masked.split(needle).join(MASK);
  return masked;
}
