/**
 * Factory for the `jojplay` and `sledovanitv` providers. See `joj-sledovani-firestore.ts`
 * (`media_engine.jojplay`) and `joj-sledovani-tv.ts` (`server.sledovanitv` +
 * `drm_engine.sledovanitv`) for the ported implementations.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Provider, ProviderConfig } from '../types.ts';
import { createJojPlayProvider } from './joj-sledovani-firestore.ts';
import { createSledovaniTvProvider } from './joj-sledovani-tv.ts';

export function createJojSledovaniProviders(configs: Record<string, ProviderConfig>, database: DatabaseSync): Provider[] {
  const providers: Provider[] = [];

  const jojConfig = configs.jojplay ?? {};
  if (jojConfig.enabled !== false && typeof jojConfig.username === 'string' && typeof jojConfig.password === 'string') {
    providers.push(createJojPlayProvider(jojConfig.username, jojConfig.password));
  }

  const sledConfig = configs.sledovanitv ?? {};
  if (sledConfig.enabled !== false) {
    const sledovaniProvider = createSledovaniTvProvider(sledConfig, database);
    if (sledovaniProvider) providers.push(sledovaniProvider);
  }

  return providers;
}
