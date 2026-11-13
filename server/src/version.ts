/**
 * Service identity reported by /api/health.
 *
 * Kept as a constant rather than a JSON import so the value survives compilation,
 * bundling and packaging identically. `SERVICE_VERSION` mirrors server/package.json
 * `version`; the health test asserts the two agree, so they cannot drift silently.
 */
export const SERVICE_NAME = 'rhodes-api';
export const SERVICE_VERSION = '0.1.0';
/** Bumped only when the wire contract of the API changes in a breaking way. */
export const API_VERSION = 1;
