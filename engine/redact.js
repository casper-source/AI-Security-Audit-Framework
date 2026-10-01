// Masks the profile's redact strings in text sent to the auditor, whether that model is local or cloud.
// The longest string is replaced first, so a shorter one cannot cut it and leave the rest visible.
// Must not be used on the request sent to the lab, and must not log the original string.

const MASK = "[redacted]";

// Accepts the text about to be sent to the auditor and the redact strings from the profile.
// Replaces each of those strings with [redacted]. An empty list leaves the text unchanged.
// Returns the masked text.
export function redact(text, redactStrings) {
  const list = (redactStrings ?? [])
    .filter((needle) => typeof needle === "string" && needle.length > 0)
    .sort((left, right) => right.length - left.length);
  let masked = String(text ?? "");
  for (const needle of list) masked = masked.split(needle).join(MASK);
  return masked;
}
