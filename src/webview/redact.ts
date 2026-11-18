// PII & secret redaction for safe copying and exporting of JSON / JSONL records.
import { isContainer, parseJson, type JObj, type JVal } from './json';
import { compactJson } from './query';

const SENSITIVE_KEY =
  /(?:^|[_.\-\s])(?:password|passwd|pwd|secret|client_?secret|api_?key|access_?key|private_?key|token|access_?token|refresh_?token|id_?token|auth_?token|bearer|authorization|cookie|set-cookie|session_?id|session_?key|ssn|credit_?card|card_?number|cvv)(?:$|[_.\-\s])/i;

const EMAIL_KEY = /(?:^|[_.\-\s])(?:email|e-mail|mail)(?:$|[_.\-\s])/i;
const PHONE_KEY = /(?:^|[_.\-\s])(?:phone|mobile|tel|telephone)(?:$|[_.\-\s])/i;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi;
const API_KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_SECRET_RE = /([?&](?:token|access_token|api_key|apikey|key|secret|password|sig|signature)=)[^&\s#"']+/gi;

/** Masks inline secrets, Bearer/JWT tokens, API keys, URL secret params, and emails inside free text. */
export function redactString(s: string): string {
  return s
    .replace(BEARER_RE, '$1 ***REDACTED***')
    .replace(JWT_RE, '***REDACTED_JWT***')
    .replace(API_KEY_RE, '***REDACTED_KEY***')
    .replace(URL_SECRET_RE, '$1***REDACTED***')
    .replace(EMAIL_RE, '***@***.***');
}

function setKeySafe(o: JObj, k: string, v: JVal): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

/** Recursively clones `val`, masking sensitive keys and inline tokens/PII while preserving structure. */
export function redactValue(val: JVal, parentKey?: string, depth = 0): JVal {
  if (depth > 300) return val;
  if (parentKey) {
    if (SENSITIVE_KEY.test(parentKey)) {
      if (val === null || typeof val === 'boolean') return val;
      if (!isContainer(val)) return '***REDACTED***';
    }
    if (EMAIL_KEY.test(parentKey) && typeof val === 'string' && val.length > 0) return '***@***.***';
    if (PHONE_KEY.test(parentKey) && (typeof val === 'string' || typeof val === 'number')) return '***REDACTED_PHONE***';
  }
  if (typeof val === 'string') return redactString(val);
  if (!isContainer(val)) return val;
  if (Array.isArray(val)) return val.map((item) => redactValue(item, parentKey, depth + 1));
  const out: JObj = {};
  for (const k of Object.keys(val)) {
    setKeySafe(out, k, redactValue((val as JObj)[k], k, depth + 1));
  }
  return out;
}

/** Redacts one raw JSONL line; falls back to string-level pattern redaction if the line is invalid JSON. */
export function redactJsonLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try {
    return compactJson(redactValue(parseJson(trimmed)));
  } catch {
    return redactString(raw);
  }
}
