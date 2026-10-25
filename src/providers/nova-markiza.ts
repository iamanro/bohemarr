import type { Provider, ProviderConfig } from '../types.ts';
import { createNovaArchiveProvider, type NovaArchiveSite } from './nova-markiza-nova.ts';
import { createTNCZProvider } from './nova-markiza-tncz.ts';
import { createMarkizaVoyoProvider, markizaVoyoCredentialsPresent } from './nova-markiza-voyo.ts';

/**
 * Ported from the Nova/Markiza default-plugin family:
 *  - `media_engine.novaplus`    (tv.nova.cz)          + `drm_engine.novaplus`
 *  - `media_engine.tncz`        (tn.nova.cz)
 *  - `media_engine.markizaplus` (www.markiza.sk)
 *  - `media_engine.markizavoyo` (voyo.markiza.sk)     + `drm_engine.markizavoyo`
 *
 * `novaplus` and `markizaplus` share byte-identical upstream Java (only
 * URLs/selectors/regex differ) and are driven by the generic
 * `createNovaArchiveProvider` engine in `nova-markiza-nova.ts`.
 *
 * DRM: only `novaplus` (host `tv.nova.cz`) and `markizavoyo` (host
 * `voyo.markiza.sk`) ever had a matching upstream `drm_engine.*` registered
 * (`DRMEngine#isCompatibleURI` is matched against the *page* host that
 * produced the media, confirmed by `drm_engine.iprima` matching
 * `iprima.cz` — the site's own page host, not its CDN). `tncz` and
 * `markizaplus` never got one, even though their player config can carry a
 * `contentProtection` token for DASH tracks; such tracks are still surfaced
 * (matching the Java code, which builds the media entry regardless of
 * whether a compatible engine exists) but without a `.drm` license, since
 * inventing one would be dishonest. In practice both list only VOYO-free
 * archive content, so encrypted tracks should be rare there.
 */

const NOVAPLUS_SITE: NovaArchiveSite = {
  id: 'novaplus',
  name: 'TV Nova',
  host: 'tv.nova.cz',
  programsUrl: 'https://tv.nova.cz/porady',
  episodeListUrl: (contentId, offset) =>
    `https://tv.nova.cz/api/v1/mixed/more?page=0&offset=${offset}&content=${encodeURIComponent(contentId)}`,
  selPrograms: ':not(.tab-content) > .c-show-wrapper > .c-show',
  programTitleSelector: '.title',
  selEpisodes: ".c-article-wrapper [class^='col-'] .c-article",
  selEpisodesLoadMore: '.js-article-load-more .c-button',
  selPlayerIframe: 'iframe[data-video-id]',
  iframeAttr: 'data-src',
  selLabelVoyo: '.c-badge',
  episodeNumberRegex: /(?:(?:\s+[-\u2013\u2014]|\s*:)\s+)?(\d+)\.\s+díl(?:\s+[-\u2013\u2014]\s+)?/iu,
  episodePaths: ['videa/reprizy', 'videa/cele-dily'],
  drmReferer: 'https://media.cms.nova.cz/',
  contentParamFallback: true,
};

const MARKIZAPLUS_SITE: NovaArchiveSite = {
  id: 'markizaplus',
  name: 'Markíza',
  host: 'www.markiza.sk',
  programsUrl: 'https://www.markiza.sk/relacie',
  episodeListUrl: (contentId, offset) =>
    `https://www.markiza.sk/api/v1/mixed/more?page=0&offset=${offset}&content=${encodeURIComponent(contentId)}`,
  selPrograms: ':not(.tab-content) > .c-show-wrapper > .c-show',
  programTitleSelector: 'h3',
  selEpisodes: ".c-article-wrapper [class^='col-']",
  selEpisodesLoadMore: '.js-article-load-more .c-button',
  selPlayerIframe: 'iframe[data-video-id]',
  // Java reads the `src` attribute, but a live fetch (2026-09-29) shows
  // markiza.sk now lazy-loads the player iframe via `data-src` (like
  // novaplus already did upstream); `src` is empty on the current markup.
  iframeAttr: 'data-src',
  selLabelVoyo: '.c-badge',
  episodeNumberRegex: /(?:(?:\s+[-\u2013\u2014]|\s*:)\s+)?(\d+)\.\s+epizóda(?:\s+[-\u2013\u2014]\s+)?/iu,
  episodePaths: ['videa/cele-epizody'],
  contentParamFallback: false,
};

export function createNovaMarkizaProviders(configs: Record<string, ProviderConfig>): Provider[] {
  const providers: Provider[] = [];

  if (configs['novaplus']?.enabled !== false) providers.push(createNovaArchiveProvider(NOVAPLUS_SITE));
  if (configs['tncz']?.enabled !== false) providers.push(createTNCZProvider());
  if (configs['markizaplus']?.enabled !== false) providers.push(createNovaArchiveProvider(MARKIZAPLUS_SITE));

  const voyoConfig = configs['markizavoyo'];
  if (voyoConfig?.enabled !== false && voyoConfig && markizaVoyoCredentialsPresent(voyoConfig)) {
    providers.push(createMarkizaVoyoProvider(voyoConfig));
  }

  return providers;
}
