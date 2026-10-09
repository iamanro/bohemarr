import { XMLParser } from 'fast-xml-parser';
import { normalizeLanguage } from '../providers/common.ts';
import type { MediaSegment } from '../types.ts';

export interface ProtectedTrack {
  initSegment?: MediaSegment;
  mediaSegments: MediaSegment[];
  durationSeconds: number;
  pssh: string[];
  keyId?: string;
}

export interface DashRepresentation extends ProtectedTrack {
  id: string;
  kind: 'video' | 'audio';
  bandwidth: number;
  height?: number;
  language?: string;
}

export interface DashPeriod {
  representations: DashRepresentation[];
}

export interface DashManifest {
  live: boolean;
  periods: DashPeriod[];
}

const ARRAY_TAGS: Record<string, true> = {
  Period: true, AdaptationSet: true, Representation: true, S: true, SegmentURL: true,
  ContentProtection: true, BaseURL: true,
};

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
  textNodeName: '#text', trimValues: true,
  isArray: name => ARRAY_TAGS[name] === true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function elementText(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && '#text' in node) {
    const text = (node as { '#text'?: unknown })['#text'];
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

function resolveBaseUrl(parent: URL, node: Record<string, unknown>): URL {
  const candidates = asArray(node.BaseURL as unknown).map(elementText).filter((value): value is string => Boolean(value));
  return candidates.length ? new URL(candidates[0]!, parent) : parent;
}

/** An xs:duration in seconds; years and months have no fixed length, so only zero ones are accepted. */
function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = '(\\d+(?:\\.\\d+)?)';
  const match = new RegExp(`^P(?:${number}Y)?(?:${number}M)?(?:${number}D)?(?:T(?:${number}H)?(?:${number}M)?(?:${number}S)?)?$`).exec(value);
  if (!match || Number(match[1] ?? 0) || Number(match[2] ?? 0)) return undefined;
  const [days, hours, minutes, seconds] = match.slice(3).map(part => Number(part ?? 0)) as [number, number, number, number];
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/** Reference: ISO-IEC 23009-1, section 5.3.9.4.4 (`$Identifier$` / `$Identifier%0Nd$` substitution). */
function substituteTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\$(.*?)\$/g, (_match, name: string) => {
    if (name === '') return '$';
    const percentIndex = name.indexOf('%');
    const identifier = percentIndex >= 0 ? name.slice(0, percentIndex) : name;
    const format = percentIndex >= 0 ? name.slice(percentIndex + 1) : undefined;
    const value = vars[identifier];
    if (value === undefined) throw new Error(`Missing SegmentTemplate identifier value: ${identifier}`);
    if (!format) return String(value);
    const formatMatch = /^0(\d+)d$/.exec(format);
    if (!formatMatch) throw new Error(`Unsupported SegmentTemplate format: ${format}`);
    return String(value).padStart(Number(formatMatch[1]), '0');
  });
}

interface TrackBuild { initSegment?: MediaSegment; mediaSegments: MediaSegment[]; durationSeconds: number; }

/** Reference: ISO-IEC 23009-1, section 5.3.9.2.3 (`@range`/`@mediaRange`: inclusive `first-last` byte offsets). */
function parseByteRange(value: string | undefined): { start: number; length: number } | undefined {
  if (!value) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported DASH byte range: ${value}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start) throw new Error(`Invalid DASH byte range: ${value}`);
  return { start, length: end - start + 1 };
}

function buildFromSegmentTemplate(
  template: Record<string, unknown>, representationId: string, bandwidth: number, baseUrl: URL, periodDurationSeconds: number | undefined,
): TrackBuild {
  const timescale = Number(template['@_timescale'] ?? 1) || 1;
  const startNumber = Number(template['@_startNumber'] ?? 1);
  const vars: Record<string, string | number | undefined> = { RepresentationID: representationId, Bandwidth: bandwidth };
  const initTemplate = template['@_initialization'] as string | undefined;
  const initSegment: MediaSegment | undefined = initTemplate
    ? { url: new URL(substituteTemplate(initTemplate, vars), baseUrl).toString() }
    : undefined;
  const mediaTemplate = template['@_media'] as string;
  if (!mediaTemplate) throw new Error('SegmentTemplate is missing a media attribute');
  const timelineNode = template.SegmentTimeline as Record<string, unknown> | undefined;
  const mediaSegments: MediaSegment[] = [];
  let totalDurationTicks = 0;

  if (timelineNode) {
    const segments: Array<{ time: number; duration: number }> = [];
    const entries = asArray(timelineNode.S as Record<string, unknown>[] | undefined);
    let time = 0;
    for (const [index, s] of entries.entries()) {
      if (s['@_t'] !== undefined) time = Number(s['@_t']);
      const duration = Number(s['@_d']);
      let repeat = 1 + Number(s['@_r'] ?? 0);
      if (repeat < 1) {
        // A negative @r repeats until the next S@t, or else until the end of the Period.
        const nextTime = entries[index + 1]?.['@_t'];
        const presentationTimeOffset = Number(template['@_presentationTimeOffset'] ?? 0);
        const end = nextTime !== undefined ? Number(nextTime)
          : periodDurationSeconds ? presentationTimeOffset + periodDurationSeconds * timescale : undefined;
        if (end === undefined) throw new Error('SegmentTimeline repeats until the Period ends, but the manifest has no period duration');
        repeat = Math.ceil((end - time) / duration);
      }
      for (let i = 0; i < repeat; i++) {
        segments.push({ time, duration });
        time += duration;
      }
    }
    let number = startNumber;
    for (const segment of segments) {
      mediaSegments.push({ url: new URL(substituteTemplate(mediaTemplate, { ...vars, Number: number, Time: segment.time }), baseUrl).toString() });
      totalDurationTicks += segment.duration;
      number++;
    }
  } else {
    const segmentDuration = Number(template['@_duration']);
    if (!segmentDuration) throw new Error('SegmentTemplate has neither a SegmentTimeline nor a duration attribute');
    if (!periodDurationSeconds) throw new Error('Cannot compute SegmentTemplate segment count: manifest has no period/presentation duration');
    const count = Math.ceil((periodDurationSeconds * timescale) / segmentDuration);
    for (let i = 0; i < count; i++) {
      mediaSegments.push({ url: new URL(substituteTemplate(mediaTemplate, { ...vars, Number: startNumber + i }), baseUrl).toString() });
    }
    totalDurationTicks = count * segmentDuration;
  }

  return { initSegment, mediaSegments, durationSeconds: totalDurationTicks / timescale };
}

function buildFromSegmentList(segmentList: Record<string, unknown>, baseUrl: URL): TrackBuild {
  const timescale = Number(segmentList['@_timescale'] ?? 1) || 1;
  const segmentDuration = Number(segmentList['@_duration'] ?? 0);
  const init = segmentList.Initialization as Record<string, unknown> | undefined;
  const initSourceUrl = init?.['@_sourceURL'] as string | undefined;
  const initSegment: MediaSegment | undefined = initSourceUrl
    ? { url: new URL(initSourceUrl, baseUrl).toString(), range: parseByteRange(init?.['@_range'] as string | undefined) }
    : undefined;
  const mediaSegments: MediaSegment[] = asArray(segmentList.SegmentURL as Record<string, unknown>[] | undefined)
    .map(url => ({
      url: new URL(url['@_media'] as string, baseUrl).toString(),
      range: parseByteRange(url['@_mediaRange'] as string | undefined),
    }));
  return { initSegment, mediaSegments, durationSeconds: (segmentDuration * mediaSegments.length) / timescale };
}

/** AdaptationSet@mimeType is common but not universal (e.g. ffmpeg's DASH muxer only sets @contentType on the set and puts @mimeType on each Representation instead). */
function detectKind(adaptationSet: Record<string, unknown>, representations: Record<string, unknown>[]): 'video' | 'audio' | undefined {
  const contentType = adaptationSet['@_contentType'] as string | undefined;
  if (contentType === 'video' || contentType === 'audio') return contentType;
  const setMimeType = adaptationSet['@_mimeType'] as string | undefined;
  if (setMimeType?.startsWith('video/')) return 'video';
  if (setMimeType?.startsWith('audio/')) return 'audio';
  for (const representation of representations) {
    const mimeType = representation['@_mimeType'] as string | undefined;
    if (mimeType?.startsWith('video/')) return 'video';
    if (mimeType?.startsWith('audio/')) return 'audio';
  }
  return undefined;
}

const PLAYREADY_SCHEME = 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95';

function extractProtection(adaptationSet: Record<string, unknown>): { pssh: string[]; keyId?: string } {
  const pssh: string[] = [];
  let keyId: string | undefined;
  for (const node of asArray(adaptationSet.ContentProtection as Record<string, unknown>[] | undefined)) {
    const scheme = (node['@_schemeIdUri'] as string | undefined)?.toLowerCase();
    const kidAttr = node['@_default_KID'] as string | undefined;
    if (kidAttr) keyId = kidAttr.replace(/-/g, '').toLowerCase();
    // Faithful to the upstream MPD parser: any scheme other than the PlayReady UUID is assumed Widevine.
    if (scheme === PLAYREADY_SCHEME) continue;
    const psshText = elementText(node.pssh);
    if (psshText) pssh.push(psshText.trim());
  }
  return { pssh, keyId };
}

export function parseManifest(xml: string, manifestUrl: string): DashManifest {
  const doc = parser.parse(xml) as { MPD?: Record<string, unknown> };
  const mpd = doc.MPD;
  if (!mpd) throw new Error('Invalid DASH manifest: missing MPD root element');
  const live = mpd['@_type'] === 'dynamic';
  const mpdBase = resolveBaseUrl(new URL(manifestUrl), mpd);
  const presentationDuration = parseIsoDuration(mpd['@_mediaPresentationDuration'] as string | undefined);
  const rawPeriods = asArray(mpd.Period as Record<string, unknown>[] | undefined);
  if (!rawPeriods.length) throw new Error('Invalid DASH manifest: no Period elements');
  const periods: DashPeriod[] = [];
  // SegmentTemplate and SegmentList attributes are inherited from Period to AdaptationSet to Representation.
  const inherited = (name: string, ...levels: Record<string, unknown>[]): Record<string, unknown> | undefined => {
    const nodes = levels.map(level => level[name]).filter(node => node && typeof node === 'object');
    return nodes.length ? Object.assign({}, ...nodes) as Record<string, unknown> : undefined;
  };

  let periodStart = 0;
  for (const [index, period] of rawPeriods.entries()) {
    const representations: DashRepresentation[] = [];
    const periodBase = resolveBaseUrl(mpdBase, period);
    periodStart = parseIsoDuration(period['@_start'] as string | undefined) ?? periodStart;
    // A Period lasts until the next one starts, or else until the presentation ends.
    const nextStart = parseIsoDuration(rawPeriods[index + 1]?.['@_start'] as string | undefined);
    const periodDuration = parseIsoDuration(period['@_duration'] as string | undefined)
      ?? (nextStart !== undefined ? nextStart - periodStart : presentationDuration !== undefined ? presentationDuration - periodStart : undefined);
    if (periodDuration !== undefined) periodStart += periodDuration;

    for (const adaptationSet of asArray(period.AdaptationSet as Record<string, unknown>[] | undefined)) {
      const setRepresentations = asArray(adaptationSet.Representation as Record<string, unknown>[] | undefined);
      const kind = detectKind(adaptationSet, setRepresentations);
      if (!kind) continue;
      const adaptationBase = resolveBaseUrl(periodBase, adaptationSet);
      const protection = extractProtection(adaptationSet);
      const language = adaptationSet['@_lang'] as string | undefined;

      for (const representation of setRepresentations) {
        const representationBase = resolveBaseUrl(adaptationBase, representation);
        const id = String(representation['@_id']);
        const bandwidth = Number(representation['@_bandwidth'] ?? 0);
        const height = representation['@_height'] !== undefined ? Number(representation['@_height']) : undefined;
        const template = inherited('SegmentTemplate', period, adaptationSet, representation);
        const segmentList = inherited('SegmentList', period, adaptationSet, representation);

        let built: TrackBuild;
        if (template) built = buildFromSegmentTemplate(template, id, bandwidth, representationBase, periodDuration);
        else if (segmentList) built = buildFromSegmentList(segmentList, representationBase);
        else built = { mediaSegments: [{ url: representationBase.toString() }], durationSeconds: periodDuration ?? 0 };

        representations.push({
          id, kind, bandwidth, height, language,
          initSegment: built.initSegment, mediaSegments: built.mediaSegments, durationSeconds: built.durationSeconds,
          pssh: protection.pssh, keyId: protection.keyId,
        });
      }
    }

    periods.push({ representations });
  }

  return { live, periods };
}

/**
 * Picks the highest-bandwidth video representation at or below `targetHeight` (or overall best if
 * none qualify), plus a compatible audio track, independently for each Period (in document order)
 * so the caller can decrypt and concatenate every period instead of silently dropping all but one.
 */
export function selectVideoAndAudio(
  manifest: DashManifest, targetHeight: number | undefined, targetLanguage?: string,
): Array<{ video: DashRepresentation; audio?: DashRepresentation }> {
  return manifest.periods.map((period, periodIndex) => {
    const videos = period.representations.filter(r => r.kind === 'video');
    if (!videos.length) throw new Error(`No video representation found in DASH manifest period ${periodIndex + 1}`);
    const eligible = targetHeight ? videos.filter(v => (v.height ?? 0) <= targetHeight) : videos;
    const pool = eligible.length ? eligible : videos;
    const video = pool.reduce((best, current) => {
      const bestHeight = best.height ?? 0;
      const currentHeight = current.height ?? 0;
      if (currentHeight !== bestHeight) return currentHeight > bestHeight ? current : best;
      return current.bandwidth > best.bandwidth ? current : best;
    });
    return { video, audio: selectAudio(period.representations, targetLanguage) };
  });
}

function selectAudio(
  representations: DashRepresentation[], targetLanguage: string | undefined,
): DashRepresentation | undefined {
  const language = normalizeLanguage(targetLanguage);
  let best: DashRepresentation | undefined;
  let preferred: DashRepresentation | undefined;
  for (const representation of representations) {
    if (representation.kind !== 'audio') continue;
    if (!best || representation.bandwidth > best.bandwidth) best = representation;
    if (language && normalizeLanguage(representation.language) === language
      && (!preferred || representation.bandwidth > preferred.bandwidth)) preferred = representation;
  }
  return preferred ?? best;
}
