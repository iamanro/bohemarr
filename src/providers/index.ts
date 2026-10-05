import { createPrimaProviders } from './prima.ts';
import { createOneplayProviders } from './oneplay.ts';
import { createCzechPublicProviders } from './czech-public.ts';
import { createNovaMarkizaProviders } from './nova-markiza.ts';
import { createPublicSiteProviders } from './public-sites.ts';
import { createJojSledovaniProviders } from './joj-sledovani.ts';
import type { DatabaseSync } from 'node:sqlite';
import { releaseId } from './common.ts';
import { PROVIDER_IDS } from './ids.ts';
import type { Config, Provider, Release } from '../types.ts';

/** `database` is the service database; providers that keep local state (the Prima+ index, the Stream.cz discovery cache) own tables in it. */
export function createProviders(config: Config, database: DatabaseSync): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const factory of [createPrimaProviders, createOneplayProviders, createCzechPublicProviders,
    createNovaMarkizaProviders, createPublicSiteProviders, createJojSledovaniProviders]) {
    for (const provider of factory(config.providers, database)) {
      if (providers.has(provider.id)) throw new Error(`Duplicate provider ID: ${provider.id}`);
      if (!(PROVIDER_IDS as readonly string[]).includes(provider.id)) throw new Error(`Provider ID missing from PROVIDER_IDS: ${provider.id}`);
      const entries = catalogueEntries(provider.id, config.providers[provider.id]?.catalog);
      providers.set(provider.id, entries.length ? { ...provider, entries } : provider);
    }
  }
  for (const [id, settings] of Object.entries(config.providers)) {
    if (settings.enabled === true && !providers.has(id)) {
      throw new Error(`Provider ${id} could not be enabled; check its name and required credentials`);
    }
  }
  return providers;
}

/** Validates `providers.<id>.catalog`: a malformed entry fails startup instead of every search. */
function catalogueEntries(providerId: string, catalog: unknown): Release[] {
  if (catalog === undefined) return [];
  if (!Array.isArray(catalog)) throw new Error(`providers.${providerId}.catalog must be an array`);
  return catalog.map((entry: Partial<Release>, index): Release => {
    const where = `providers.${providerId}.catalog[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    if (typeof entry.title !== 'string' || !entry.title.trim()) throw new Error(`${where}.title is required`);
    if (entry.kind !== 'tv' && entry.kind !== 'movie') throw new Error(`${where}.kind must be "tv" or "movie"`);
    let url: URL;
    try { url = new URL(String(entry.url)); } catch { throw new Error(`${where}.url must be an absolute URL`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${where}.url must be http(s)`);
    return { ...entry, id: releaseId(providerId, url.href), provider: providerId, title: entry.title, url: url.href, kind: entry.kind };
  });
}
