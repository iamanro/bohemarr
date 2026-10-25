import { ClientType, Innertube, Platform } from 'youtubei.js';
import { fetchResponse } from './common.ts';
import { evaluatePlayerScript } from './javascript.ts';
import type { MediaSource, ProviderConfig } from '../types.ts';

// The legacy Java watch-page scraper no longer receives format URLs from YouTube's WEB client.
// Use the maintained TypeScript protocol implementation, with remote transforms isolated in WASM.
Platform.shim.eval = async data => {
  const result = await evaluatePlayerScript(`(function(){${data.output}\n})()`);
  if (!result || typeof result !== 'object') throw new Error('YouTube player returned an invalid decipher result');
  return result as Record<string, unknown>;
};

export function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      /^(?:(?:www|m)\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function maybeTransformYouTubeUrl(url: string): string {
  if (!isYouTubeUrl(url)) throw new Error('Unsupported YouTube URL');
  const parsed = new URL(url);
  const id =
    parsed.hostname === 'youtu.be'
      ? parsed.pathname.slice(1)
      : parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] || parsed.searchParams.get('v');
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('YouTube URL must identify a video');
  return `https://www.youtube.com/watch?v=${id}`;
}

export async function resolveYouTube(url: string, signal: AbortSignal, config: ProviderConfig): Promise<MediaSource[]> {
  const id = new URL(maybeTransformYouTubeUrl(url)).searchParams.get('v')!;
  const requested = config.client ?? 'IOS';
  if (requested !== 'TV' && requested !== 'ANDROID' && requested !== 'WEB' && requested !== 'IOS') {
    throw new Error('YouTube client must be TV, ANDROID, WEB or IOS');
  }
  const youtube = await Innertube.create({
    client_type: ClientType[requested],
    cookie: config.cookies,
    po_token: typeof config.poToken === 'string' ? config.poToken : undefined,
    visitor_data: typeof config.visitorData === 'string' ? config.visitorData : undefined,
    player_id: typeof config.playerId === 'string' ? config.playerId : undefined,
    enable_session_cache: false,
    fetch: (input, init) => fetchResponse(input, init?.signal ? AbortSignal.any([signal, init.signal]) : signal, init ?? {}),
  });
  const info = await youtube.getBasicInfo(id, { client: requested });
  if (info.playability_status?.status !== 'OK') {
    throw new Error(
      `YouTube playback unavailable: ${info.playability_status?.reason || info.playability_status?.status || 'unknown reason'}`,
    );
  }
  if (info.basic_info.is_live) throw new Error('An ongoing YouTube live stream cannot be imported as a completed release');
  const data = info.streaming_data;
  if (!data) throw new Error('YouTube returned no streaming data');
  const subtitles = info.captions?.caption_tracks?.map(track => {
    const subtitleUrl = new URL(track.base_url);
    subtitleUrl.searchParams.set('fmt', 'vtt');
    return { url: subtitleUrl.toString(), language: track.language_code };
  });
  const formats = [...data.adaptive_formats, ...data.formats].filter(
    format => !format.drm_families?.length && !format.is_type_otf && (format.url || format.signature_cipher || format.cipher),
  );
  const audio = formats
    .filter(format => format.has_audio && !format.has_video)
    .sort(
      (a, b) => Number(b.audio_track?.audio_is_default ?? true) - Number(a.audio_track?.audio_is_default ?? true) || b.bitrate - a.bitrate,
    )[0];
  const audioUrl = audio ? await audio.decipher(youtube.session.player) : undefined;
  const sources: MediaSource[] = [];
  for (const format of formats.filter(format => format.has_video)) {
    signal.throwIfAborted();
    if (!format.has_audio && !audioUrl) continue;
    sources.push({
      url: await format.decipher(youtube.session.player),
      type: 'file',
      height: format.height,
      bandwidth: format.bitrate,
      audioUrl: format.has_audio ? undefined : audioUrl,
      subtitles,
    });
  }
  if (data.hls_manifest_url) sources.push({ url: data.hls_manifest_url, type: 'hls', subtitles });
  if (data.dash_manifest_url) sources.push({ url: data.dash_manifest_url, type: 'dash', subtitles });
  if (!sources.length)
    throw new Error(
      'YouTube returned no downloadable formats. Check account access and the configured client/PoToken; SABR-only responses are not direct media URLs.',
    );
  return sources;
}
