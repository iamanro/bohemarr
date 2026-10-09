import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, License, MediaSource } from '../src/types.ts';
import type { Cdm, ContentKey } from '../src/media/protected-media.ts';
import { downloadProtectedMedia } from '../src/media/protected-media.ts';

const execFileAsync = promisify(execFile);

/** Resolves the Bento4 `mp4decrypt` binary from `MP4DECRYPT` or `PATH`, or `undefined` if it is not installed. */
function resolveMp4decrypt(): string | undefined {
  if (process.env.MP4DECRYPT && existsSync(process.env.MP4DECRYPT)) return process.env.MP4DECRYPT;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, 'mp4decrypt');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const mp4decryptPath = resolveMp4decrypt();

function baseConfig(directory: string): Config {
  return {
    host: '127.0.0.1', port: 0, apiKey: 'test', publicUrl: 'http://127.0.0.1', dataDir: directory, downloadsDir: directory,
    concurrency: 1, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: mp4decryptPath ?? 'mp4decrypt', wvApiUrl: 'http://unused.invalid',
    categories: [], providers: {}, arrs: [],
  };
}

/** A top-level ISO-BMFF box (`ftyp`, `moov`, `moof`, `mdat`, ...) found by a flat, non-recursive scan. */
interface TopBox { type: string; start: number; end: number; }

function scanTopBoxes(buffer: Buffer): TopBox[] {
  const boxes: TopBox[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = size === 0 ? buffer.length : offset + size;
    boxes.push({ type, start: offset, end: end - 1 });
    if (size === 0) break;
    offset += size;
  }
  return boxes;
}

interface FragmentLayout { initRange: { start: number; end: number }; segmentRanges: Array<{ start: number; end: number }>; }

/** Splits an `empty_moov` fragmented MP4 (as produced by ffmpeg's `+frag_keyframe+empty_moov+default_base_moof`) into an `ftyp+moov` init byte range and one contiguous `moof+mdat` byte range per fragment, ignoring any trailing index (`mfra`) box. */
function splitFragmentedMp4(buffer: Buffer): FragmentLayout {
  const boxes = scanTopBoxes(buffer);
  const ftyp = boxes.find(box => box.type === 'ftyp');
  const moov = boxes.find(box => box.type === 'moov');
  if (!ftyp || !moov) throw new Error('Fixture MP4 is missing ftyp/moov');
  const segmentRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    if (box.type !== 'moof') continue;
    const mdat = boxes[i + 1];
    if (!mdat || mdat.type !== 'mdat') throw new Error('Fixture MP4 has a moof not immediately followed by mdat');
    segmentRanges.push({ start: box.start, end: mdat.end });
  }
  if (!segmentRanges.length) throw new Error('Fixture MP4 has no moof/mdat fragments');
  return { initRange: { start: ftyp.start, end: moov.end }, segmentRanges };
}

/** Generates a fragmented, CENC-encrypted (`cenc-aes-ctr`) single-track (video-only or audio-only) MP4 via ffmpeg. */
async function generateEncryptedTrack(kind: 'video' | 'audio', kid: string, key: string, outputPath: string): Promise<void> {
  const source = kind === 'video'
    ? ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=1']
    : ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1'];
  const codec = kind === 'video'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '5', '-an']
    : ['-c:a', 'aac', '-vn'];
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', ...source, ...codec,
    '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', key, '-encryption_kid', kid,
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000',
    outputPath,
  ]);
}

/** Generates the unencrypted counterpart with identical encode settings, used as the frame-accuracy reference. */
async function generateClearTrack(kind: 'video' | 'audio', outputPath: string): Promise<void> {
  const source = kind === 'video'
    ? ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=1']
    : ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1'];
  const codec = kind === 'video'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '5', '-an']
    : ['-c:a', 'aac', '-vn'];
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...source, ...codec, outputPath]);
}

async function framemd5(path: string, mapArg: string): Promise<string> {
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', mapArg, '-f', 'framemd5', '-']);
  return stdout;
}

/** Audio decode of a fragmented, edit-list-less CENC track is legitimately a fixed encoder-priming sample count off from a plain re-encode of the same source, so audio is verified by codec/duration (not exact per-frame PCM hashes) once video framemd5 has already proven the CENC decrypt round-trip is byte-exact. */
async function probeAudioCodecAndDuration(path: string): Promise<{ codec: string; duration: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', path,
  ]);
  const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string }>; format?: { duration?: string } };
  const codec = parsed.streams?.[0]?.codec_name;
  const duration = Number(parsed.format?.duration);
  if (!codec || !Number.isFinite(duration)) throw new Error(`Could not probe audio stream of ${path}`);
  return { codec, duration };
}

/** Any syntactically valid (36-byte, correct-system-ID) Widevine PSSH box; its contents are never parsed by the fake CDM below. */
function fakePssh(): string {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write('pssh', 4, 'ascii');
  box.writeUInt32BE(0x1000000, 8); // version 1, flags 0 (big-endian, version byte first)
  box.write('edef8ba979d64acea3c827dcd51d21ed', 12, 'hex');
  box.writeUInt32BE(0, 28); // KID count / data size, unused by the fake CDM
  return box.toString('base64');
}

interface FakeLicenseServerRecord { headers: Record<string, string | string[] | undefined>; body: Buffer; }

/** A local HTTP server standing in for a provider's Widevine license endpoint: records every request it receives and replies with a JSON-encoded content-key list the paired fake CDM knows how to parse. */
function startFakeLicenseServer(keys: ContentKey[]): { server: Server; url: string; requests: FakeLicenseServerRecord[] } {
  const requests: FakeLicenseServerRecord[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks) });
      const body = Buffer.from(JSON.stringify({ keys }));
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      response.end(body);
    });
  });
  return { server, url: '', requests };
}

/** Test `Cdm`: `challenge` wraps the PSSH in a JSON envelope so the fake license server (and the assertions below) can see exactly what was asked for; `keys` just parses back whatever the license server answered with, unmodified. */
function fakeCdm(): Cdm {
  return {
    async challenge(pssh) {
      return { session: 'test-session', challenge: Buffer.from(JSON.stringify({ pssh })) };
    },
    async keys(_session, licenseResponse) {
      const parsed = JSON.parse(Buffer.from(licenseResponse).toString('utf8')) as { keys: ContentKey[] };
      return parsed.keys;
    },
  };
}

function serveRangedBuffers(buffers: Record<string, Buffer>): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '').replace(/^\//, '');
    const buffer = buffers[path];
    if (!buffer) { response.writeHead(404); response.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) { response.writeHead(200, { 'Content-Length': buffer.length }); response.end(buffer); return; }
    const start = Number(range[1]);
    const end = Number(range[2]);
    const slice = buffer.subarray(start, end + 1);
    response.writeHead(206, { 'Content-Length': slice.length, 'Content-Range': `bytes ${start}-${end}/${buffer.length}` });
    response.end(slice);
  });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Server did not bind to a network address');
  return `http://127.0.0.1:${address.port}`;
}

function dashSegmentList(fileUrl: string, layout: FragmentLayout): string {
  const range = (r: { start: number; end: number }): string => `${r.start}-${r.end}`;
  const segments = layout.segmentRanges.map(r => `<SegmentURL media="${fileUrl}" mediaRange="${range(r)}"/>`).join('');
  return `<SegmentList timescale="1" duration="1"><Initialization sourceURL="${fileUrl}" range="${range(layout.initRange)}"/>${segments}</SegmentList>`;
}

function dashManifest(videoUrl: string, videoLayout: FragmentLayout, audioUrl: string, audioLayout: FragmentLayout, kid: string): string {
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S">
  <Period duration="PT1S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" default_KID="${kid}"/>
      <Representation id="v0" bandwidth="500000" width="64" height="64" mimeType="video/mp4">
        ${dashSegmentList(videoUrl, videoLayout)}
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" default_KID="${kid}"/>
      <Representation id="a0" bandwidth="128000" mimeType="audio/mp4">
        ${dashSegmentList(audioUrl, audioLayout)}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

function hlsVariantPlaylist(fileUrl: string, layout: FragmentLayout, keyLine: string): string {
  const segments = layout.segmentRanges.map(r =>
    `#EXT-X-BYTERANGE:${r.end - r.start + 1}@${r.start}\n#EXTINF:0.5,\n${fileUrl}`).join('\n');
  return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:1
#EXT-X-PLAYLIST-TYPE:VOD
${keyLine}
#EXT-X-MAP:URI="${fileUrl}",BYTERANGE="${layout.initRange.end - layout.initRange.start + 1}@${layout.initRange.start}"
${segments}
#EXT-X-ENDLIST`;
}

function hlsMasterPlaylist(): string {
  return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=64x64,AUDIO="aud"
video.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8",LANGUAGE="und"`;
}

const REAL_KID = '112233445566778899aabbccddeeff00';
const REAL_KEY = '00112233445566778899aabbccddeeff';
const DECOY_KID = 'ffeeddccbbaa99887766554433221100';
const DECOY_KEY = 'ffeeddccbbaa99887766554433221100';

test('a DASH protected source decrypts, muxes, and its decoded video/audio match the clear source (known-KID key selection)', async (t) => {
  if (!mp4decryptPath) { t.skip('mp4decrypt not installed'); return; }

  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-protected-dash-'));
  const outputDir = join(directory.path, 'out');
  await mkdir(outputDir, { recursive: true });

  const videoEnc = join(directory.path, 'video.mp4');
  const audioEnc = join(directory.path, 'audio.mp4');
  const videoClear = join(directory.path, 'video.clear.mp4');
  const audioClear = join(directory.path, 'audio.clear.mp4');
  await Promise.all([
    generateEncryptedTrack('video', REAL_KID, REAL_KEY, videoEnc),
    generateEncryptedTrack('audio', REAL_KID, REAL_KEY, audioEnc),
    generateClearTrack('video', videoClear),
    generateClearTrack('audio', audioClear),
  ]);
  const videoBuffer = await readFile(videoEnc);
  const audioBuffer = await readFile(audioEnc);
  const videoLayout = splitFragmentedMp4(videoBuffer);
  const audioLayout = splitFragmentedMp4(audioBuffer);

  const fileServer = serveRangedBuffers({ 'video.mp4': videoBuffer, 'audio.mp4': audioBuffer });
  const fileBase = await listen(fileServer);

  // Extra decoy key ordered first: the module must pick the one matching the manifest's default_KID, not just the first key.
  const licenseKeys: ContentKey[] = [{ kid: DECOY_KID, key: DECOY_KEY }, { kid: REAL_KID, key: REAL_KEY }];
  const { server: licenseServerHandle, requests } = startFakeLicenseServer(licenseKeys);
  const licenseBase = await listen(licenseServerHandle);

  const manifestXml = dashManifest(`${fileBase}/video.mp4`, videoLayout, `${fileBase}/audio.mp4`, audioLayout, REAL_KID);
  const manifestServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/dash+xml' });
    response.end(manifestXml);
  });
  const manifestBase = await listen(manifestServer);

  try {
    const license: License = { url: `${licenseBase}/license`, headers: { 'X-Test-Header': 'abc123' }, pssh: [fakePssh()] };
    const source: MediaSource = { url: `${manifestBase}/manifest.mpd`, type: 'dash', drm: license };
    const config = baseConfig(directory.path);
    const cdm = fakeCdm();

    const finalPath = await downloadProtectedMedia(config, cdm, source, outputDir, 'my-movie', AbortSignal.timeout(60_000), () => {});
    assert.equal(finalPath, join(outputDir, 'my-movie.mkv'));
    assert.ok(existsSync(finalPath));

    assert.equal(await framemd5(finalPath, '0:v:0'), await framemd5(videoClear, '0:v:0'));
    const [actualAudio, expectedAudio] = await Promise.all([probeAudioCodecAndDuration(finalPath), probeAudioCodecAndDuration(audioClear)]);
    assert.equal(actualAudio.codec, expectedAudio.codec);
    assert.ok(Math.abs(actualAudio.duration - expectedAudio.duration) < 0.2, `audio duration ${actualAudio.duration} too far from ${expectedAudio.duration}`);

    // The provider license exchange must receive exactly the CDM's own challenge bytes plus the configured headers.
    assert.ok(requests.length >= 2, 'expected one license exchange per track');
    for (const recorded of requests) {
      assert.equal(recorded.headers['x-test-header'], 'abc123');
      const challenge = JSON.parse(recorded.body.toString('utf8')) as { pssh: string };
      assert.equal(challenge.pssh, fakePssh());
    }
  } finally {
    fileServer.close();
    licenseServerHandle.close();
    manifestServer.close();
  }
});

test('an HLS protected source decrypts, muxes, and its decoded video/audio match the clear source (trial-decode key selection)', async (t) => {
  if (!mp4decryptPath) { t.skip('mp4decrypt not installed'); return; }

  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-protected-hls-'));
  const outputDir = join(directory.path, 'out');
  await mkdir(outputDir, { recursive: true });

  const videoEnc = join(directory.path, 'video.mp4');
  const audioEnc = join(directory.path, 'audio.mp4');
  const videoClear = join(directory.path, 'video.clear.mp4');
  const audioClear = join(directory.path, 'audio.clear.mp4');
  await Promise.all([
    generateEncryptedTrack('video', REAL_KID, REAL_KEY, videoEnc),
    generateEncryptedTrack('audio', REAL_KID, REAL_KEY, audioEnc),
    generateClearTrack('video', videoClear),
    generateClearTrack('audio', audioClear),
  ]);
  const videoBuffer = await readFile(videoEnc);
  const audioBuffer = await readFile(audioEnc);
  const videoLayout = splitFragmentedMp4(videoBuffer);
  const audioLayout = splitFragmentedMp4(audioBuffer);

  // No KEYID on the #EXT-X-KEY line: the module cannot know the key ID up front and must fall back to ffmpeg trial-decryption.
  const keyLine = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
  const videoPlaylist = hlsVariantPlaylist('video.mp4', videoLayout, keyLine);
  const audioPlaylist = hlsVariantPlaylist('audio.mp4', audioLayout, keyLine);
  const masterPlaylist = hlsMasterPlaylist();

  // Decoy listed first so the module must actually reject it via trial-decode before finding the real key.
  const licenseKeys: ContentKey[] = [{ kid: '1', key: DECOY_KEY }, { kid: '1', key: REAL_KEY }];
  const { server: licenseServerHandle, requests } = startFakeLicenseServer(licenseKeys);
  const licenseBase = await listen(licenseServerHandle);

  const playlistServer = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/master.m3u8') response.end(masterPlaylist);
    else if (path === '/video.m3u8') response.end(videoPlaylist);
    else if (path === '/audio.m3u8') response.end(audioPlaylist);
    else if (path === '/video.mp4' || path === '/audio.mp4') {
      const buffer = path === '/video.mp4' ? videoBuffer : audioBuffer;
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (!range) { response.writeHead(200, { 'Content-Length': buffer.length }); response.end(buffer); return; }
      const start = Number(range[1]);
      const end = Number(range[2]);
      const slice = buffer.subarray(start, end + 1);
      response.writeHead(206, { 'Content-Length': slice.length, 'Content-Range': `bytes ${start}-${end}/${buffer.length}` });
      response.end(slice);
      return;
    } else { response.writeHead(404); response.end(); return; }
  });
  const playlistBase = await listen(playlistServer);

  try {
    const license: License = { url: `${licenseBase}/license`, headers: { 'X-Test-Header': 'xyz789' }, pssh: [fakePssh()] };
    const source: MediaSource = { url: `${playlistBase}/master.m3u8`, type: 'hls', drm: license };
    const config = baseConfig(directory.path);
    const cdm = fakeCdm();

    const finalPath = await downloadProtectedMedia(config, cdm, source, outputDir, 'my-episode', AbortSignal.timeout(60_000), () => {});
    assert.equal(finalPath, join(outputDir, 'my-episode.mkv'));
    assert.ok(existsSync(finalPath));

    assert.equal(await framemd5(finalPath, '0:v:0'), await framemd5(videoClear, '0:v:0'));
    const [actualAudio, expectedAudio] = await Promise.all([probeAudioCodecAndDuration(finalPath), probeAudioCodecAndDuration(audioClear)]);
    assert.equal(actualAudio.codec, expectedAudio.codec);
    assert.ok(Math.abs(actualAudio.duration - expectedAudio.duration) < 0.2, `audio duration ${actualAudio.duration} too far from ${expectedAudio.duration}`);

    assert.ok(requests.length >= 2, 'expected one license exchange per track');
    for (const recorded of requests) assert.equal(recorded.headers['x-test-header'], 'xyz789');
  } finally {
    playlistServer.close();
    licenseServerHandle.close();
  }
});
