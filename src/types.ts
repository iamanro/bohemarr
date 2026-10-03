export type MediaKind = 'tv' | 'movie';

/** The canonical TVDB record of a series. */
export interface SeriesIdentity {
  tvdbId: number;
  /** TMDB television ID, not a movie ID. */
  tmdbId?: number;
  title: string;
  aliases: string[];
  year?: number;
  country?: string;
}

/** Identity metadata a provider publishes for one of its TV Programs; `id` is the `Program.id`. */
export interface ProgramMetadata {
  id: string;
  title: string;
  aliases: string[];
  year?: number;
  countries: string[];
}

/** The stored, never-reassigned pairing of one Series identity with one Program of one provider. */
export interface SeriesBinding {
  provider: string;
  program: ProgramMetadata;
  identity: SeriesIdentity;
}

export interface SearchQuery {
  /** A bound Program to expand directly; never an inferred title substitution. */
  programId?: string;
  q: string;
  kind?: MediaKind;
  season?: number;
  episode?: number;
  airDate?: string;
  limit: number;
  offset: number;
}

/** Durable source identity. Never persist short-lived playback URLs or credentials here. */
export interface Release {
  id: string;
  provider: string;
  title: string;
  url: string;
  kind: MediaKind;
  series?: string;
  tvdbId?: number;
  /** The TMDB movie ID Radarr supplied for this search. */
  tmdbId?: number;
  programId?: string;
  season?: number;
  episode?: number;
  airDate?: string;
  year?: number;
  publishedAt?: string;
  size?: number;
  sizeEstimated?: boolean;
  height?: number;
  language?: string;
  data?: Record<string, unknown>;
}

export interface License {
  url: string;
  headers?: Record<string, string>;
  pssh?: string[];
  exchange?: (challenge: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
}

export interface MediaSource {
  url: string;
  type: 'file' | 'hls' | 'dash';
  headers?: Record<string, string>;
  height?: number;
  bandwidth?: number;
  audioUrl?: string;
  audioLanguage?: string;
  subtitles?: Array<{ url: string; language: string; headers?: Record<string, string> }>;
  drm?: License;
}

/** A provider's own catalogue entry that holds episodes or is itself a movie. */
export interface Program {
  /** Stable provider-native identity; for TV Programs this is the Release `programId`. */
  id: string;
  title: string;
  /** Known before expansion? Lets browsing skip Programs of the wrong kind without fetching them. */
  kind?: MediaKind;
}

/**
 * The part of a search a Catalogue may use to narrow its upstream requests. Narrowing must be
 * sound: a Catalogue never withholds a Release that satisfies it. Paging, matching, ordering
 * and deduplication are not a Catalogue's concern (see `searchCatalogue`).
 */
export type CatalogueQuery = Pick<SearchQuery, 'q' | 'kind' | 'season' | 'episode' | 'airDate'>;

/** How a provider exposes its Catalogue to `searchCatalogue`. */
export interface Catalogue<P extends Program = Program> {
  /** Programs expanded concurrently while browsing; defaults to 1. */
  concurrency?: number;
  /** Programs in catalogue order. May use `query.q` for an upstream search; must be lazy. */
  programs(query: CatalogueQuery, signal: AbortSignal): AsyncIterable<P>;
  /** Looks up one Program by `Program.id` (a bound TV Program); `undefined` when it no longer exists. */
  program?(id: string, signal: AbortSignal): Promise<P | undefined>;
  /** The Program's Releases, newest first, fetched lazily so browsing can stop early. */
  releases(program: P, query: CatalogueQuery, signal: AbortSignal): AsyncIterable<Release>;
  /** The Release a direct http(s) URL query names, when this provider can resolve that URL. */
  releaseForUrl?(url: URL, query: CatalogueQuery, signal: AbortSignal): Promise<Release | undefined>;
}

export interface Provider {
  id: string;
  name: string;
  catalogue: Catalogue;
  /** Static catalogue entries from `providers.<id>.catalog`; always listed before upstream Programs. */
  entries?: readonly Release[];
  /**
   * Metadata of every TV Program whose name is plausible for `identity`, from the provider's own
   * published year/country data. Only metadata-backed providers implement it; the Series
   * binding module decides whether one of them binds.
   */
  seriesCandidates?(identity: SeriesIdentity, signal: AbortSignal): Promise<ProgramMetadata[]>;
  resolve(release: Release, signal: AbortSignal): Promise<MediaSource[]>;
  close?(): Promise<void>;
}

export interface ProviderConfig {
  enabled?: boolean;
  username?: string;
  password?: string;
  profile?: string;
  deviceId?: string;
  cookies?: string;
  headers?: Record<string, string>;
  catalog?: Release[];
  [key: string]: unknown;
}

export interface Config {
  host: string;
  port: number;
  apiKey: string;
  publicUrl: string;
  dataDir: string;
  downloadsDir: string;
  concurrency: number;
  ffmpeg: string;
  ffprobe: string;
  mp4decrypt: string;
  wvApiUrl: string;
  categories: string[];
  providers: Record<string, ProviderConfig>;
}

export type JobStatus = 'Queued' | 'Downloading' | 'Paused' | 'Completed' | 'Failed';
export interface Job {
  id: string;
  release: Release;
  category: string;
  status: JobStatus;
  priority: number;
  bytes: number;
  totalBytes: number;
  progress: number;
  storage: string;
  error: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** A Queued job does not start before this time (epoch ms); set while playback is busy. */
  retryAt?: number;
  /** When playback was first found busy (epoch ms); the job fails once it stays busy too long. */
  busySince?: number;
}

export interface MediaSegment {
  url: string;
  range?: { start: number; length: number };
}

export interface DownloadProgress {
  bytes: number;
  totalBytes?: number;
  progress?: number;
}
export type DownloadMedia = (
  sources: MediaSource[], outputDir: string, title: string,
  signal: AbortSignal, onProgress: (progress: DownloadProgress) => void,
) => Promise<string>;
