/**
 * RHODES API · GET /api/health
 *
 * The only endpoint in this phase, and it exists so an operator (or a future
 * launcher) can answer one question: is the service up AND is the database usable?
 *
 * Deliberate omissions — these are forbidden by the phase requirements:
 *   · no filesystem paths, no data directory, no database file name
 *   · no configuration values, no environment, no credentials, no tokens
 *   · no schema dump, no row counts, no personnel or meeting data
 *
 * The payload is a fixed shape with small, stable keys so a monitor can parse it
 * without guessing. A failing database check yields 503 with the same shape.
 */

import type { Request, Response } from 'express';

import type { RhodesDatabase } from '../db/index.js';
import { describeError } from '../errors.js';
import { logger } from '../logger.js';
import { API_VERSION, SERVICE_NAME, SERVICE_VERSION } from '../version.js';

export interface HealthPayload {
  status: 'ok' | 'unavailable';
  service: string;
  version: string;
  apiVersion: number;
  database: { status: 'ok' | 'error'; schemaVersion: number };
  uptimeSeconds: number;
}

export interface HealthDependencies {
  readonly db: Pick<RhodesDatabase, 'healthCheck' | 'schemaVersion'>;
  /** Injectable for deterministic tests. */
  readonly uptimeSeconds?: () => number;
}

/** Built as a function of the probe so the same shape is reused on failure. */
export function buildHealthPayload(status: 'ok' | 'unavailable', schemaVersion: number, uptimeSeconds: number): HealthPayload {
  return {
    status,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    apiVersion: API_VERSION,
    database: { status: status === 'ok' ? 'ok' : 'error', schemaVersion },
    uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)),
  };
}

export function createHealthHandler(deps: HealthDependencies) {
  const uptime = deps.uptimeSeconds ?? (() => process.uptime());

  return function healthHandler(_req: Request, res: Response): void {
    res.setHeader('cache-control', 'no-store');
    try {
      deps.db.healthCheck();
      const schemaVersion = deps.db.schemaVersion();
      res.status(200).json(buildHealthPayload('ok', schemaVersion, uptime()));
    } catch (error) {
      // The reason stays in the log; the caller gets status only.
      logger.error('health.database_unavailable', { reason: describeError(error).message });
      res.status(503).json(buildHealthPayload('unavailable', 0, uptime()));
    }
  };
}
