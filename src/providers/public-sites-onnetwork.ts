// Shared "OnNetwork" embed resolution, ported from the duplicated private OnNetwork helper
// classes in sune.app.mediadown.media_engine.tvprimadoma.TVPrimaDomaEngine and
// sune.app.mediadown.media_engine.tvautosalon.TVAutosalonEngine. Both engines embed video
// through an identical onnetwork.tv iframe/config scheme; only the embedding script's
// selector and the request Referer differ between the two sites.
import JSON5 from 'json5';
import type { MediaSource } from '../types.ts';
import { bracketSubstring, fetchText, mediaType } from './common.ts';

interface OnNetworkVideo {
  url: string;
  name?: string;
  urls?: { url: string; name?: string }[];
}

/**
 * Resolves the list of playable video sources from an onnetwork.tv embed script.
 * @param scriptSrc absolute URL of the embedding `<script>` (e.g. found via `#video > script` or `.container div > script`)
 * @param referer   the Referer header to send when requesting the onnetwork.tv frame (site-specific)
 */
export async function resolveOnNetworkEmbed(scriptSrc: string, referer: string, signal: AbortSignal): Promise<MediaSource[]> {
  const script = await fetchText(scriptSrc, signal);

  const configIdx = script.indexOf('{"');
  if (configIdx < 0) throw new Error('OnNetwork: unable to find player configuration');
  const configText = bracketSubstring(script, configIdx);
  if (!configText) throw new Error('OnNetwork: player configuration is not a complete object');
  const config = JSON5.parse<{ iid: string; mid: string }>(configText);

  const baseIdIdx = script.indexOf('var _ONNPBaseId');
  if (baseIdIdx < 0) throw new Error('OnNetwork: unable to find _ONNPBaseId');
  const baseIdMatch = script.slice(baseIdIdx).match(/_ONNPBaseId\s*=\s*['"]([^'"]*)['"]/);
  const baseId = baseIdMatch?.[1]?.trim();
  if (!baseId) throw new Error('OnNetwork: unable to extract _ONNPBaseId value');

  const frameUrl = `https://video.onnetwork.tv/frame86.php?id=ff${baseId}${Date.now()}1&iid=${config.iid}&e=1&lang=3&onnsfonn=1&mid=${config.mid}`;
  const frameContent = await fetchText(frameUrl, signal, { headers: { Referer: referer } });

  const playerVideosIdx = frameContent.indexOf('var playerVideos');
  if (playerVideosIdx < 0) throw new Error('OnNetwork: unable to find playerVideos data');
  const playerVideosText = bracketSubstring(frameContent, playerVideosIdx, '[', ']');
  if (!playerVideosText) throw new Error('OnNetwork: playerVideos is not a complete array');
  const playerVideos = JSON5.parse<OnNetworkVideo[]>(playerVideosText);

  const sources: MediaSource[] = [];
  for (const video of playerVideos) {
    const videoHeightMatch = video.name?.match(/(\d+)/);
    sources.push({ url: video.url, type: mediaType(video.url), height: videoHeightMatch ? Number.parseInt(videoHeightMatch[1]!, 10) : undefined });
    for (const additional of video.urls ?? []) {
      const additionalHeightMatch = additional.name?.match(/(\d+)/);
      sources.push({ url: additional.url, type: mediaType(additional.url), height: additionalHeightMatch ? Number.parseInt(additionalHeightMatch[1]!, 10) : undefined });
    }
  }

  if (sources.length === 0) throw new Error('OnNetwork: no video sources found in player configuration');
  return sources;
}
