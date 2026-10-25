import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNovaArchiveProvider, type NovaArchiveSite } from '../src/providers/nova-markiza-nova.ts';
import { fetchTextRetry } from '../src/providers/nova-markiza-utils.ts';
import { searchCatalogue } from '../src/catalogue.ts';

const signal = AbortSignal.timeout(10_000);

/** tv.nova.cz's selectors (see NOVAPLUS_SITE) pointed at a local server. */
function site(base: string): NovaArchiveSite {
  return {
    id: 'novaplus',
    name: 'TV Nova',
    host: new URL(base).host,
    programsUrl: `${base}/porady`,
    episodeListUrl: (contentId, offset) => `${base}/api/v1/mixed/more?page=0&offset=${offset}&content=${encodeURIComponent(contentId)}`,
    selPrograms: ':not(.tab-content) > .c-show-wrapper > .c-show',
    programTitleSelector: '.title',
    selEpisodes: ".c-article-wrapper [class^='col-'] .c-article",
    selEpisodesLoadMore: '.js-article-load-more .c-button',
    selPlayerIframe: 'iframe[data-video-id]',
    iframeAttr: 'data-src',
    selLabelVoyo: '.c-badge',
    episodeNumberRegex: /(?:(?:\s+[-–—]|\s*:)\s+)?(\d+)\.\s+díl(?:\s+[-–—]\s+)?/iu,
    episodePaths: ['videa/cele-dily'],
    contentParamFallback: true,
  };
}

const article = (episode: number) =>
  `<div class="col-12"><article class="c-article"><div class="title"><a href="/porady/show/epizoda-${episode}">Epizoda z ${episode}. týdne</a></div></article></div>`;
/** `episodes` newest first, as the site lists them. */
const page = (episodes: number[], loadMore: boolean) =>
  `<div class="c-article-wrapper">${episodes.map(article).join('')}</div>${loadMore ? '<div class="js-article-load-more"><a class="c-button" data-href="/api/v1/mixed/more?page=0&offset=0&content=CID">Více</a></div>' : ''}`;

test('episodes without a number in the title are numbered by position, walking the archive from its oldest page', async () => {
  const all = Array.from({ length: 12 }, (_, i) => 12 - i); // 12 episodes, newest first
  const offsets: number[] = [];
  await using server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/porady')
      return void response.end('<div class="c-show-wrapper"><a class="c-show" href="/porady/show"><h3 class="title">Show</h3></a></div>');
    if (url.pathname === '/porady/show/videa/cele-dily') return void response.end(page(all.slice(0, 6), true));
    if (url.pathname === '/api/v1/mixed/more') {
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      if (offset < 0 || offset >= all.length) return void response.writeHead(404).end();
      return void response.end(page(all.slice(offset, offset + 6), false));
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const provider = createNovaArchiveProvider(site(base));
    const releases = await searchCatalogue(provider, { q: 'Show', kind: 'tv', limit: 20, offset: 0 }, signal);
    assert.deepEqual(
      releases.map(release => release.episode),
      all,
      'newest first, numbered 12 down to 1',
    );
    assert.deepEqual(releases.map(release => release.url).slice(0, 2), [
      `${base}/porady/show/epizoda-12`,
      `${base}/porady/show/epizoda-11`,
    ]);
    const walk = offsets.slice(offsets.lastIndexOf(6));
    assert.deepEqual(walk, [6, 0], 'the numbering walk reads the oldest page first and stops at offset 0');
  } finally {
    server.closeAllConnections();
  }
});

test('fetchTextRetry gives up at once on an aborted caller or a 4xx page, and retries server errors', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    init?.signal?.throwIfAborted();
    return new Response('', { status: 404 });
  });
  await assert.rejects(fetchTextRetry('https://example.test/missing', signal, 5), /HTTP 404/);
  assert.equal(calls, 1, 'a 404 is not retried');
  calls = 0;
  await assert.rejects(fetchTextRetry('https://example.test/x', AbortSignal.abort(new Error('cancelled')), 5), /cancelled/);
  assert.equal(calls, 1, 'an aborted caller sends no further requests');
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: calls++ < 2 ? 503 : 200 }));
  assert.equal(await fetchTextRetry('https://example.test/flaky', signal, 5), '');
  assert.equal(calls, 3, 'server errors are retried until one succeeds');
});
