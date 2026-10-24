// Headless TypeScript port of seven media-downloader Java plugins:
//  - media_engine.tvprimadoma  (TVPrimaDomaEngine)  - real program/episode catalog + OnNetwork embed
//  - media_engine.tvbarrandov  (TVBarrandovEngine)  - real program/episode catalog + auth + local video/YouTube delegation
//  - media_engine.tvautosalon  (TVAutosalonEngine)  - real program/season/episode catalog + OnNetwork embed
//  - server.rtvs               (STVRServer)          - URL resolver (stvr.sk archive JSON playlists)
//  - server.html5              (HTML5Server)         - generic <video>/<source> URL resolver
//  - server.direct             (DirectServer)        - raw file URL passthrough
//  - server.youtube            (YouTubeServer)       - YouTube adaptive-format resolver (see public-sites-youtube.ts)
//
// The three media_engine.* providers expose real upstream catalogs: `programs()` enumerates
// their program listings, `releases()` enumerates each program's episodes newest first. The
// four server.* providers have no upstream browse capability of their own; their Catalogue
// enumerates no Programs and instead resolves `q` given as a direct, host-validated URL via
// `releaseForUrl`. Static `config.catalog` entries are attached centrally by providers/index.ts.

import type { Provider, ProviderConfig } from '../types.ts';
import { createAutosalonProvider } from './public-sites-autosalon.ts';
import { createBarrandovProvider } from './public-sites-barrandov.ts';
import { createPrimaDomaProvider } from './public-sites-primadoma.ts';
import { createDirectProvider, createHtml5Provider, createStvrProvider, createYouTubeProvider } from './public-sites-url-resolvers.ts';

/** A media_engine.* program: an upstream program listing entry with its own page. */
export interface ScrapedProgram { id: string; title: string; kind: 'tv'; url: string }

export function createPublicSiteProviders(configs: Record<string, ProviderConfig>): Provider[] {
  const config = (id: string): ProviderConfig => configs[id] ?? {};
  const enabled = (id: string): boolean => config(id).enabled !== false;
  const providers: Provider[] = [];
  if (enabled('tvprimadoma')) providers.push(createPrimaDomaProvider());
  if (enabled('tvbarrandov')) providers.push(createBarrandovProvider(config('tvbarrandov'), config('youtube')));
  if (enabled('tvautosalon')) providers.push(createAutosalonProvider());
  if (enabled('stvr')) providers.push(createStvrProvider());
  if (enabled('html5')) providers.push(createHtml5Provider(config('html5')));
  if (enabled('direct')) providers.push(createDirectProvider(config('direct')));
  if (enabled('youtube')) providers.push(createYouTubeProvider(config('youtube')));
  return providers;
}
