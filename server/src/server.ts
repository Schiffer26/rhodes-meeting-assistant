/**
 * RHODES API · HTTP server lifecycle
 *
 * `startServer` takes the already-built Express app and a host/port. It performs no
 * configuration reading and makes no safety decision: the loopback-only rule lives in
 * `config.ts`, so there is exactly one place where a non-loopback bind can be refused.
 *
 * Shutdown is explicit and ordered by the caller: stop accepting requests, finish
 * in-flight ones, then close the database. Keep-alive sockets would otherwise keep
 * the process alive after `close()`, so they are ended as well.
 */

import { createServer, type Server } from 'node:http';

import type { Express } from 'express';

import { AppError } from './errors.js';
import { logger } from './logger.js';

export interface StartedServer {
  readonly host: string;
  readonly port: number;
  /** e.g. `http://127.0.0.1:4317` — convenient for logs and tests, never returned by the API. */
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

function formatHostForUrl(host: string): string {
  // IPv6 literals need brackets in a URL.
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function startServer(
  app: Express,
  options: { host: string; port: number },
): Promise<StartedServer> {
  const server = createServer(app);

  return new Promise<StartedServer>((resolve, reject) => {
    const onError = (error: Error & { code?: string }) => {
      server.removeListener('listening', onListening);
      reject(
        new AppError('http.bind_failed', `The service could not listen on ${options.host}:${options.port}.`, {
          httpStatus: 500,
          exposure: 'safe',
          details: { reason: error.message, code: error.code },
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
        url: `http://${formatHostForUrl(options.host)}:${port}`,
        server,
        close,
      });
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: options.host, port: options.port, exclusive: true });
  });
}
