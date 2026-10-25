import type { MediaSource } from '../types.ts';
import { axdrmLicense, mediaType } from './common.ts';
import type { PlayerTrack } from './nova-markiza-utils.ts';

/**
 * Ported from the identical `getMedia` loop present in `NovaPlusEngine`,
 * `TNCZEngine`, `MarkizaPlusEngine` and `MarkizaVoyoEngine.API#getMedia`:
 * each `lib.source.sources[]` entry becomes one media source; a
 * `contentProtection` block is only understood for DASH (Widevine over
 * HLS/FairPlay is unsupported upstream too, so such tracks are dropped).
 *
 * `drmReferer` is only set for hosts that have a matching upstream
 * `drm_engine.*` (novaplus → tv.nova.cz, markizavoyo → voyo.markiza.sk).
 * TNCZ and MarkizaPlus never registered a DRM engine upstream. Protected
 * tracks without a supported license adapter are omitted, never mislabeled
 * as clear media; an all-protected unsupported source fails as unplayable.
 */
export function tracksToSources(tracks: PlayerTrack[], drmReferer: string | undefined): MediaSource[] {
  const sources: MediaSource[] = [];

  for (const track of tracks) {
    if (!track.src) continue;
    const mime = track.type?.toLowerCase() ?? '';
    const type = mime.includes('dash') ? 'dash' : mime.includes('mpegurl') ? 'hls' : mediaType(track.src);
    const token = track.contentProtection?.token;

    if (token) {
      if (type !== 'dash' || !drmReferer) continue;
      sources.push({ url: track.src, type, drm: axdrmLicense(token, drmReferer) });
      continue;
    }

    sources.push({ url: track.src, type });
  }

  return sources;
}
