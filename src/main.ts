import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { Store, databasePath } from './store.ts';
import { Queue } from './queue.ts';
import { createProviders } from './providers/index.ts';
import { createMediaDownloader } from './media/download.ts';
import { createServer } from './server.ts';
import { configureArrs } from './arr-setup.ts';
import { Publisher } from './publisher.ts';

const config = await loadConfig();
const store = new Store(await databasePath(config.dataDir));
const providers = createProviders(config, store.database);
const queue = new Queue(store, config, providers, createMediaDownloader(config));
const publisher = config.vltava ? new Publisher(config, config.vltava, store.database) : undefined;
const server = await createServer(config, store, queue, providers, publisher);
const arrSetup = new AbortController();
const cleanup = new AsyncDisposableStack();
cleanup.use(store);
cleanup.defer(async () => { await Promise.all([...providers.values()].map(provider => provider.close?.())); });
cleanup.use(queue);
if (publisher) cleanup.defer(() => publisher.close());
cleanup.use(server);
cleanup.defer(() => arrSetup.abort());
async function shutdown(): Promise<void> {
  await cleanup.disposeAsync();
}
process.once('SIGTERM', () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
process.once('SIGINT', () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
try {
  await server.listen({ host: config.host, port: config.port });
  queue.wake();
  publisher?.wake();
  // Sonarr and Radarr test the indexer and download client on save, so they are configured once Bohemarr listens.
  void configureArrs(config, arrSetup.signal);
  console.log(`Bohemarr listening on ${config.host}:${config.port}; ${providers.size} providers enabled`);
  console.log(`API key: configured via API_KEY/API_KEY_FILE or stored in ${resolve(config.dataDir, 'api-key')}`);
} catch (error) {
  await shutdown();
  throw error;
}
