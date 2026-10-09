import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, MediaSource } from '../src/types.ts';
import { inspectMediaSources } from '../src/media/metadata.ts';

const execFileAsync = promisify(execFile);

function baseConfig(directory: string): Config {
  return {
    host: '127.0.0.1', port: 0, apiKey: 'test', publicUrl: 'http://127.0.0.1', dataDir: directory, downloadsDir: directory,
    concurrency: 1, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'http://unused.invalid',
    categories: [], providers: {}, arrs: [],
  };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Server did not bind to a network address');
  return `http://127.0.0.1:${address.port}`;
}

/** Serves fixed text/binary bodies by path, honoring HEAD and single-byte-range probes. */
function serveFixtures(bodies: Record<string, { body: Buffer; contentType?: string }>): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\//, '');
    const entry = bodies[path];
    if (!entry) { response.writeHead(404); response.end(); return; }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Length': entry.body.length, ...(entry.contentType ? { 'Content-Type': entry.contentType } : {}) });
      response.end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const slice = entry.body.subarray(start, end + 1);
      response.writeHead(206, { 'Content-Length': slice.length, 'Content-Range': `bytes ${start}-${end}/${entry.body.length}` });
      response.end(slice);
      return;
    }
    response.writeHead(200, { 'Content-Length': entry.body.length, ...(entry.contentType ? { 'Content-Type': entry.contentType } : {}) });
    response.end(entry.body);
  });
}

interface VideoRep { id: string; height: number; bandwidth: number; }
interface AudioRep { id: string; bandwidth: number; lang: string; }

/** `SegmentTemplate`-based Representations: segments are separately-addressed files with no byte
 * ranges, so `inspectMediaSources` can only estimate their size from bandwidth * duration
 * (`bandwidth="0"` models a manifest that omits the attribute: no usable estimate exists then). */
function dashManifestEstimated(periods: Array<{ durationSeconds: number; videos: VideoRep[]; audios: AudioRep[] }>): string {
  const periodXml = periods.map((p, i) => `
  <Period id="p${i}" duration="PT${p.durationSeconds}S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      ${p.videos.map(v => `<Representation id="${v.id}" bandwidth="${v.bandwidth}" width="${Math.round(v.height * 16 / 9)}" height="${v.height}" mimeType="video/mp4">
        <SegmentTemplate media="${v.id}-$Number$.m4s" duration="1" timescale="1" startNumber="1"/>
      </Representation>`).join('')}
    </AdaptationSet>
    ${p.audios.map(a => `<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="${a.lang}">
      <Representation id="${a.id}" bandwidth="${a.bandwidth}" mimeType="audio/mp4">
        <SegmentTemplate media="${a.id}-$Number$.m4s" duration="1" timescale="1" startNumber="1"/>
      </Representation>
    </AdaptationSet>`).join('')}
  </Period>`).join('');
  return `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">${periodXml}</MPD>`;
}

/** `SegmentList`-based Representation with explicit `mediaRange`/`range` byte offsets into one
 * addressable file, so `inspectMediaSources` can report an exact (non-estimated) byte count. */
function dashManifestExact(fileUrl: string, initRange: string, mediaRanges: string[], height: number, bandwidth: number): string {
  const segments = mediaRanges.map(r => `<SegmentURL media="${fileUrl}" mediaRange="${r}"/>`).join('');
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period duration="PT1S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v0" bandwidth="${bandwidth}" width="${Math.round(height * 16 / 9)}" height="${height}" mimeType="video/mp4">
        <SegmentList timescale="1" duration="1"><Initialization sourceURL="${fileUrl}" range="${initRange}"/>${segments}</SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function dashManifestLive(): string {
  return `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
  <Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="v0" bandwidth="1000000" width="1920" height="1080" mimeType="video/mp4">
      <SegmentTemplate media="s-$Number$.m4s" duration="1" timescale="1" startNumber="1"/>
    </Representation>
  </AdaptationSet></Period></MPD>`;
}

function hlsMediaPlaylist(segmentCount: number, segmentDurationSeconds: number): string {
  const segments = Array.from({ length: segmentCount }, (_, i) => `#EXTINF:${segmentDurationSeconds},\nseg${i}.ts`).join('\n');
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${segmentDurationSeconds}\n#EXT-X-PLAYLIST-TYPE:VOD\n${segments}\n#EXT-X-ENDLIST`;
}

function hlsMasterPlaylist(): string {
  return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="aud"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3010000,RESOLUTION=1920x1080,AUDIO="aud"
high.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio_cs.m3u8",LANGUAGE="cs"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio_en.m3u8",LANGUAGE="en"`;
}

test('DASH: picks the highest actual video height, then bandwidth, and defaults to Czech audio', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const manifest = dashManifestEstimated([{
    durationSeconds: 100,
    videos: [
      { id: 'v288', height: 288, bandwidth: 500000 },
      { id: 'v1080', height: 1080, bandwidth: 3010000 },
      { id: 'v1080b', height: 1080, bandwidth: 1500000 }, // same height, lower bandwidth: must lose the tie
    ],
    audios: [{ id: 'a-en', bandwidth: 192000, lang: 'en' }, { id: 'a-cs', bandwidth: 256000, lang: 'cs' }],
  }]);
  const server = serveFixtures({ 'manifest.mpd': { body: Buffer.from(manifest) } });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/manifest.mpd`, type: 'dash' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080);
  assert.equal(metadata.source.bandwidth, 3010000);
  assert.equal(metadata.language, 'cs');
  assert.equal(metadata.sizeEstimated, true);
  assert.equal(metadata.size, 40825000); // 3010000*100/8 (video) + 256000*100/8 (Czech audio)
});

test('DASH: sums an estimated size per period and takes the max height across periods', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const manifest = dashManifestEstimated([
    { durationSeconds: 50, videos: [{ id: 'p0v', height: 1080, bandwidth: 3000000 }], audios: [{ id: 'p0a', bandwidth: 256000, lang: 'cs' }] },
    { durationSeconds: 50, videos: [{ id: 'p1v', height: 720, bandwidth: 2000000 }], audios: [{ id: 'p1a', bandwidth: 256000, lang: 'cs' }] },
  ]);
  const server = serveFixtures({ 'manifest.mpd': { body: Buffer.from(manifest) } });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/manifest.mpd`, type: 'dash' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080);
  assert.equal(metadata.sizeEstimated, true);
  assert.equal(metadata.size, 34450000); // (3000000+256000)*50/8 + (2000000+256000)*50/8
});

test('DASH: a Representation with no usable bandwidth leaves the whole selected AV size unknown', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const manifest = dashManifestEstimated([{
    durationSeconds: 100,
    videos: [{ id: 'v', height: 1080, bandwidth: 0 }], // manifest omits/zeroes the bandwidth attribute
    audios: [{ id: 'a', bandwidth: 256000, lang: 'cs' }],
  }]);
  const server = serveFixtures({ 'manifest.mpd': { body: Buffer.from(manifest) } });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/manifest.mpd`, type: 'dash' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080); // height is still honestly known...
  assert.equal(metadata.size, undefined); // ...but the AV byte size must not be guessed as audio-only or zero.
  assert.equal(metadata.sizeEstimated, undefined);
});

test('DASH: an all-byte-ranged SegmentList yields an exact (non-estimated) size', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const fileBody = Buffer.alloc(1000, 7);
  // The manifest embeds an absolute media URL, so the fixture server must be listening first.
  const server = createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\//, '');
    if (path === 'file.mp4') {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        const slice = fileBody.subarray(start, end + 1);
        response.writeHead(206, { 'Content-Length': slice.length, 'Content-Range': `bytes ${start}-${end}/${fileBody.length}` });
        response.end(slice);
        return;
      }
      response.writeHead(200, { 'Content-Length': fileBody.length });
      response.end(fileBody);
      return;
    }
    if (path === 'manifest.mpd') {
      const manifest = dashManifestExact(`${base}/file.mp4`, '0-99', ['100-599', '600-999'], 1080, 3000000);
      response.writeHead(200, { 'Content-Length': Buffer.byteLength(manifest) });
      response.end(manifest);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/manifest.mpd`, type: 'dash' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080);
  assert.equal(metadata.sizeEstimated, false);
  assert.equal(metadata.size, 1000); // 100 (init) + 500 + 400 (media ranges), byte-exact
});

test('DASH: a live manifest is rejected', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const server = serveFixtures({ 'manifest.mpd': { body: Buffer.from(dashManifestLive()) } });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/manifest.mpd`, type: 'dash' };
  await assert.rejects(inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal));
});

test('HLS: the linked Czech audio group is preferred and BANDWIDTH (already combined AV) is not double-counted', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const server = serveFixtures({
    'master.m3u8': { body: Buffer.from(hlsMasterPlaylist()) },
    'low.m3u8': { body: Buffer.from(hlsMediaPlaylist(10, 10)) },
    'high.m3u8': { body: Buffer.from(hlsMediaPlaylist(10, 10)) },
    'audio_cs.m3u8': { body: Buffer.from(hlsMediaPlaylist(10, 10)) },
    'audio_en.m3u8': { body: Buffer.from(hlsMediaPlaylist(10, 10)) },
  });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/master.m3u8`, type: 'hls' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080);
  assert.equal(metadata.language, 'cs');
  assert.equal(metadata.sizeEstimated, true);
  assert.equal(metadata.size, 37625000); // 100s of combined-AV BANDWIDTH=3010000; audio never added again on top.
});

test('HLS: AVERAGE-BANDWIDTH, when present, is used for the size estimate instead of peak BANDWIDTH', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3010000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1920x1080
high.m3u8`;
  const server = serveFixtures({
    'master.m3u8': { body: Buffer.from(master) },
    'high.m3u8': { body: Buffer.from(hlsMediaPlaylist(10, 10)) },
  });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/master.m3u8`, type: 'hls' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080);
  assert.equal(metadata.sizeEstimated, true);
  assert.equal(metadata.size, 31250000); // 2500000*100/8, not the peak 3010000
});

test('HLS: a plain media playlist (no master) reports no fabricated height/bandwidth/size', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const server = serveFixtures({ 'media.m3u8': { body: Buffer.from(hlsMediaPlaylist(5, 6)) } });
  const base = await listen(server);
  t.after(() => server.close());

  const source: MediaSource = { url: `${base}/media.m3u8`, type: 'hls' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, undefined);
  assert.equal(metadata.size, undefined);
  assert.equal(metadata.sizeEstimated, undefined);
});

test('a direct file source gets an exact Content-Length size, and a larger uninspected DASH manifest beats a tagged low-quality file', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const clearVideoPath = join(directory.path, 'clear.mp4');
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clearVideoPath,
  ]);
  const clearVideoBody = await readFile(clearVideoPath);

  const dashManifest = dashManifestEstimated([{ durationSeconds: 60, videos: [{ id: 'v', height: 1080, bandwidth: 3000000 }], audios: [] }]);
  const server = serveFixtures({
    'low.mp4': { body: clearVideoBody, contentType: 'video/mp4' },
    'manifest.mpd': { body: Buffer.from(dashManifest) },
  });
  const base = await listen(server);
  t.after(() => server.close());

  // audioLanguage pinned so the "no avoidable probing" path doesn't re-probe this video-only file for language.
  const lowFile: MediaSource = { url: `${base}/low.mp4`, type: 'file', height: 480, audioLanguage: 'en' };
  const dashSource: MediaSource = { url: `${base}/manifest.mpd`, type: 'dash' };

  const fileOnly = await inspectMediaSources(baseConfig(directory.path), [lowFile], new AbortController().signal);
  assert.equal(fileOnly.height, 480);
  assert.equal(fileOnly.size, clearVideoBody.length);
  assert.equal(fileOnly.sizeEstimated, false);

  const combined = await inspectMediaSources(baseConfig(directory.path), [lowFile, dashSource], new AbortController().signal);
  assert.equal(combined.source.type, 'dash');
  assert.equal(combined.height, 1080);
});

test('a HEAD error response body is never mistaken for the file size', async t => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-meta-'));
  const server = createServer((request, response) => {
    // A real server returning a 403 error page - its Content-Length describes the error page,
    // not the media - and (since the status isn't 405/501) no Range fallback should be tried.
    const body = Buffer.from('Forbidden');
    response.writeHead(403, { 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  const base = await listen(server);
  t.after(() => server.close());

  // height/audioLanguage pinned so no ffprobe call is made against this unreadable URL.
  const source: MediaSource = { url: `${base}/video.mp4`, type: 'file', height: 1080, audioLanguage: 'cs' };
  const metadata = await inspectMediaSources(baseConfig(directory.path), [source], new AbortController().signal);

  assert.equal(metadata.height, 1080);
  assert.equal(metadata.size, undefined);
  assert.equal(metadata.sizeEstimated, undefined);
});
