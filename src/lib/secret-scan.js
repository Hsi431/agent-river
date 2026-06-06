const SECRET_PATTERNS = [
  { name: "openai_like_key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "pem_private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "google_api_key", regex: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { name: "authorization_header", regex: /\bAuthorization\s*:\s*(Bearer|Basic)\s+[A-Za-z0-9_./+=:-]{12,}/gi },
  { name: "credentialed_url", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@[^/\s]+/gi },
  { name: "api_key_assignment", regex: /\b(api[_-]?key|token|secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_./+=:@-]{8,}/gi },
  { name: "credential_assignment", regex: /\b([a-z0-9_-]*pass(word)?|pwd|credential|auth|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_./+=:@-]{8,}/gi },
];

export function scanSecrets(text) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match = pattern.regex.exec(text);
    while (match) {
      findings.push({
        type: pattern.name,
        index: match.index,
        length: match[0].length,
      });
      match = pattern.regex.exec(text);
    }
  }
  return findings;
}

export function redactSecrets(text) {
  const source = String(text || "");
  const spans = mergeSpans(scanSecrets(source));
  if (spans.length === 0) {
    return source;
  }
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += source.slice(cursor, span.index);
    result += `[redacted:${span.type}]`;
    cursor = span.index + span.length;
  }
  return result + source.slice(cursor);
}

function mergeSpans(findings) {
  const sorted = [...findings].sort((a, b) => a.index - b.index || b.length - a.length);
  const merged = [];
  for (const finding of sorted) {
    const last = merged[merged.length - 1];
    if (last && finding.index < last.index + last.length) {
      const end = Math.max(last.index + last.length, finding.index + finding.length);
      last.length = end - last.index;
    } else {
      merged.push({ index: finding.index, length: finding.length, type: finding.type });
    }
  }
  return merged;
}

export function assertNoSecrets(text) {
  const findings = scanSecrets(text);
  if (findings.length > 0) {
    throw new Error(`Refusing to store possible secret (${findings.map((item) => item.type).join(", ")})`);
  }
}
