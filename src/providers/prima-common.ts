/**
 * Shared low-level helpers for the iPrima provider family, ported from the
 * upstream Java plugins `media_engine.iprima` (PrimaCommon.java, IPrimaHelper.java).
 *
 * Only the pieces that are actually needed by this headless port are kept:
 *  - the Nuxt `__NUXT_DATA__` "devalue" decoder (PrimaCommon.Nuxt.Parser),
 *  - the iPrima JSON-RPC client (PrimaCommon.RPC),
 *  - small dotted-path JSON accessors mirroring `JSON.JSONCollection#getString/getInt/...`.
 */
import { at, bracketSubstring, fetchText } from './common.ts';
import { SessionRejected } from './account-session.ts';

export class PrimaMessageError extends Error {}
export class PrimaAuthError extends Error {}

/** Dotted-path getter mirroring `JSONCollection#get*(path, default)`. */
export function get<T>(obj: unknown, path: string, fallback: T): T {
  return at<T>(obj, path) ?? fallback;
}

export function has(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== undefined;
}

/**
 * Ports `PrimaCommon.Nuxt`, i.e. decoding of the `<script id="__NUXT_DATA__">` payload,
 * which uses Nuxt's "devalue" reference-table encoding: a flat JSON array where each
 * entry is either a raw value or a tagged reference (`["Set", refs...]`, `["Map", ...]`, etc.)
 * resolved lazily by index.
 */
export class Nuxt {
  private readonly rootValue: Record<string, unknown>;

  private constructor(root: Record<string, unknown>) {
    this.rootValue = root;
  }

  static extract(html: string): Nuxt | null {
    const markerIndex = html.indexOf('id="__NUXT_DATA__"');
    if (markerIndex < 0) return null;
    const arrayStart = html.indexOf('[', markerIndex);
    if (arrayStart < 0) return null;

    const payload = bracketSubstring(html, arrayStart, '[', ']');
    if (!payload) throw new Error('Nuxt payload is not a complete array');
    const raw = JSON.parse(payload) as unknown[];
    const decoded = Nuxt.decode(raw);

    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Nuxt payload root is not an object');
    }

    return new Nuxt(decoded as Record<string, unknown>);
  }

  /** Ports `Nuxt.Parser#o` / `#ty`: resolves the reference table starting at index 0. */
  private static decode(raw: unknown[]): unknown {
    const cache: unknown[] = new Array(raw.length);
    const resolved = new Array(raw.length).fill(false) as boolean[];

    function resolve(index: number): unknown {
      if (index === -1 || index === -2) return undefined;
      if (index === -3) return NaN;
      if (index === -4) return Infinity;
      if (index === -5) return -Infinity;
      if (index === -6) return -0;
      if (resolved[index]) return cache[index];

      const entry = raw[index];

      if (entry === null || typeof entry !== 'object') {
        resolved[index] = true;
        cache[index] = entry;
        return entry;
      }

      resolved[index] = true; // Mark before recursing to tolerate self/back references.

      if (Array.isArray(entry)) {
        const first = entry[0];

        if (typeof first === 'string') {
          switch (first) {
            case 'Reactive': {
              const value = resolve(entry[1] as number);
              cache[index] = value;
              return value;
            }
            case 'Date': {
              cache[index] = entry[1];
              return cache[index];
            }
            case 'Set': {
              const set = new Set<unknown>();
              cache[index] = set;
              for (let i = 1; i < entry.length; i++) set.add(resolve(entry[i] as number));
              return set;
            }
            case 'Map':
            case 'null': {
              const obj: Record<string, unknown> = {};
              cache[index] = obj;
              for (let i = 1; i < entry.length; i += 2) {
                const key = resolve(entry[i] as number);
                obj[String(key)] = resolve(entry[i + 1] as number);
              }
              return obj;
            }
            case 'RegExp': {
              cache[index] = entry;
              return entry;
            }
            case 'Object':
            case 'BigInt': {
              cache[index] = entry[1];
              return cache[index];
            }
            default:
              throw new Error(`Unknown Nuxt payload type '${first}'`);
          }
        } else {
          const arr: unknown[] = new Array(entry.length);
          cache[index] = arr;
          for (let i = 0; i < entry.length; i++) {
            const ref = entry[i] as number;
            if (ref !== -2) arr[i] = resolve(ref);
          }
          return arr;
        }
      } else {
        const obj: Record<string, unknown> = {};
        cache[index] = obj;
        for (const [key, ref] of Object.entries(entry as Record<string, number>)) {
          obj[key] = resolve(ref);
        }
        return obj;
      }
    }

    return resolve(0);
  }

  root(): Record<string, unknown> { return this.rootValue; }
  data(): Record<string, unknown> { return get(this.rootValue, 'data', {} as Record<string, unknown>); }
  state(): Record<string, unknown> { return get(this.rootValue, 'state', {} as Record<string, unknown>); }
}

/** Recursively searches a decoded Nuxt tree for the value stored under object key `name`. */
export function findByKey(node: unknown, name: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;

  if (!Array.isArray(node) && name in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>)[name];
  }

  const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
  for (const child of children) {
    const found = findByKey(child, name);
    if (found !== undefined) return found;
  }

  return undefined;
}

/** Ports `PrimaCommon.RPC`: the iPrima JSON-RPC gateway used by Prima+ (`www` subdomain). */
export class PrimaRpc {
  private static readonly ENDPOINT = 'https://gateway-api.prod.iprima.cz/json-rpc/';

  static async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      id: 'web-1',
      jsonrpc: '2.0',
      method,
      // Upstream always nulls this field explicitly regardless of the call.
      params: { ...params, profileId: null },
    });

    const text = await fetchText(PrimaRpc.ENDPOINT, signal, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
    });

    const json = JSON.parse(text) as Record<string, unknown>;
    const result = (get(json, 'result', null) as Record<string, unknown> | null) ?? json;
    const message = get<string>(result, 'error.message', '');
    if (message === 'AccessToken is not valid.') throw new SessionRejected(message);
    return result;
  }

  static isError(json: Record<string, unknown>): boolean {
    return has(json, 'error');
  }
}

/** Ports `IPrimaHelper.PlayIdExtractor`. */
const PLAYER_INIT_RE =
  /['"]DOMContentLoaded['"],[^{]+\{(?:(?!initPlayerLauncher)[\s\S])+initPlayerLauncher\(\d+,\s*['"]([^'"]+)['"]/;

export function extractPlayIds(html: string, $scripts: string[]): string[] {
  for (const content of $scripts) {
    const match = PLAYER_INIT_RE.exec(content);
    if (match) return match[1]!.split(',');
  }
  return [];
}

export function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}
