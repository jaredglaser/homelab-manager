import { createHash } from 'node:crypto';

export const SHAPE_NORMALIZER_VERSION = 1;
export const SHAPE_INPUT_MAX_CHARS = 4096;
export const SHAPE_TEMPLATE_MAX_CHARS = 512;
export const SHAPE_ID_LENGTH = 16;
export const MAX_CAPTURED_NUMBERS = 16;
export const JSON_FAST_PATH_MAX_BYTES = 8192;
// Budget migration 037 cites for log_shapes; not enforced anywhere yet, since
// the worker that would count shapes per entity and fold new ones past it does not exist.
export const MAX_SHAPES_PER_ENTITY = 500;

export type ShapePlaceholder =
  | '<TS>'
  | '<DUR>'
  | '<UUID>'
  | '<IP>'
  | '<IP6>'
  | '<MAC>'
  | '<URL>'
  | '<EMAIL>'
  | '<PATH>'
  | '<HEX>'
  | '<ID>'
  | '<VER>'
  | '<STR>'
  | '<N>'
  | '<BOOL>'
  | '<NULL>'
  | '<OBJ>'
  | '<ARR>';

export interface NormalizedShape {
  readonly template: string;
  readonly shapeId: string;
  readonly placeholderCount: number;
  readonly tokenCount: number;
  readonly truncated: boolean;
  readonly viaJson: boolean;
  readonly numbers: readonly number[];
}

export interface ShapePass {
  readonly name: string;
  readonly placeholder: ShapePlaceholder | null;
  readonly pattern: RegExp;
}

export const SUFFIX_INDEX_KEEP: ReadonlySet<string> = new Set([
  'utf8',
  'utf16',
  'utf32',
  'sha1',
  'sha256',
  'sha384',
  'sha512',
  'md5',
  'crc32',
  'base64',
  'base32',
  'ipv4',
  'ipv6',
  'x86',
  'amd64',
  'arm64',
  'arm7',
  'i386',
  's390x',
  'http2',
  'http3',
  'oauth2',
  'ed25519',
  'x25519',
  'p256',
  'p384',
  'p521',
  'log4j',
]);

export const SIGNIFICANT_JSON_KEYS: readonly string[] = [
  'level',
  'severity',
  'lvl',
  'event',
  'msg',
  'message',
  'error',
  'err',
  'status',
  'code',
  'reason',
];

const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set<string>([
  '<TS>',
  '<DUR>',
  '<UUID>',
  '<IP>',
  '<IP6>',
  '<MAC>',
  '<URL>',
  '<EMAIL>',
  '<PATH>',
  '<HEX>',
  '<ID>',
  '<VER>',
  '<STR>',
  '<N>',
  '<BOOL>',
  '<NULL>',
  '<OBJ>',
  '<ARR>',
]);

// Control bytes are built from char codes rather than typed as \u escapes: a
// literal ESC/BEL/sentinel byte in source text is indistinguishable from one
// produced by an editor auto-normalizing an escape sequence, so charCode
// construction is the only reliable way to keep these exact bytes in the file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const SENTINEL = String.fromCharCode(0x01);

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');

const CONTROL_CHARS = (() => {
  const chars: string[] = [];
  for (let code = 0x00; code <= 0x08; code += 1) chars.push(String.fromCharCode(code));
  for (let code = 0x0b; code <= 0x1f; code += 1) chars.push(String.fromCharCode(code));
  chars.push(String.fromCharCode(0x7f));
  return chars.join('');
})();
const CONTROL_RE = new RegExp(`[${CONTROL_CHARS}]`, 'g');

const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'`\\]+/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const MAC_RE = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g;
// The leading-"::" branch tries an (optional hex prefix) + IPv4-dotted-quad tail
// before a pure hex chain: for "::ffff:192.168.0.1" the hex-chain alternative
// would otherwise greedily read "192" as a fourth hex group, leaving ".168.0.1"
// for VER_RE to misparse as a semver.
const IPV6_RE =
  /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|(?<![\w:])(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?|::(?:(?:[0-9a-fA-F]{1,4}:)*(?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*))(?![\w:])/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/\d{1,2})?\b/g;

const TS_ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const TS_CLF = /\[\d{2}\/[A-Za-z]{3}\/\d{4}(?::\d{2}){3}\s[+-]\d{4}\]/g;
const TS_HTTP = /\b[A-Z][a-z]{2},\s\d{2}\s[A-Z][a-z]{2}\s\d{4}\s\d{2}:\d{2}:\d{2}\s(?:GMT|UTC|[+-]\d{4})\b/g;
const TS_SYSLOG = /\b[A-Z][a-z]{2}\s{1,2}\d{1,2}\s\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const TS_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{2}\/\d{2}\/\d{4}\b/g;
const TS_EPOCH = /\b1\d{9}(?:\d{3})?\b/g;
const TS_CLOCK = /\b\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b/g;

const DUR_ISO = /\bP(?=[\dT])(?:\d+(?:\.\d+)?[YMWD])*(?:T(?:\d+(?:\.\d+)?[HMS])+)?\b/g;
const DUR_GO = /\b\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h)(?:\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h))*\b/g;

const WIN_PATH = /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s]+\\?)+/g;
const UNIX_PATH = /(?<![\w~])\/[A-Za-z0-9._+@%~-]+(?:\/[A-Za-z0-9._+@%~-]+)*\/?/g;

const DQ_RE = /"(?:[^"\\\n]|\\.)*"/g;
const BT_RE = /`(?:[^`\\\n]|\\.)*`/g;
const SQ_RE = /(?<![A-Za-z0-9])'(?:[^'\\\n]|\\.){0,200}'(?![A-Za-z0-9])/g;

const HEX_RE = /\b(?:0x[0-9a-fA-F]+|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,})\b/g;
const OPAQUE_ID_RE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g;

// Excludes matches bounded by '<'/'>' so the earlier <IP6> placeholder (the
// only placeholder token containing a digit) is not re-split by this pass
// into "IP" + "<N>" on a second look at the same string.
const SUFFIX_INDEX_RE = /(?<!<)\b([A-Za-z][A-Za-z_-]{1,})(\d{1,6})\b(?!>)/g;

const VER_RE = /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g;

const SIG_KV =
  /\b(status(?:_?code)?|http_status|statusCode|rc|exit(?:_?code)?|exitCode|code|errno|signal)(\s*[=:]\s*|\s+)(-?\d{1,3})\b/gi;
const SIG_HTTP = /\b(HTTP\/\d(?:\.\d)?)("?\s+)([1-5]\d{2})\b/g;
const SIG_METHOD = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(\s+\S+\s+)([1-5]\d{2})\b/g;
const SIG_PHRASE = /\b(exited with|exit status|exit code|terminated with|killed with signal|signal)(\s+)(-?\d{1,3})\b/gi;

// The second lookbehind alternative excludes a sentinel-wrapped sign: without
// it, "<SENTINEL>-1<SENTINEL>" still lets NUM_RE start at the digit (preceded
// by '-', not by \w/./SENTINEL) and replace "1" alone, leaving "-" unprotected.
const NUM_RE = new RegExp(`(?<![\\w.]|${SENTINEL}[+-]?)[+-]?\\d+(?:[.,]\\d+)*(?:[eE][+-]?\\d+)?`, 'g');

const SENTINEL_RE = new RegExp(SENTINEL, 'g');

const RUN_CSV = /(<[A-Z0-9]+>)(?:\s*,\s*\1){2,}/g;
const RUN_WS = /(<[A-Z0-9]+>)(?:\s+\1){2,}/g;

const WHITESPACE_RE = /\s+/g;

export const SHAPE_PASSES: readonly ShapePass[] = [
  { name: 'ansi', placeholder: null, pattern: ANSI_RE },
  { name: 'control', placeholder: null, pattern: CONTROL_RE },
  { name: 'url', placeholder: '<URL>', pattern: URL_RE },
  { name: 'email', placeholder: '<EMAIL>', pattern: EMAIL_RE },
  { name: 'uuid', placeholder: '<UUID>', pattern: UUID_RE },
  { name: 'mac', placeholder: '<MAC>', pattern: MAC_RE },
  { name: 'ipv6', placeholder: '<IP6>', pattern: IPV6_RE },
  { name: 'ipv4', placeholder: '<IP>', pattern: IPV4_RE },
  { name: 'ts-iso', placeholder: '<TS>', pattern: TS_ISO },
  { name: 'ts-clf', placeholder: '<TS>', pattern: TS_CLF },
  { name: 'ts-http', placeholder: '<TS>', pattern: TS_HTTP },
  { name: 'ts-syslog', placeholder: '<TS>', pattern: TS_SYSLOG },
  { name: 'ts-date', placeholder: '<TS>', pattern: TS_DATE },
  { name: 'ts-epoch', placeholder: '<TS>', pattern: TS_EPOCH },
  { name: 'ts-clock', placeholder: '<TS>', pattern: TS_CLOCK },
  { name: 'dur-iso', placeholder: '<DUR>', pattern: DUR_ISO },
  { name: 'dur-go', placeholder: '<DUR>', pattern: DUR_GO },
  { name: 'path-win', placeholder: '<PATH>', pattern: WIN_PATH },
  { name: 'path-unix', placeholder: '<PATH>', pattern: UNIX_PATH },
  { name: 'sig-kv', placeholder: null, pattern: SIG_KV },
  { name: 'sig-http', placeholder: null, pattern: SIG_HTTP },
  { name: 'sig-method', placeholder: null, pattern: SIG_METHOD },
  { name: 'sig-phrase', placeholder: null, pattern: SIG_PHRASE },
  { name: 'quote-double', placeholder: '<STR>', pattern: DQ_RE },
  { name: 'quote-backtick', placeholder: '<STR>', pattern: BT_RE },
  { name: 'quote-single', placeholder: '<STR>', pattern: SQ_RE },
  { name: 'hex', placeholder: '<HEX>', pattern: HEX_RE },
  { name: 'opaque-id', placeholder: '<ID>', pattern: OPAQUE_ID_RE },
  { name: 'suffix-index', placeholder: null, pattern: SUFFIX_INDEX_RE },
  { name: 'version', placeholder: '<VER>', pattern: VER_RE },
  { name: 'number', placeholder: '<N>', pattern: NUM_RE },
  { name: 'sentinel-strip', placeholder: null, pattern: SENTINEL_RE },
  { name: 'run-csv', placeholder: null, pattern: RUN_CSV },
  { name: 'run-ws', placeholder: null, pattern: RUN_WS },
  { name: 'whitespace', placeholder: null, pattern: WHITESPACE_RE },
];

export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

export function isPlaceholder(token: string): boolean {
  const base = token.endsWith('+') ? token.slice(0, -1) : token;
  return PLACEHOLDER_TOKENS.has(base);
}

export function literalRatio(template: string): number {
  const tokens = template.length === 0 ? [] : template.split(WHITESPACE_RE).filter((tok) => tok.length > 0);
  let literalChars = 0;
  let totalChars = 0;
  for (const token of tokens) {
    totalChars += token.length;
    if (!isPlaceholder(token) && token !== '<TRUNC>') {
      literalChars += token.length;
    }
  }
  return totalChars === 0 ? 0 : literalChars / totalChars;
}

function maskKeyValueToken(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : `${token.slice(0, eq + 1)}*`;
}

export function coarsenTemplate(template: string, keepTokens = 4): string {
  const tokens = template.length === 0 ? [] : template.split(WHITESPACE_RE).filter((tok) => tok.length > 0);
  const literalTokens = tokens.filter((tok) => !isPlaceholder(tok) && tok !== '<TRUNC>');
  const kept = literalTokens.slice(0, keepTokens).map(maskKeyValueToken);
  return `~${kept.join(' ')}`;
}

export function shapeIdForTemplate(template: string): string {
  const hash = createHash('sha256')
    .update(`${SHAPE_NORMALIZER_VERSION}${String.fromCharCode(0x1f)}${template}`)
    .digest('hex');
  return hash.slice(0, SHAPE_ID_LENGTH);
}

function isSignificantNumber(numStr: string): boolean {
  const n = Number(numStr);
  return Number.isFinite(n) && n >= -599 && n <= 599;
}

function protectSignificant(text: string): string {
  let result = text;
  result = result.replace(SIG_KV, (match: string, key: string, sep: string, num: string) =>
    isSignificantNumber(num) ? `${key}${sep}${SENTINEL}${num}${SENTINEL}` : match,
  );
  result = result.replace(SIG_HTTP, (match: string, proto: string, sep: string, num: string) =>
    isSignificantNumber(num) ? `${proto}${sep}${SENTINEL}${num}${SENTINEL}` : match,
  );
  result = result.replace(SIG_METHOD, (match: string, method: string, mid: string, num: string) =>
    isSignificantNumber(num) ? `${method}${mid}${SENTINEL}${num}${SENTINEL}` : match,
  );
  result = result.replace(SIG_PHRASE, (match: string, phrase: string, sep: string, num: string) =>
    isSignificantNumber(num) ? `${phrase}${sep}${SENTINEL}${num}${SENTINEL}` : match,
  );
  return result;
}

function parseCapturedNumber(text: string): number {
  return Number(text.replace(/,/g, ''));
}

function suffixIndexPass(text: string): string {
  return text.replace(SUFFIX_INDEX_RE, (match: string, word: string) =>
    SUFFIX_INDEX_KEEP.has(match.toLowerCase()) ? match : `${word}<N>`,
  );
}

function runValuePipeline(text: string, numbersOut: number[]): string {
  let t = text;
  t = t.replace(URL_RE, '<URL>');
  t = t.replace(EMAIL_RE, '<EMAIL>');
  t = t.replace(UUID_RE, '<UUID>');
  t = t.replace(MAC_RE, '<MAC>');
  t = t.replace(IPV6_RE, '<IP6>');
  t = t.replace(IPV4_RE, '<IP>');
  t = t.replace(TS_ISO, '<TS>');
  t = t.replace(TS_CLF, '<TS>');
  t = t.replace(TS_HTTP, '<TS>');
  t = t.replace(TS_SYSLOG, '<TS>');
  t = t.replace(TS_DATE, '<TS>');
  t = t.replace(TS_EPOCH, '<TS>');
  t = t.replace(TS_CLOCK, '<TS>');
  t = t.replace(DUR_ISO, '<DUR>');
  t = t.replace(DUR_GO, '<DUR>');
  t = t.replace(WIN_PATH, '<PATH>');
  t = t.replace(UNIX_PATH, '<PATH>');
  // Runs before the quote passes: in CLF access logs the status code sits outside the
  // quoted request line ("GET ... HTTP/1.1" 200), so a quote pass running first would
  // consume that span and leave SIG_HTTP/SIG_METHOD nothing to anchor on.
  t = protectSignificant(t);
  t = t.replace(DQ_RE, '<STR>');
  t = t.replace(BT_RE, '<STR>');
  t = t.replace(SQ_RE, '<STR>');
  t = t.replace(HEX_RE, '<HEX>');
  t = t.replace(OPAQUE_ID_RE, '<ID>');
  t = suffixIndexPass(t);
  t = t.replace(VER_RE, '<VER>');
  t = t.replace(NUM_RE, (match: string) => {
    if (numbersOut.length < MAX_CAPTURED_NUMBERS) {
      const parsed = parseCapturedNumber(match);
      if (Number.isFinite(parsed)) {
        numbersOut.push(parsed);
      }
    }
    return '<N>';
  });
  t = t.replace(SENTINEL_RE, '');
  t = t.replace(RUN_CSV, '$1+');
  t = t.replace(RUN_WS, '$1+');
  t = t.replace(WHITESPACE_RE, ' ').trim();
  return t;
}

function truncateTemplate(template: string): { readonly template: string; readonly truncated: boolean } {
  if (template.length <= SHAPE_TEMPLATE_MAX_CHARS) {
    return { template, truncated: false };
  }
  const cut = template.slice(0, SHAPE_TEMPLATE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace >= 0 ? cut.slice(0, lastSpace) : cut;
  return { template: `${base}<TRUNC>`, truncated: true };
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function renderJsonValue(key: string, value: unknown, depth: number, numbersOut: number[]): string {
  const significant = SIGNIFICANT_JSON_KEYS.includes(key);
  if (typeof value === 'string') {
    return significant ? runValuePipeline(value, numbersOut) : '<STR>';
  }
  if (typeof value === 'number') {
    if (!significant) {
      return '<N>';
    }
    const numStr = String(value);
    // A bare number has no surrounding phrase for protectSignificant to anchor on,
    // so the significance check runs directly instead of via the regex pipeline.
    return isSignificantNumber(numStr) ? numStr : runValuePipeline(numStr, numbersOut);
  }
  if (typeof value === 'boolean') {
    return '<BOOL>';
  }
  if (value === null) {
    return '<NULL>';
  }
  if (Array.isArray(value)) {
    return '<ARR>';
  }
  if (significant && depth < 1) {
    return `{${buildJsonEntries(value as Record<string, unknown>, depth + 1, numbersOut)}}`;
  }
  return '<OBJ>';
}

function buildJsonEntries(obj: Record<string, unknown>, depth: number, numbersOut: number[]): string {
  const keys = Object.keys(obj).sort();
  return keys.map((key) => `${key}=${renderJsonValue(key, obj[key], depth, numbersOut)}`).join(',');
}

function fallbackShape(raw: string): NormalizedShape {
  const folded = raw.replace(WHITESPACE_RE, ' ').trim();
  const truncated = folded.length > SHAPE_TEMPLATE_MAX_CHARS;
  const template = truncated ? folded.slice(0, SHAPE_TEMPLATE_MAX_CHARS) : folded;
  return {
    template,
    shapeId: shapeIdForTemplate(template),
    placeholderCount: 0,
    tokenCount: template.length === 0 ? 0 : template.split(WHITESPACE_RE).length,
    truncated,
    viaJson: false,
    numbers: [],
  };
}

function normalizeInner(raw: string): NormalizedShape {
  let truncatedInput = false;
  let s = raw;
  if (s.length > SHAPE_INPUT_MAX_CHARS) {
    s = s.slice(0, SHAPE_INPUT_MAX_CHARS);
    truncatedInput = true;
  }
  s = s.replace(ANSI_RE, '').replace(CONTROL_RE, '');

  const trimmed = s.trim();
  const numbers: number[] = [];
  let template: string;
  let viaJson = false;

  const jsonCandidate =
    trimmed.startsWith('{') && Buffer.byteLength(trimmed, 'utf8') <= JSON_FAST_PATH_MAX_BYTES
      ? tryParseJsonObject(trimmed)
      : null;

  if (jsonCandidate !== null) {
    viaJson = true;
    const body = buildJsonEntries(jsonCandidate, 0, numbers);
    let jsonTemplate = `json{${body}}`;
    jsonTemplate = jsonTemplate.replace(RUN_CSV, '$1+').replace(RUN_WS, '$1+');
    template = jsonTemplate.replace(WHITESPACE_RE, ' ').trim();
  } else {
    template = runValuePipeline(s, numbers);
  }

  const { template: finalTemplate, truncated: templateTruncated } = truncateTemplate(template);
  const tokens = finalTemplate.length === 0 ? [] : finalTemplate.split(WHITESPACE_RE).filter((tok) => tok.length > 0);
  const placeholderCount = tokens.filter((tok) => isPlaceholder(tok)).length;

  return {
    template: finalTemplate,
    shapeId: shapeIdForTemplate(finalTemplate),
    placeholderCount,
    tokenCount: tokens.length,
    truncated: truncatedInput || templateTruncated,
    viaJson,
    numbers: numbers.slice(0, MAX_CAPTURED_NUMBERS),
  };
}

export function normalizeLogLine(line: string): NormalizedShape {
  try {
    return normalizeInner(line);
  } catch {
    return fallbackShape(line);
  }
}
