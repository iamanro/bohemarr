/** Thrown by work run in an Account session when the upstream refuses that session. */
export class SessionRejected extends Error {}

/** A session plus when it stops being usable (epoch ms); no `expiresAt` means until rejected. */
export interface SessionGrant<S> {
  session: S;
  expiresAt?: number;
}

/** How one provider obtains its Account session. */
export interface SessionSource<S> {
  /** Provider id, used in error messages. */
  label: string;
  /** A full login; absent when no account credentials are configured. */
  login?(signal: AbortSignal): Promise<SessionGrant<S>>;
  /** Renews an expiring session without a full login; a rejection still forces `login`. */
  refresh?(session: S, signal: AbortSignal): Promise<SessionGrant<S>>;
  /** A session configured for the provider, used until it expires or is rejected. */
  seed?: SessionGrant<S>;
}

/** Sessions are renewed this long before they expire, so work never starts on a dying session. */
const RENEW_MARGIN_MS = 30_000;

interface Pending<S> {
  grant: Promise<SessionGrant<S>>;
  controller: AbortController;
  waiters: number;
  /** A refresh renews the same upstream session, so it cannot replace a rejected one. */
  refreshing: boolean;
}

/**
 * A provider's Account session. `run` hands work a valid session: logins are shared by concurrent
 * callers, a session nearing its expiry is refreshed (or replaced by a login), and when the work
 * throws `SessionRejected` the session is discarded and the work retried exactly once with a new
 * login. Aborting a caller abandons its wait; a shared login is aborted only when every caller
 * waiting for it has aborted.
 */
export class AccountSession<S> {
  private current: SessionGrant<S> | undefined;
  private pending: Pending<S> | undefined;
  private readonly source: SessionSource<S>;
  private readonly now: () => number;

  constructor(source: SessionSource<S>, now: () => number = Date.now) {
    this.source = source;
    this.now = now;
    this.current = source.seed;
  }

  async run<T>(work: (session: S, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const first = await this.grant(signal);
    try {
      return await work(first.session, signal);
    } catch (error) {
      if (!(error instanceof SessionRejected)) throw error;
      if (this.current === first) this.current = undefined;
      const second = await this.grant(signal, true);
      return work(second.session, signal);
    }
  }

  private async grant(signal: AbortSignal, afterRejection = false): Promise<SessionGrant<S>> {
    signal.throwIfAborted();
    const current = this.current;
    if (current && !this.expiring(current)) return current;
    if (!this.pending || (afterRejection && this.pending.refreshing)) {
      this.pending = this.renew(current && !afterRejection ? current : undefined, afterRejection);
    }
    return this.wait(this.pending, signal);
  }

  private expiring(grant: SessionGrant<S>): boolean {
    return grant.expiresAt !== undefined && this.now() >= grant.expiresAt - RENEW_MARGIN_MS;
  }

  private renew(expiring: SessionGrant<S> | undefined, afterRejection: boolean): Pending<S> {
    const controller = new AbortController();
    const source = this.source;
    const refreshing = expiring !== undefined && source.refresh !== undefined;
    const obtain = async (): Promise<SessionGrant<S>> => {
      if (refreshing) return source.refresh!(expiring!.session, controller.signal);
      if (!source.login) {
        throw new Error(
          afterRejection || expiring
            ? `${source.label}: the configured session is no longer accepted and no username/password is configured`
            : `${source.label}: no username/password is configured`,
        );
      }
      return source.login(controller.signal);
    };
    const pending: Pending<S> = {
      controller,
      waiters: 0,
      refreshing,
      grant: obtain().then(
        grant => {
          if (this.pending === pending) {
            this.pending = undefined;
            this.current = grant;
          }
          return grant;
        },
        (error: unknown) => {
          if (this.pending === pending) this.pending = undefined;
          throw error;
        },
      ),
    };
    return pending;
  }

  private async wait(pending: Pending<S>, signal: AbortSignal): Promise<SessionGrant<S>> {
    pending.waiters++;
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => {
      aborted.reject(signal.reason);
      if (--pending.waiters === 0) {
        if (this.pending === pending) this.pending = undefined;
        pending.controller.abort(signal.reason);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([pending.grant, aborted.promise]);
    } finally {
      if (!signal.aborted) {
        pending.waiters--;
        signal.removeEventListener('abort', onAbort);
      }
    }
  }
}
