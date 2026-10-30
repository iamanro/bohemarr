import type { ArrConfig, Config, ScryerConfig } from './types.ts';

/** The name of the indexer and download client Bohemarr owns in Sonarr and Radarr. */
const NAME = 'Bohemarr';
/** Series and movies with this tag get a Delay Profile without torrent delay. */
const TAG = 'bohemarr';
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;

interface Field {
  name: string;
  value?: unknown;
}
interface Provider {
  id?: number;
  name: string;
  implementation: string;
  fields: Field[];
  [key: string]: unknown;
}

const APPS = {
  sonarr: {
    label: 'Sonarr',
    categoryField: 'tvCategory',
    searchCategories: [5000],
    naming: {
      renameEpisodes: true,
      replaceIllegalCharacters: true,
      standardEpisodeFormat: '{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} [{Quality Full}]',
      dailyEpisodeFormat: '{Series TitleYear} - {Air-Date} - {Episode CleanTitle} [{Quality Full}]',
      seriesFolderFormat: '{Series TitleYear} [tvdbid-{TvdbId}]',
      seasonFolderFormat: 'Season {season:00}',
    },
  },
  radarr: {
    label: 'Radarr',
    categoryField: 'movieCategory',
    searchCategories: [2000],
    naming: {
      renameMovies: true,
      replaceIllegalCharacters: true,
      standardMovieFormat: '{Movie CleanTitle} ({Release Year}) [{Quality Full}]',
      movieFolderFormat: '{Movie CleanTitle} ({Release Year}) [tmdbid-{TmdbId}]',
    },
  },
} as const;

/** The outcome of the last setup attempt of each application, for the web UI. */
export const arrStatus = new Map<string, { ok: boolean; message: string; at: string }>();

class ArrError extends Error {}

/**
 * Keeps one Sonarr or Radarr pointed at this instance: a qBittorrent download client and a Torznab
 * indexer named Bohemarr, a Delay Profile without torrent delay for the `bohemarr` tag, a Webhook
 * connection named Bohemarr while publishing to Vltava and, when configured, the root folder. Each
 * start reapplies these settings; anything else is left alone.
 */
async function configureArr(config: Config, arr: ArrConfig, signal: AbortSignal): Promise<void> {
  const app = APPS[arr.app];
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${arr.url}/api/v3/${path}`, {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      headers: { 'X-Api-Key': arr.apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      // Validation failures are an array of { propertyName, errorMessage }.
      let detail = text;
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) detail = parsed.map(failure => failure.errorMessage).join('; ');
        else if (parsed && typeof parsed === 'object' && 'message' in parsed) detail = String(parsed.message);
      } catch {
        /* not JSON */
      }
      throw new ArrError(`${method} ${path}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  /** Creates or updates the provider named Bohemarr in `kind`, starting from the schema when it is new. */
  const save = async (
    kind: string,
    implementation: string,
    values: Record<string, unknown>,
    properties: Record<string, unknown>,
  ): Promise<Provider> => {
    const existing = (await request<Provider[]>('GET', kind)).find(item => item.name === NAME);
    const base = existing ?? (await request<Provider[]>('GET', `${kind}/schema`)).find(item => item.implementation === implementation);
    if (!base) throw new ArrError(`${app.label} has no ${implementation} ${kind} implementation`);
    if (existing && existing.implementation !== implementation) {
      throw new ArrError(`${app.label} already has a ${kind} named ${NAME} of type ${existing.implementation}; rename or remove it`);
    }
    const fields = base.fields.map(field => (field.name in values ? { ...field, value: values[field.name] } : field));
    const missing = Object.keys(values).filter(name => !fields.some(field => field.name === name));
    if (missing.length) throw new ArrError(`${app.label} ${implementation} has no fields ${missing.join(', ')}`);
    const resource = { ...base, ...properties, name: NAME, fields };
    return existing ? request<Provider>('PUT', `${kind}/${existing.id}`, resource) : request<Provider>('POST', kind, resource);
  };

  await request('GET', 'system/status');
  const publicUrl = new URL(config.publicUrl);
  const client = await save(
    'downloadclient',
    'QBittorrent',
    {
      host: publicUrl.hostname,
      port: Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80)),
      useSsl: publicUrl.protocol === 'https:',
      urlBase: '',
      username: 'bohemarr',
      password: config.apiKey,
      [app.categoryField]: arr.category,
    },
    { enable: true, protocol: 'torrent', removeCompletedDownloads: arr.removeCompleted, removeFailedDownloads: true },
  );
  // The indexer sends its grabs to this client, never to another torrent client of the same application.
  await save(
    'indexer',
    'Torznab',
    {
      baseUrl: config.publicUrl,
      apiPath: '/api',
      apiKey: config.apiKey,
      categories: app.searchCategories,
    },
    { enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, protocol: 'torrent', downloadClientId: client.id },
  );

  const tags = await request<Array<{ id: number; label: string }>>('GET', 'tag');
  const tag = tags.find(item => item.label === TAG) ?? (await request<{ id: number }>('POST', 'tag', { label: TAG }));
  const profiles = await request<Array<Record<string, unknown> & { id: number; tags: number[] }>>('GET', 'delayprofile');
  const profile = profiles.find(item => item.tags.includes(tag.id) && item.id !== 1);
  const delay = { enableTorrent: true, torrentDelay: 0 };
  if (!profile) {
    await request('POST', 'delayprofile', {
      enableUsenet: true,
      usenetDelay: 0,
      preferredProtocol: 'torrent',
      bypassIfHighestQuality: true,
      ...delay,
      tags: [tag.id],
    });
  } else if (profile.enableTorrent !== true || profile.torrentDelay !== 0) {
    await request('PUT', `delayprofile/${profile.id}`, { ...profile, ...delay });
  }

  // Imports reach the Vltava publisher through a Webhook connection; without publishing it is removed.
  if (config.vltava) {
    await save(
      'notification',
      'Webhook',
      {
        url: `${config.publicUrl}/hooks/arr?apikey=${encodeURIComponent(config.apiKey)}`,
        method: 1,
      },
      { onDownload: true, onUpgrade: true },
    );
  } else {
    const existing = (await request<Provider[]>('GET', 'notification')).find(
      item => item.name === NAME && item.implementation === 'Webhook',
    );
    if (existing) await request('DELETE', `notification/${existing.id}`);
  }

  if (arr.rename) {
    const naming = await request<{ id: number }>('GET', 'config/naming');
    await request('PUT', `config/naming/${naming.id}`, { ...naming, ...app.naming });
  }

  if (arr.rootFolder) {
    const folders = await request<Array<{ path: string }>>('GET', 'rootfolder');
    const normalized = (path: string) => path.replace(/\/+$/, '');
    if (!folders.some(folder => normalized(folder.path) === normalized(arr.rootFolder!))) {
      await request('POST', 'rootfolder', { path: arr.rootFolder });
    }
  }
}

interface ScryerItem {
  id: string;
  name: string;
}
interface ScryerRoute {
  clientId: string;
  [field: string]: unknown;
}

/** Scryer's content scopes and the category Bohemarr keeps their downloads in. */
const SCRYER_SCOPES = { SERIES: 'tv', ANIME: 'tv', MOVIE: 'movies' } as const;

/**
 * Keeps Scryer pointed at this instance through its GraphQL API: a qBittorrent download client and a
 * Torznab indexer named Bohemarr that sends its grabs to that client, and routing that puts series and
 * anime in category tv and movies in movies. Without that routing Scryer sends its scope name as the
 * category (`series`), which Bohemarr refuses. Anything else is left alone.
 */
async function configureScryer(config: Config, scryer: ScryerConfig, signal: AbortSignal): Promise<void> {
  const graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(`${scryer.url}/graphql`, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      headers: { Authorization: `Bearer ${scryer.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    let parsed: { data?: T | null; errors?: Array<{ message: string }> } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (parsed.errors?.length || !parsed.data) {
      const detail = parsed.errors?.map(error => error.message).join('; ') || text.slice(0, 500);
      throw new ArrError(`GraphQL ${query.split(/[\s($]/, 2)[1]}: HTTP ${response.status} ${detail}`);
    }
    return parsed.data;
  };

  const { downloadClientConfigs, indexers } = await graphql<{
    downloadClientConfigs: Array<ScryerItem & { clientType: string }>;
    indexers: Array<ScryerItem & { providerType: string }>;
  }>('query Bohemarr { downloadClientConfigs { id name clientType } indexers { id name providerType } }');

  const existingClient = downloadClientConfigs.find(item => item.name === NAME);
  if (existingClient && existingClient.clientType !== 'qbittorrent') {
    throw new ArrError(`Scryer already has a download client named ${NAME} of type ${existingClient.clientType}; rename or remove it`);
  }
  // The plugin authenticates with the API key as a bearer token, which Bohemarr accepts.
  const client = {
    isEnabled: true,
    config: [
      { key: 'base_url', stringValue: config.publicUrl },
      { key: 'api_key', secretValue: config.apiKey },
      { key: 'routing_mode', stringValue: 'category' },
    ],
  };
  const clientId = existingClient
    ? (
        await graphql<{ updateDownloadClientConfig: ScryerItem }>(
          'mutation UpdateClient($input: UpdateDownloadClientConfigInput!) { updateDownloadClientConfig(input: $input) { id name } }',
          { input: { id: existingClient.id, ...client } },
        )
      ).updateDownloadClientConfig.id
    : (
        await graphql<{ createDownloadClientConfig: ScryerItem }>(
          'mutation CreateClient($input: CreateDownloadClientConfigInput!) { createDownloadClientConfig(input: $input) { id name } }',
          { input: { name: NAME, clientType: 'qbittorrent', ...client } },
        )
      ).createDownloadClientConfig.id;

  const existingIndexer = indexers.find(item => item.name === NAME);
  if (existingIndexer && existingIndexer.providerType !== 'torznab') {
    throw new ArrError(`Scryer already has an indexer named ${NAME} of type ${existingIndexer.providerType}; rename or remove it`);
  }
  const indexer = {
    downloadClientId: clientId,
    isEnabled: true,
    enableAutoSearch: true,
    enableInteractiveSearch: true,
    config: [
      { key: 'base_url', stringValue: config.publicUrl },
      { key: 'api_path', stringValue: '/api' },
      { key: 'api_key', secretValue: config.apiKey },
    ],
  };
  if (existingIndexer) {
    await graphql('mutation UpdateIndexer($input: UpdateIndexerConfigInput!) { updateIndexerConfig(input: $input) { id } }', {
      input: { id: existingIndexer.id, ...indexer },
    });
  } else {
    await graphql('mutation CreateIndexer($input: CreateIndexerConfigInput!) { createIndexerConfig(input: $input) { id } }', {
      input: { name: NAME, providerType: 'torznab', ...indexer },
    });
  }

  // Each scope's routing is written as a whole list, so the other clients' entries are written back unchanged.
  for (const [scope, category] of Object.entries(SCRYER_SCOPES)) {
    const { downloadClientRouting: routes } = await graphql<{ downloadClientRouting: ScryerRoute[] }>(
      'query Routing($scope: ContentScopeValue!) { downloadClientRouting(scope: $scope) { clientId enabled category recentQueuePriority olderQueuePriority removeCompleted removeFailed seedingProfileId } }',
      { scope },
    );
    const own = routes.find(route => route.clientId === clientId);
    await graphql(
      'mutation UpdateRouting($input: UpdateDownloadClientRoutingInput!) { updateDownloadClientRouting(input: $input) { clientId } }',
      {
        input: {
          scope,
          entries: [
            ...routes.filter(route => route !== own),
            { ...own, clientId, enabled: true, category, removeCompleted: scryer.removeCompleted, removeFailed: true },
          ],
        },
      },
    );
  }
}

/** Configures every Sonarr, Radarr and Scryer in the background, retrying each until it succeeds or `signal` aborts. */
export function configureArrs(config: Config, signal: AbortSignal): Promise<void> {
  const targets = [
    ...config.arrs.map(arr => ({ key: arr.app, label: APPS[arr.app].label, url: arr.url, run: () => configureArr(config, arr, signal) })),
    ...(config.scryer ? [config.scryer] : []).map(scryer => ({
      key: 'scryer',
      label: 'Scryer',
      url: scryer.url,
      run: () => configureScryer(config, scryer, signal),
    })),
  ];
  return Promise.all(
    targets.map(async ({ key, label, url, run }) => {
      for (let delay = FIRST_RETRY_MS; !signal.aborted; delay = Math.min(delay * 2, MAX_RETRY_MS)) {
        try {
          await run();
          arrStatus.set(key, { ok: true, message: 'Configured', at: new Date().toISOString() });
          console.log(`${label} at ${url} is configured for Bohemarr`);
          return;
        } catch (error) {
          if (signal.aborted) return;
          arrStatus.set(key, {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          });
          console.error(
            `${label} setup failed, retrying in ${Math.round(delay / 1000)} s: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }),
  ).then(() => undefined);
}
