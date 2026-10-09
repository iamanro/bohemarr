import type { ArrConfig, Config } from './types.ts';

/** The name of the indexer and download client Bohemarr owns in Sonarr and Radarr. */
const NAME = 'Bohemarr';
/** Series and movies with this tag get a Delay Profile without torrent delay. */
const TAG = 'bohemarr';
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;

interface Field { name: string; value?: unknown }
interface Provider { id?: number; name: string; implementation: string; fields: Field[]; [key: string]: unknown }

const APPS = {
  sonarr: { label: 'Sonarr', categoryField: 'tvCategory', searchCategories: [5000] },
  radarr: { label: 'Radarr', categoryField: 'movieCategory', searchCategories: [2000] },
} as const;

class ArrError extends Error {}

/**
 * Keeps one Sonarr or Radarr pointed at this instance: a qBittorrent download client and a Torznab
 * indexer named Bohemarr, a Delay Profile without torrent delay for the `bohemarr` tag, a Webhook
 * connection named Bohemarr while publishing to Vltava and, when configured, the root folder. Each
 * start reapplies these settings; anything else is left alone.
 */
export async function configureArr(config: Config, arr: ArrConfig, signal: AbortSignal): Promise<void> {
  const app = APPS[arr.app];
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${arr.url}/api/v3/${path}`, {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
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
      } catch { /* not JSON */ }
      throw new ArrError(`${method} ${path}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  /** Creates or updates the provider named Bohemarr in `kind`, starting from the schema when it is new. */
  const save = async (kind: string, implementation: string, values: Record<string, unknown>, properties: Record<string, unknown>): Promise<Provider> => {
    const existing = (await request<Provider[]>('GET', kind)).find(item => item.name === NAME);
    const base = existing ?? (await request<Provider[]>('GET', `${kind}/schema`)).find(item => item.implementation === implementation);
    if (!base) throw new ArrError(`${app.label} has no ${implementation} ${kind} implementation`);
    if (existing && existing.implementation !== implementation) {
      throw new ArrError(`${app.label} already has a ${kind} named ${NAME} of type ${existing.implementation}; rename or remove it`);
    }
    const fields = base.fields.map(field => field.name in values ? { ...field, value: values[field.name] } : field);
    const missing = Object.keys(values).filter(name => !fields.some(field => field.name === name));
    if (missing.length) throw new ArrError(`${app.label} ${implementation} has no fields ${missing.join(', ')}`);
    const resource = { ...base, ...properties, name: NAME, fields };
    return existing
      ? request<Provider>('PUT', `${kind}/${existing.id}`, resource)
      : request<Provider>('POST', kind, resource);
  };

  await request('GET', 'system/status');
  const publicUrl = new URL(config.publicUrl);
  const client = await save('downloadclient', 'QBittorrent', {
    host: publicUrl.hostname, port: Number(publicUrl.port || (publicUrl.protocol === 'https:' ? 443 : 80)),
    useSsl: publicUrl.protocol === 'https:', urlBase: '', username: 'bohemarr', password: config.apiKey,
    [app.categoryField]: arr.category,
  }, { enable: true, protocol: 'torrent', removeCompletedDownloads: arr.removeCompleted, removeFailedDownloads: true });
  // The indexer sends its grabs to this client, never to another torrent client of the same application.
  await save('indexer', 'Torznab', {
    baseUrl: config.publicUrl, apiPath: '/api', apiKey: config.apiKey, categories: app.searchCategories,
  }, { enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, protocol: 'torrent', downloadClientId: client.id });

  const tags = await request<Array<{ id: number; label: string }>>('GET', 'tag');
  const tag = tags.find(item => item.label === TAG) ?? await request<{ id: number }>('POST', 'tag', { label: TAG });
  const profiles = await request<Array<Record<string, unknown> & { id: number; tags: number[] }>>('GET', 'delayprofile');
  const profile = profiles.find(item => item.tags.includes(tag.id) && item.id !== 1);
  const delay = { enableTorrent: true, torrentDelay: 0 };
  if (!profile) {
    await request('POST', 'delayprofile', {
      enableUsenet: true, usenetDelay: 0, preferredProtocol: 'torrent', bypassIfHighestQuality: true, ...delay, tags: [tag.id],
    });
  } else if (profile.enableTorrent !== true || profile.torrentDelay !== 0) {
    await request('PUT', `delayprofile/${profile.id}`, { ...profile, ...delay });
  }

  // Imports reach the Vltava publisher through a Webhook connection; without publishing it is removed.
  if (config.vltava) {
    await save('notification', 'Webhook', {
      url: `${config.publicUrl}/hooks/arr?apikey=${encodeURIComponent(config.apiKey)}`, method: 1,
    }, { onDownload: true, onUpgrade: true });
  } else {
    const existing = (await request<Provider[]>('GET', 'notification')).find(item => item.name === NAME && item.implementation === 'Webhook');
    if (existing) await request('DELETE', `notification/${existing.id}`);
  }

  if (arr.rootFolder) {
    const folders = await request<Array<{ path: string }>>('GET', 'rootfolder');
    const normalized = (path: string) => path.replace(/\/+$/, '');
    if (!folders.some(folder => normalized(folder.path) === normalized(arr.rootFolder!))) {
      await request('POST', 'rootfolder', { path: arr.rootFolder });
    }
  }
}

/** Configures every Sonarr and Radarr in the background, retrying each until it succeeds or `signal` aborts. */
export function configureArrs(config: Config, signal: AbortSignal): Promise<void> {
  return Promise.all(config.arrs.map(async arr => {
    const label = APPS[arr.app].label;
    for (let delay = FIRST_RETRY_MS; !signal.aborted; delay = Math.min(delay * 2, MAX_RETRY_MS)) {
      try {
        await configureArr(config, arr, signal);
        console.log(`${label} at ${arr.url} is configured for Bohemarr`);
        return;
      } catch (error) {
        if (signal.aborted) return;
        console.error(`${label} setup failed, retrying in ${Math.round(delay / 1000)} s: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  })).then(() => undefined);
}
