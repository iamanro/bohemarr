/**
 * Oneplay (jyxo.cz CMS) protocol constants and JSON wire-format builders.
 *
 * Ported from `sune.app.mediadown.media_engine.novavoyo.{Device,Context,Common,Oneplay}`.
 * The upstream client talks to a WebSocket for server push (init handshake + async
 * command replies) and to a parallel HTTPS JSON-RPC-ish endpoint for actual requests;
 * every HTTP request carries a `context` block built from the WebSocket handshake.
 */
import { at } from './common.ts';

export const HTTP_BASE = 'https://http.cms.jyxo.cz/api/v1.12/';
export const WS_BASE = 'wss://ws.cms.jyxo.cz/websocket/';

/** Pinned web-client version string used by the upstream Java client (`Oneplay.APP_VERSION`). */
export const APP_VERSION = 'R12.26';
export const DEVICE_TYPE_WEB = 'web';

export const PROGRAM_LIST_MAX_ITEMS_PER_PAGE = 24;
export const EPISODE_LIST_MAX_ITEMS_PER_PAGE = 12;

/** `Connection.DEFAULT_TIMEOUT_MS`: how long to wait for an async (WebSocket-delivered) reply. */
export const ASYNC_RESPONSE_TIMEOUT_MS = 5_000;

/** `Oneplay.DEFAULT_PARALLELISM`: pool capacity, hardcoded upstream ("Currently not configurable"). */
export const CONNECTION_POOL_CAPACITY = 4;

export interface Device {
  readonly type: string;
  readonly appVersion: string;
  readonly manufacturer: string;
  readonly os: string;
}

/** The fixed web-client device fingerprint the upstream Java client presents (`Oneplay.webDevice`). */
export function webDevice(): Device {
  return { type: DEVICE_TYPE_WEB, appVersion: APP_VERSION, manufacturer: 'Unknown', os: 'Windows' };
}

export interface ConnectionContext {
  readonly device: Device;
  readonly clientId: string;
  readonly sessionId: string;
  readonly serverId: string;
}

export type AuthTokenType = 'NO_PROFILE' | 'FULL';

export interface AuthenticationToken {
  readonly accountId: string;
  readonly type: AuthTokenType;
  readonly value: string;
}

export interface OneplayRequestOptions {
  payload?: Record<string, unknown>;
  customData?: Record<string, unknown>;
  playbackCapabilities?: Record<string, unknown>;
  authorization?: Array<Record<string, unknown>>;
}

export interface OneplayResponse {
  readonly command: string;
  readonly status: string | undefined;
  readonly data: unknown;
}

/** `Connection.createRequest`. */
export function createRequestBody(
  context: ConnectionContext,
  requestId: string,
  options: OneplayRequestOptions,
): Record<string, unknown> {
  const contextBlock: Record<string, unknown> = {
    clientId: context.clientId,
    sessionId: context.sessionId,
    serverId: context.serverId,
    requestId,
  };
  if (options.customData !== undefined) contextBlock.customData = JSON.stringify(options.customData);

  const body: Record<string, unknown> = {
    deviceInfo: {
      deviceType: context.device.type,
      appVersion: context.device.appVersion,
      deviceManufacturer: context.device.manufacturer,
      deviceOs: context.device.os,
    },
    capabilities: { async: 'websockets' },
    context: contextBlock,
  };

  if (options.payload !== undefined) body.payload = options.payload;
  if (options.playbackCapabilities !== undefined) body.playbackCapabilities = options.playbackCapabilities;
  if (options.authorization !== undefined) body.authorization = options.authorization;

  return body;
}

/** `Oneplay.playbackCapabilities`. */
export function playbackCapabilities(): Record<string, unknown> {
  return {
    protocols: ['dash', 'hls'],
    drm: ['widevine'],
    altTransfer: 'Unicast',
    subtitle: {
      formats: ['vtt'],
      locations: ['ExternalTrackLocation'],
    },
    liveSpecificCapabilities: {
      protocols: ['dash', 'hls'],
      drm: ['widevine'],
      altTransfer: 'Unicast',
      multipleAudio: false,
    },
  };
}

/**
 * `Oneplay.resultError`: maps an `{ result: { status, code, message } }` payload to an error,
 * treating a handful of known non-fatal codes as no-op (mirrors the `api_error` handler upstream).
 */
const IGNORED_ERROR_CODES: Record<number, true> = { 5029: true, 4091: true, 4054: true, 4094: true };

export function resultError(data: unknown): Error | null {
  if (at<string>(data, 'result.status') !== 'Error') return null;
  const code = Number.parseInt(at<string>(data, 'result.code') ?? '', 10) || 0;
  if (IGNORED_ERROR_CODES[code]) return null;
  return new Error(at<string>(data, 'result.message') ?? 'Unknown error');
}

/**
 * Extracts a human-readable failure reason from an error response payload. The upstream
 * Java `Authenticator` reads a top-level `message` field here (`response.data().getString(
 * "message", "Unknown reason")`), but live testing against the real API shows the actual text
 * lives at `result.message` for every observed error shape (same path `Oneplay.resultError`
 * already uses) — `message` is checked first only as a defensive fallback.
 */
export function readErrorMessage(data: unknown): string {
  return at<string>(data, 'result.message') ?? at<string>(data, 'message') ?? 'Unknown reason';
}

/** `Oneplay.successData`. */
export function successData(response: OneplayResponse): unknown {
  if (response.status !== 'Ok') {
    const err = resultError(response.data);
    if (err) throw err;
  }
  return response.data;
}
