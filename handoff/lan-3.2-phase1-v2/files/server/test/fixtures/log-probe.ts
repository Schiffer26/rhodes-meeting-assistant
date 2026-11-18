/**
 * Test fixture: prove the default log routing without patching any stream.
 *
 * The parent test spawns this file and reads the child's stdout and stderr separately, so
 * "info goes to stdout, warn and error go to stderr" is verified by the operating system's
 * own plumbing instead of by replacing `process.stdout.write`.
 *
 * Usage: node --import tsx test/fixtures/log-probe.ts
 */

import { logger } from '../../src/logger.js';

logger.debug('probe.debug');
logger.info('probe.info', { transport: 'http' });
logger.warn('probe.warn');
logger.error('probe.error', { code: 'probe.code' });
