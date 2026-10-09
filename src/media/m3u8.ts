import type { ProtectedTrack } from './mpd.ts';
import type { MediaSegment } from '../types.ts';
import { normalizeLanguage } from '../providers/common.ts';

export interface HlsTrack extends ProtectedTrack { kind: 'video' | 'audio'; height?: number; bandwidth?: number; averageBandwidth?: number; language?: string; }
export interface HlsSelection { live: boolean; video: HlsTrack; audio?: HlsTrack; videoPlaylistUrl: string; audioPlaylistUrl?: string; }

interface Variant { bandwidth: number; averageBandwidth?: number; height?: number; audioGroupId?: string; url: string; }
interface AudioGroupEntry { groupId: string; uri?: string; language?: string; }

interface ParsedPlaylist {
  isMaster: boolean;
  live: boolean;
  variants: Variant[];
  audioGroups: AudioGroupEntry[];
  initSegment?: MediaSegment;
  mediaSegments: MediaSegment[];
  pssh?: string;
  keyId?: string;
  durationSeconds: number;
}

const WIDEVINE_KEYFORMAT = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

/** Reference: https://datatracker.ietf.org/doc/html/rfc8216#section-4.2 */
function parseAttributeList(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("[^"\r\n]*"|[^,\r\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    const name = match[1] ?? '';
    let value2 = match[2] ?? '';
    if (value2.startsWith('"') && value2.endsWith('"')) value2 = value2.slice(1, -1);
    attrs[name.toUpperCase()] = value2;
  }
  return attrs;
}

function parseVariant(attrs: Record<string, string>, url: string): Variant {
  const resolution = attrs.RESOLUTION;
  const parts = resolution ? resolution.split('x') : undefined;
  const averageBandwidth = Number(attrs['AVERAGE-BANDWIDTH']);
  return {
    bandwidth: Number(attrs.BANDWIDTH ?? 0),
    averageBandwidth: Number.isFinite(averageBandwidth) && averageBandwidth > 0 ? averageBandwidth : undefined,
    height: parts?.[1] !== undefined ? Number(parts[1]) : undefined,
    audioGroupId: attrs.AUDIO,
    url,
  };
}

/** Reference: https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.2.2 (`<n>[@<o>]`, offset optional/contiguous). */
function parseByteRange(value: string, previousEnd: number | undefined): { start: number; length: number } {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported EXT-X-BYTERANGE value: ${value}`);
  const length = Number(match[1]);
  const start = match[2] !== undefined ? Number(match[2]) : previousEnd;
  if (start === undefined) throw new Error(`EXT-X-BYTERANGE ${value} omits an offset with no preceding sub-range to continue from`);
  return { start, length };
}

function parseKeyLine(attrs: Record<string, string>): { pssh?: string; keyId?: string } {
  const method = attrs.METHOD ?? 'NONE';
  if (method === 'NONE') return {};
  const keyFormat = attrs.KEYFORMAT?.toLowerCase();
  if (keyFormat && keyFormat !== WIDEVINE_KEYFORMAT) return {};
  let pssh: string | undefined;
  const dataUriPrefix = 'data:text/plain;base64,';
  if (attrs.URI?.startsWith(dataUriPrefix)) pssh = attrs.URI.slice(dataUriPrefix.length);
  let keyId = attrs.KEYID;
  if (keyId?.toLowerCase().startsWith('0x')) keyId = keyId.slice(2);
  return { pssh, keyId: keyId?.replace(/-/g, '').toLowerCase() };
}

/** Parses a single HLS playlist (master or media); does not recurse into referenced playlists. */
function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  let isMaster = false;
  let live = true;
  const variants: Variant[] = [];
  const audioGroups: AudioGroupEntry[] = [];
  const mediaSegments: MediaSegment[] = [];
  let initSegment: MediaSegment | undefined;
  let pssh: string | undefined;
  let keyId: string | undefined;
  let pendingStreamInf: Record<string, string> | undefined;
  let pendingRange: { start: number; length: number } | undefined;
  let previousRangeEnd: number | undefined;
  let durationSeconds = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const raw = line.slice('#EXTINF:'.length);
      const commaIndex = raw.indexOf(',');
      const value = Number(commaIndex >= 0 ? raw.slice(0, commaIndex) : raw);
      if (Number.isFinite(value)) durationSeconds += value;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), previousRangeEnd);
      previousRangeEnd = pendingRange.start + pendingRange.length;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      pendingStreamInf = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      isMaster = true;
      const attrs = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE === 'AUDIO') {
        audioGroups.push({
          groupId: attrs['GROUP-ID'] ?? '',
          uri: attrs.URI ? new URL(attrs.URI, baseUrl).toString() : undefined,
          language: attrs.LANGUAGE,
        });
      }
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const key = parseKeyLine(parseAttributeList(line.slice('#EXT-X-KEY:'.length)));
      if (key.pssh) pssh = key.pssh;
      if (key.keyId) keyId = key.keyId;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        const range = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, undefined) : undefined;
        initSegment = { url: new URL(attrs.URI, baseUrl).toString(), range };
      }
    } else if (line === '#EXT-X-ENDLIST' || line.startsWith('#EXT-X-PLAYLIST-TYPE:VOD')) {
      live = false;
    } else if (!line.startsWith('#')) {
      if (isMaster && pendingStreamInf) {
        variants.push(parseVariant(pendingStreamInf, new URL(line, baseUrl).toString()));
        pendingStreamInf = undefined;
      } else if (!isMaster) {
        mediaSegments.push({ url: new URL(line, baseUrl).toString(), range: pendingRange });
        pendingRange = undefined;
      }
    }
  }

  return { isMaster, live, variants, audioGroups, initSegment, mediaSegments, pssh, keyId, durationSeconds };
}

async function fetchPlaylist(url: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<ParsedPlaylist> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching HLS playlist`);
  const text = await response.text();
  return parsePlaylist(text, response.url);
}

function toTrack(
  playlist: ParsedPlaylist, kind: 'video' | 'audio',
  extra?: { height?: number; bandwidth?: number; averageBandwidth?: number; language?: string },
): HlsTrack {
  return {
    kind, initSegment: playlist.initSegment, mediaSegments: playlist.mediaSegments, durationSeconds: playlist.durationSeconds,
    pssh: playlist.pssh ? [playlist.pssh] : [], keyId: playlist.keyId, ...extra,
  };
}

/**
 * Resolves the best video rendition (at or below `targetHeight`) and its linked audio rendition
 * (per the `AUDIO` group-id on the chosen `#EXT-X-STREAM-INF` variant, preferring `targetLanguage`
 * among that group's renditions when more than one is offered) from an HLS master or plain media
 * playlist, extracting each rendition's own `#EXT-X-KEY` Widevine PSSH/KEYID and `#EXT-X-MAP`
 * initialization segment for fMP4/CENC content. `video`/`audio` durations come from summed
 * `#EXTINF` tags; `video.height`/`video.bandwidth` (the `#EXT-X-STREAM-INF` attributes - a
 * combined AV bitrate, per RFC 8216 §4.3.4.2 - not video-only) are only set when resolved from a
 * master playlist, never guessed for a plain media playlist.
 */
export async function resolveHlsTracks(
  masterUrl: string, headers: Record<string, string> | undefined, targetHeight: number | undefined,
  targetLanguage: string | undefined, signal: AbortSignal,
): Promise<HlsSelection> {
  const master = await fetchPlaylist(masterUrl, headers, signal);

  let videoPlaylist = master;
  let videoPlaylistUrl = masterUrl;
  let audioGroupId: string | undefined;
  let selectedHeight: number | undefined;
  let selectedBandwidth: number | undefined;
  let selectedAverageBandwidth: number | undefined;
  if (master.isMaster) {
    if (!master.variants.length) throw new Error('HLS master playlist has no variant streams');
    const eligible = targetHeight ? master.variants.filter(v => (v.height ?? 0) <= targetHeight) : master.variants;
    const pool = eligible.length ? eligible : master.variants;
    const best = pool.reduce((a, b) => {
      const heightA = a.height ?? 0;
      const heightB = b.height ?? 0;
      if (heightA !== heightB) return heightB > heightA ? b : a;
      return b.bandwidth > a.bandwidth ? b : a;
    });
    audioGroupId = best.audioGroupId;
    selectedHeight = best.height;
    selectedBandwidth = best.bandwidth;
    selectedAverageBandwidth = best.averageBandwidth;
    videoPlaylistUrl = best.url;
    videoPlaylist = await fetchPlaylist(best.url, headers, signal);
    if (videoPlaylist.isMaster) throw new Error('HLS variant resolved to another master playlist');
  }

  let audio: HlsTrack | undefined;
  let audioPlaylistUrl: string | undefined;
  if (audioGroupId) {
    const candidates = master.audioGroups.filter(g => g.groupId === audioGroupId && g.uri);
    const targetNormalized = targetLanguage ? normalizeLanguage(targetLanguage) : undefined;
    const group = (targetNormalized ? candidates.find(g => normalizeLanguage(g.language) === targetNormalized) : undefined) ?? candidates[0];
    if (group?.uri) {
      const audioPlaylist = await fetchPlaylist(group.uri, headers, signal);
      audio = toTrack(audioPlaylist, 'audio', { language: group.language });
      audioPlaylistUrl = group.uri;
    }
  }

  return {
    live: videoPlaylist.live,
    video: toTrack(videoPlaylist, 'video', { height: selectedHeight, bandwidth: selectedBandwidth, averageBandwidth: selectedAverageBandwidth }),
    audio, videoPlaylistUrl, audioPlaylistUrl,
  };
}
