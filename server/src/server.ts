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

export interface StartedServer {
  readonly host: string;
  readonly port: number;
  /** `http` or `https`, so a log line and a URL can never disagree. */
  readonly protocol: Transport;
  /** e.g. `https://127.0.0.1:4317` — convenient for logs and tests, never returned by the API. */
  readonly url: string;
  readonly server: RhodesServer;
  close(): Promise<void>;
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

      const close = (): Promise<void> =>
        new Promise<void>((done) => {
          server.close(() => done());
          server.closeIdleConnections();
          // Hard stop for sockets that ignore the graceful close.
          const timer = setTimeout(() => server.closeAllConnections(), 500);
          timer.unref();
        });

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
