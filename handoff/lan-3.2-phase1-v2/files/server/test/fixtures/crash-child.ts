/**
 * Test fixture: commit, then die without any shutdown.
 *
 * Run by `db-close.test.ts` in a real child process. It opens the database the normal way,
 * writes one meeting inside an explicit transaction, reports that the commit is durable,
 * and then kills itself with SIGKILL — no `close()`, no checkpoint, no signal handler.
 *
 * That is the "power loss" case: the rows must still be there after a reopen, and the WAL
 * left behind by the dead process must be recoverable by SQLite itself rather than tidied
 * away by us. The parent test synchronises on the `committed` line, so there are no sleeps.
 *
 * Usage: node --import tsx test/fixtures/crash-child.ts <dataDir>
 */

import { insertMeeting, openMigrated } from '../helpers.js';

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write('crash-child: a data directory is required\n');
  process.exit(2);
}

const { db } = openMigrated(dataDir);

db.handle.exec('begin');
insertMeeting(db, { title: 'Committed before the crash' });
db.handle.exec('commit');

// Only after the commit is durable does the parent get to see this line.
process.stdout.write('committed\n');

// SIGKILL: the kernel ends us immediately. No flush, no unlink, no checkpoint.
process.kill(process.pid, 'SIGKILL');
