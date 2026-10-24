import { randomUUID } from 'node:crypto';
import { OneplayConnection } from './oneplay-connection.ts';
import type { AuthenticationToken, Device } from './oneplay-protocol.ts';

const AUTOCLOSE_ITEM_AFTER_MS = 20_000;

interface PoolSlot {
  readonly idx: number;
  connection: OneplayConnection | null;
  closeTimer: NodeJS.Timeout | undefined;
}

/** Fixed-capacity, abortable leases over the CMS WebSocket/HTTPS connection pair. */
export class OneplayConnectionPool {
  private readonly slots: PoolSlot[];
  private readonly acquired: boolean[];
  private readonly waitQueue: Array<() => void> = [];
  private authToken: AuthenticationToken | null = null;
  private active = true;
  private readonly device: Device;
  private readonly connect: (clientId: string, device: Device) => OneplayConnection;

  /** `connect` builds a connection for a slot; tests pass a fake. */
  constructor(capacity: number, device: Device, connect = (clientId: string, device: Device) => new OneplayConnection(clientId, device)) {
    this.device = device;
    this.connect = connect;
    this.slots = Array.from({ length: capacity }, (_, idx) => ({ idx, connection: null, closeTimer: undefined }));
    this.acquired = new Array(capacity).fill(false);
  }

  private async acquireSlot(signal: AbortSignal): Promise<PoolSlot> {
    for (;;) {
      signal.throwIfAborted();
      if (!this.active) throw new Error('Oneplay connection pool is not active');
      const idx = this.acquired.findIndex(busy => !busy);
      if (idx !== -1) {
        this.acquired[idx] = true;
        const slot = this.slots[idx]!;
        clearTimeout(slot.closeTimer);
        slot.closeTimer = undefined;
        try {
          if (!slot.connection?.isOpen()) {
            slot.connection?.close();
            const connection = this.connect(randomUUID(), this.device);
            slot.connection = connection;
            await connection.open(signal);
            if (this.authToken) connection.authenticate(this.authToken);
          }
          signal.throwIfAborted();
          if (!this.active) throw new Error('Oneplay connection pool is not active');
          return slot;
        } catch (error) {
          slot.connection?.close();
          slot.connection = null;
          this.releaseSlot(slot);
          throw error;
        }
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        const index = this.waitQueue.indexOf(wake);
        if (index !== -1) this.waitQueue.splice(index, 1);
      };
      const wake = (): void => { cleanup(); resolve(); };
      const onAbort = (): void => { cleanup(); reject(signal.reason); };
      this.waitQueue.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      await promise;
    }
  }

  private releaseSlot(slot: PoolSlot): void {
    this.acquired[slot.idx] = false;
    if (this.active && slot.connection) {
      slot.closeTimer = setTimeout(() => {
        slot.connection?.close();
        slot.connection = null;
        slot.closeTimer = undefined;
      }, AUTOCLOSE_ITEM_AFTER_MS);
      slot.closeTimer.unref();
    }
    this.waitQueue.shift()?.();
  }

  async withConnection<T>(signal: AbortSignal, fn: (connection: OneplayConnection) => Promise<T>): Promise<T> {
    const slot = await this.acquireSlot(signal);
    try {
      return await fn(slot.connection!);
    } finally {
      this.releaseSlot(slot);
    }
  }

  authenticate(token: AuthenticationToken | null): void {
    this.authToken = token;
    for (const slot of this.slots) slot.connection?.authenticate(token);
  }

  isAuthenticated(): boolean {
    return this.authToken !== null;
  }

  async close(): Promise<void> {
    this.active = false;
    for (const slot of this.slots) {
      clearTimeout(slot.closeTimer);
      slot.connection?.close();
      slot.connection = null;
      slot.closeTimer = undefined;
    }
    for (const wake of this.waitQueue.splice(0)) wake();
  }
}
