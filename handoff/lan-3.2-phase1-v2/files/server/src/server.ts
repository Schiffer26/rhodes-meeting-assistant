/**
 * RHODES API · HTTP(S) server lifecycle
 *
 * `startServer` takes the already-built Express app, a host/port, and — when the
 * configuration validated a certificate — the TLS options derived from it. It performs no
 * configuration reading and makes no safety decision: the loopback-only rule lives in
 * `config.ts`, and the protocol floor lives in `tls.ts`, so there is exactly one place
 * where a non-loopback bind can be refused and exactly one place where a TLS version can
 * be excluded.
 *
 * Shutdown is explicit and ordered by the caller: stop accepting requests, finish
 * in-flight ones, then close the database. Keep-alive sockets would otherwise keep the
 * process alive after `close()`, so they are ended as well. Both listeners need the same
 * treatment; an HTTPS server that kept a socket open would look like a hung shutdown.
 */

import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';

import type { Express } from 'express';

import { AppError } from './errors.js';
import { logger } from './logger.js';
import type { TlsServerOptions } from './tls.js';

/** Both listeners expose the same lifecycle methods; callers never need to know which. */
export type RhodesServer = Server | HttpsServer;

export type Transport = 'http' | 'https';

export interface StartServerOptions {
  readonly host: string;
  readonly port: number;
  /**
   * Validated material from `config.ts`. Absent or null means plain HTTP, which is the
   * LAN-2.1a behaviour and stays the default.
   */
  readonly tls?: TlsServerOptions | null;
}

/**
 * Whether the listener actually stopped accepting work.
 *
 * `server.close()` reports its own failure through the callback error, which the
 * previous implementation dropped on the floor — so a listener that never closed was
 * indistinguishable from one that did. A listener that was never started (or was
 * already stopped) is not a failure: it is reported as `alreadyClosed`, which is a
 * different fact from "this call closed it".
 */
export interface ListenerCloseOutcome {
  closed: boolean;
  alreadyClosed: boolean;
  /** True when the 500 ms hard stop had to destroy sockets that ignored the close. */
  forcedSockets: boolean;
  error?: { code?: string; message: string };
}

export interface StartedServer {
  readonly host: string;
  readonly port: number;
  /** `http` or `https`, so a log line and a URL can never disagree. */
  readonly protocol: Transport;
  /** e.g. `https://127.0.0.1:4317` — convenient for logs and tests, never returned by the API. */
  readonly url: string;
  readonly server: RhodesServer;
  /** Stop accepting and finish in-flight requests. Safe to call more than once. */
  close(): Promise<ListenerCloseOutcome>;
}

function formatHostForUrl(host: string): string {
  // IPv6 literals need brackets in a URL.
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function startServer(app: Express, options: StartServerOptions): Promise<StartedServer> {
  const tls = options.tls ?? null;
  const protocol: Transport = tls === null ? 'http' : 'https';

  // The only difference between the two transports is which factory builds the listener.
  // Everything downstream — routing, middleware, shutdown, error handling — is identical.
  const server: RhodesServer = tls === null ? createServer(app) : createHttpsServer(tls, app);

  return new Promise<StartedServer>((resolve, reject) => {
    const onError = (error: Error & { code?: string }) => {
      server.removeListener('listening', onListening);
      reject(
        new AppError('http.bind_failed', `The service could not listen on ${options.host}:${options.port}.`, {
          httpStatus: 500,
          exposure: 'safe',
          details: { reason: error.message, code: error.code, protocol },
          cause: error,
        }),
      );
    };

    const onListening = () => {
      server.removeListener('error', onError);
      // Errors that arrive after a successful bind are logged, not fatal.
      server.on('error', (error: Error) => logger.error('http.server_error', { reason: error.message }));

      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : options.port;

      // The close is performed once; later callers observe the same outcome instead of
      // asking a dead listener to close again.
      let closeOutcome: Promise<ListenerCloseOutcome> | null = null;

      const close = (): Promise<ListenerCloseOutcome> => {
        if (closeOutcome !== null) return closeOutcome;

        closeOutcome = new Promise<ListenerCloseOutcome>((resolve) => {
          let settled = false;
          let forcedSockets = false;

          const finish = (outcome: ListenerCloseOutcome): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
          };

          // Hard stop for sockets that ignore the graceful close. Kept exactly as it
          // was, but whether it fired is now part of the reported outcome.
          const timer = setTimeout(() => {
            forcedSockets = true;
            try {
              server.closeAllConnections();
            } catch {
              // Nothing useful to do: the close callback still reports the real result.
            }
          }, 500);
          timer.unref();

          try {
            server.close((error?: Error) => {
              const code = (error as NodeJS.ErrnoException | undefined)?.code;
              if (error === undefined) {
                finish({ closed: true, alreadyClosed: false, forcedSockets });
              } else if (code === 'ERR_SERVER_NOT_RUNNING') {
                // Never listening, or already closed: the desired end state already
                // holds. Reported as such rather than as a success of this call.
                finish({ closed: true, alreadyClosed: true, forcedSockets });
              } else {
                finish({
                  closed: false,
                  alreadyClosed: false,
                  forcedSockets,
                  error: { code, message: error.message },
                });
              }
            });
            server.closeIdleConnections();
          } catch (error) {
            const described = error as NodeJS.ErrnoException;
            finish({
              closed: false,
              alreadyClosed: false,
              forcedSockets,
              error: { code: described.code, message: described.message },
            });
          }
        });

        return closeOutcome;
      };

      resolve({
        host: options.host,
        port,
        protocol,
        url: `${protocol}://${formatHostForUrl(options.host)}:${port}`,
        server,
        close,
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: options.host, port: options.port, exclusive: true });
  });
}
