import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import cs from 'i18n-iso-countries/langs/cs.json' with { type: 'json' };
import sk from 'i18n-iso-countries/langs/sk.json' with { type: 'json' };
import type { SeriesIdentity, ProgramMetadata } from './types.ts';

for (const locale of [en, cs, sk]) countries.registerLocale(locale);

const SKYHOOK_BASE = 'https://skyhook.sonarr.tv/v1/tvdb/shows/en/';
const LOOKUP_TIMEOUT_MS = 10_000;
const COUNTRY_LOCALES = ['en', 'cs', 'sk'];

/**
 * Common-language country name synonyms that are real, well-documented
 * alternates but are not present in the i18n-iso-countries locale data
 * bundled for these languages. Never a guess: each entry must be a
 * verifiable, widely used alternate name for the mapped ISO 3166-1 country.
 */
const COUNTRY_SYNONYMS: Record<string, string> = {
  'velka britanie': 'GB', // cs: common alternate to the official "Spojené království"
  cr: 'CZ', // Prima's "ČR"; ASCII "CR" is resolved as the Costa Rica ISO code before this fallback.
};

function normalizeCountryToAlpha2(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^[A-Za-z]{2,3}$/.test(trimmed) && countries.isValid(trimmed)) {
    return countries.toAlpha2(trimmed);
  }
  for (const locale of COUNTRY_LOCALES) {
    const code = countries.getSimpleAlpha2Code(trimmed, locale);
    if (code) return code;
  }
  const key = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return COUNTRY_SYNONYMS[key];
}

function normalizeForTokens(value: string): string[] {
  const stripped = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const spaced = stripped.replace(/[()]/g, ' ').replace(/&/g, ' & ');
  return spaced.split(/[^a-z0-9&]+/).filter(Boolean);
}

function arraysStartWith(long: string[], short: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((token, index) => long[index] === token);
}

/** True when every "&"-separated group of tokens resolves to a real country. */
function isRecognizedCountryQualifier(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token === '&') groups.push([]);
    else groups[groups.length - 1]!.push(token);
  }
  if (groups.some(group => group.length === 0)) return false;
  return groups.every(group => normalizeCountryToAlpha2(group.join(' ')) !== undefined);
}

/**
 * Canonical name forms for an identity: the full title/alias tokens, plus,
 * where the trailing words are a recognized geographic qualifier (e.g. a
 * country name, possibly a "&"-joined list of countries), the same tokens
 * with that qualifier stripped. Never strips unrecognized trailing words
 * (spin-off markers such as "After" are left intact).
 */
function extractBaseNames(identity: SeriesIdentity): string[][] {
  const bases = new Map<string, string[]>();
  for (const form of [identity.title, ...identity.aliases]) {
    if (!form || !form.trim()) continue;
    const tokens = normalizeForTokens(form);
    if (tokens.length === 0) continue;
    bases.set(tokens.join(' '), tokens);
    for (let cut = 1; cut < tokens.length; cut++) {
      const remainder = tokens.slice(cut);
      if (isRecognizedCountryQualifier(remainder)) {
        const base = tokens.slice(0, cut);
        bases.set(base.join(' '), base);
        break;
      }
    }
  }
  return [...bases.values()];
}

/**
 * Loose discovery filter: does `title` plausibly refer to `identity`? Used to
 * widen upstream searches, never to store a Series binding. Matching is
 * token-boundary only (never substring-inside-word) in either direction, so
 * both narrower and wider titles than the identity's canonical forms pass.
 */
export function isSeriesCandidate(title: string, identity: SeriesIdentity): boolean {
  const tokens = normalizeForTokens(title);
  if (tokens.length === 0) return false;
  for (const base of extractBaseNames(identity)) {
    if (tokens.join(' ') === base.join(' ')) return true;
    if (arraysStartWith(tokens, base) || arraysStartWith(base, tokens)) return true;
  }
  return false;
}

function isEquivalentTitle(candidateTitle: string, baseNames: string[][]): boolean {
  const tokens = normalizeForTokens(candidateTitle);
  if (tokens.length === 0) return false;
  for (const base of baseNames) {
    if (tokens.join(' ') === base.join(' ')) return true;
    if (tokens.length > base.length && arraysStartWith(tokens, base)) {
      const remainder = tokens.slice(base.length);
      if (isRecognizedCountryQualifier(remainder)) return true;
    }
  }
  return false;
}

function sameMetadata(a: ProgramMetadata, b: ProgramMetadata): boolean {
  const normalizeCountries = (metadata: ProgramMetadata) => [...metadata.countries].map(c => c.trim().toLowerCase()).sort();
  return (
    a.title === b.title &&
    a.year === b.year &&
    JSON.stringify(normalizeCountries(a)) === JSON.stringify(normalizeCountries(b)) &&
    JSON.stringify([...a.aliases].sort()) === JSON.stringify([...b.aliases].sort())
  );
}

/** Why no Program of a provider could be selected for a Series identity. */
export type SelectionFailure = 'no-candidate' | 'identity-incomplete' | 'year-mismatch' | 'country-mismatch' | 'ambiguous';
export type ProgramSelection = { program: ProgramMetadata } | { reason: SelectionFailure };

/**
 * Deterministic, conservative choice of the one Program a Series identity may bind to: its name
 * must be equivalent (only recognized geographic qualifiers may differ), its year must equal the
 * identity's, and its countries must include the identity's. Missing identity evidence,
 * conflicting duplicate records for one Program, or more than one eligible Program selects nothing.
 */
export function selectProgram(identity: SeriesIdentity, candidates: ProgramMetadata[]): ProgramSelection {
  const identityCountry = normalizeCountryToAlpha2(identity.country);
  if (identityCountry === undefined) return { reason: 'identity-incomplete' };
  if (identity.year === undefined || !Number.isFinite(identity.year) || identity.year <= 0) return { reason: 'identity-incomplete' };

  const byId = new Map<string, ProgramMetadata>();
  for (const candidate of candidates) {
    const prior = byId.get(candidate.id);
    if (prior) {
      if (!sameMetadata(prior, candidate)) return { reason: 'ambiguous' };
      continue;
    }
    byId.set(candidate.id, candidate);
  }

  const baseNames = extractBaseNames(identity);
  const named = [...byId.values()].filter(candidate => isEquivalentTitle(candidate.title, baseNames));
  if (!named.length) return { reason: 'no-candidate' };
  const dated = named.filter(candidate => candidate.year === identity.year);
  if (!dated.length) return { reason: 'year-mismatch' };
  const located = dated.filter(candidate => candidate.countries.map(normalizeCountryToAlpha2).includes(identityCountry));
  if (!located.length) return { reason: 'country-mismatch' };
  return located.length === 1 ? { program: located[0]! } : { reason: 'ambiguous' };
}

interface SkyhookAlternativeTitle {
  title?: unknown;
}

interface SkyhookShow {
  tvdbId?: unknown;
  title?: unknown;
  firstAired?: unknown;
  originalCountry?: unknown;
  alternativeTitles?: unknown;
  tmdbId?: unknown;
  tvMazeId?: unknown;
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function loadTvmazeNames(id: number, tvdbId: number, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`https://api.tvmaze.com/shows/${id}`, { signal });
  if (!response.ok) throw new Error(`TVmaze lookup for tvdb ${tvdbId} failed with status ${response.status}`);
  const show = (await response.json()) as { id?: unknown; name?: unknown; externals?: { thetvdb?: unknown } };
  if (show.id !== id || show.externals?.thetvdb !== tvdbId) {
    throw new Error(`Mismatched TVmaze metadata for tvdb ${tvdbId}`);
  }
  if (typeof show.name !== 'string' || !show.name.trim()) throw new Error(`TVmaze returned a missing name for tvdb ${tvdbId}`);
  const aliasesResponse = await fetch(`https://api.tvmaze.com/shows/${id}/akas`, { signal });
  if (!aliasesResponse.ok) throw new Error(`TVmaze aliases for tvdb ${tvdbId} failed with status ${aliasesResponse.status}`);
  const akas: unknown = await aliasesResponse.json();
  if (!Array.isArray(akas)) throw new Error(`TVmaze returned malformed aliases for tvdb ${tvdbId}`);
  const names = [show.name];
  for (const aka of akas as { name?: unknown }[]) {
    if (typeof aka?.name === 'string') names.push(aka.name);
  }
  return names;
}

function parseYear(firstAired: unknown): number | undefined {
  if (typeof firstAired !== 'string') return undefined;
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(firstAired);
  if (!match) return undefined;
  const year = Number(match[1]);
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function parseAliases(alternativeTitles: unknown, title: string, names: readonly string[]): string[] {
  if (!Array.isArray(alternativeTitles)) alternativeTitles = [];
  const seen = new Set<string>([title.trim().toLowerCase()]);
  const aliases: string[] = [];
  for (const entry of alternativeTitles as SkyhookAlternativeTitle[]) {
    const alias = typeof entry?.title === 'string' ? entry.title.trim() : '';
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  for (const name of names) {
    const alias = name.trim();
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

/** Fetches canonical series metadata for a TVDB id from the public Skyhook mirror. */
export async function loadSeriesIdentity(tvdbId: number, signal: AbortSignal): Promise<SeriesIdentity> {
  if (!Number.isSafeInteger(tvdbId) || tvdbId <= 0) {
    throw new RangeError(`Invalid tvdbId: ${tvdbId}`);
  }

  const timeoutSignal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

  const response = await fetch(`${SKYHOOK_BASE}${tvdbId}`, { signal: combinedSignal });
  if (!response.ok) {
    throw new Error(`Skyhook lookup for tvdb ${tvdbId} failed with status ${response.status}`);
  }

  let data: SkyhookShow;
  try {
    data = (await response.json()) as SkyhookShow;
  } catch {
    throw new Error(`Skyhook returned malformed metadata for tvdb ${tvdbId}: invalid JSON`);
  }

  if (typeof data.tvdbId !== 'number' || data.tvdbId !== tvdbId) {
    throw new Error(`Skyhook returned mismatched metadata for tvdb ${tvdbId}`);
  }
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (!title) {
    throw new Error(`Skyhook returned malformed metadata for tvdb ${tvdbId}: missing title`);
  }

  const country = typeof data.originalCountry === 'string' && data.originalCountry.trim() ? data.originalCountry.trim() : undefined;

  const names = positiveId(data.tvMazeId) ? await loadTvmazeNames(data.tvMazeId, tvdbId, combinedSignal) : [];
  const identity: SeriesIdentity = {
    tvdbId,
    title,
    aliases: parseAliases(data.alternativeTitles, title, names),
    year: parseYear(data.firstAired),
    country,
  };
  if (positiveId(data.tmdbId)) identity.tmdbId = data.tmdbId;
  return identity;
}
