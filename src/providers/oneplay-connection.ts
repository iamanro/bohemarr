import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import {
  ASYNC_RESPONSE_TIMEOUT_MS,
  HTTP_BASE,
  WS_BASE,
  at,
  createRequestBody,
  type AuthenticationToken,
  type ConnectionContext,
  type Device,
  type OneplayRequestOptions,
  type OneplayResponse,
} from './oneplay-protocol.ts';

interface PendingWaiter {
  readonly resolve: (response: OneplayResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/**
 * Single WebSocket + HTTPS pairing to the Oneplay CMS, ported from
 * `sune.app.mediadown.media_engine.novavoyo.Connection`.
 *
 * The WebSocket only carries the init handshake, keepalive pings, and asynchronous
 * ("OkAsync") replies pushed by the server; actual commands are POSTed over HTTPS and,
 * for async replies, matched back to the WebSocket push by `context.requestId`.
 */
export class OneplayConnection {
  readonly clientId: string;
  private readonly device: Device;
  private ws: WebSocket | null = null;
  private context: ConnectionContext | null = null;
  private authToken: AuthenticationToken | null = null;
  private openPromise: Promise<void> | null = null;
  private readonly pendingResponses = new Map<string, OneplayResponse>();
  private readonly waiters = new Map<string, PendingWaiter>();

  constructor(clientId: string, device: Device) {
    this.clientId = clientId;
    this.device = device;
  }

  authenticate(token: AuthenticationToken | null): void {
    this.authToken = token;
  }

  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  isOpen(): boolean {
    return this.context !== null && this.ws?.readyState === WebSocket.OPEN;
  }

  async open(signal: AbortSignal): Promise<this> {
    signal.throwIfAborted();
    if (!this.openPromise) this.openPromise = this.doOpen(AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
    await this.openPromise;
    return this;
  }

  private doOpen(signal: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // ws 8.21+ already bounds maxPayload, maxBufferedChunks and maxFragments by default.
    const ws = new WebSocket(WS_BASE + this.clientId, { handshakeTimeout: 45_000 });
    this.ws = ws;
    let settled = false;

    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      settleReject(new Error('Oneplay connection handshake aborted', { cause: signal.reason }));
      ws.terminate();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    ws.on('message', (data: RawData) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return; // Ignore malformed frames, mirroring the upstream client's silent tolerance.
      }
      if (!this.context) {
        this.handleInitMessage(json, settleResolve, settleReject);
        return;
      }
      this.handleOpenMessage(json);
    });

    ws.on('error', (error: Error) => settleReject(error));
    ws.on('close', () => this.handleClose(settleReject));

    return promise;
  }

  private handleInitMessage(
    json: unknown,
    settleResolve: () => void,
    settleReject: (error: Error) => void,
  ): void {
    const status = at<string>(json, 'result.status');
    if (status !== 'Ok') {
      settleReject(new Error(`Oneplay connection init failed: ${status ?? 'unknown status'}`));
      return;
    }
    if (at<string>(json, 'result.schema') === 'ConnectionInitData') {
      const sessionId = at<string>(json, 'data.sessionId') ?? '';
      const serverId = at<string>(json, 'data.serverId') ?? '';
      this.context = { device: this.device, clientId: this.clientId, sessionId, serverId };
    }
    settleResolve();
  }

  private handleOpenMessage(json: unknown): void {
    if (at<string>(json, 'schema') === 'Ping') {
      this.ws?.send('{"schema":"Pong"}');
      return;
    }
    this.handleResponseMessage(json);
  }

  private handleResponseMessage(json: unknown): void {
    const reply = pushedReply(json);
    if (!reply) return;
    const { requestId, response: resolved } = reply;

    const waiter = this.waiters.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.waiters.delete(requestId);
      waiter.resolve(resolved);
    } else {
      this.pendingResponses.set(requestId, resolved);
    }
  }

  private handleClose(settleReject: (error: Error) => void): void {
    settleReject(new Error('Oneplay connection closed before init'));
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new Error('Oneplay connection closed'));
    }
    this.waiters.clear();
    this.context = null;
  }

  /** `Connection.close` / `WS.close` (`ws.abort()`): tear down immediately, no graceful handshake. */
  close(): void {
    this.ws?.terminate();
    this.ws = null;
    this.context = null;
    this.openPromise = null;
    this.pendingResponses.clear();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new Error('Oneplay connection closed'));
    }
    this.waiters.clear();
  }

  private awaitAsyncResponse(requestId: string, signal: AbortSignal): Promise<OneplayResponse> {
    signal.throwIfAborted();
    const existing = this.pendingResponses.get(requestId);
    if (existing) {
      this.pendingResponses.delete(requestId);
      return Promise.resolve(existing);
    }
    const { promise, resolve, reject } = Promise.withResolvers<OneplayResponse>();
    const cleanup = (): void => {
      clearTimeout(timer);
      this.waiters.delete(requestId);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('Oneplay request aborted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Oneplay async response for ${requestId} timed out`));
    }, ASYNC_RESPONSE_TIMEOUT_MS);
    this.waiters.set(requestId, { resolve, reject, timer, signal, onAbort });
    signal.addEventListener('abort', onAbort, { once: true });
    return promise;
  }

  /** `Connection.request` (all four overloads collapse to one options bag here). */
  async request(path: string, options: OneplayRequestOptions, signal: AbortSignal): Promise<OneplayResponse> {
    if (!this.context) throw new Error('Oneplay connection is not initialized');
    const requestId = randomUUID();
    const body = createRequestBody(this.context, requestId, options);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken.value}`;

    const response = await fetch(new URL(path, HTTP_BASE), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    });
    if (response.status === 401) {
      await response.body?.cancel();
      return { command: path, status: 'Unauthorized', data: { statusCode: 401 } };
    }
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from Oneplay API (${path})`);

    const json: unknown = await response.json();
    const status = at<string>(json, 'result.status');
    if (status === 'Ok') return { command: path, status, data: at(json, 'data') };
    if (status === 'OkAsync') {
      const asyncRequestId = at<string>(json, 'context.requestId');
      if (!asyncRequestId) throw new Error('Oneplay response is missing a request ID');
      return this.awaitAsyncResponse(asyncRequestId, signal);
    }
    return { command: path, status, data: json };
  }

  /** `Connection.command`: wraps args + schema into a `{ payload: { command: {...} } }` envelope. */
  async command(
    path: string,
    schema: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<OneplayResponse> {
    return this.request(path, { payload: { command: { ...args, schema } } }, signal);
  }
}

/**
 * The reply a WebSocket push carries for an "OkAsync" request. A failed reply keeps the whole
 * response as its data, as a failed sync reply does, so its `result.code` is read the same way.
 */
export function pushedReply(json: unknown): { requestId: string; response: OneplayResponse } | undefined {
  const response = at(json, 'response');
  const requestId = at<string>(response, 'context.requestId');
  if (!requestId) return undefined;
  const status = at<string>(response, 'result.status');
  return { requestId, response: { command: at<string>(json, 'command') ?? '', status, data: status === 'Ok' ? at(response, 'data') : response } };
}
