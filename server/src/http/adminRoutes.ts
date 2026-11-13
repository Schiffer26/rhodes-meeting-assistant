/**
 * RHODES API · administrator account management
 *
 *   GET   /api/admin/accounts                     list accounts
 *   POST  /api/admin/accounts                     create an account (temporary password)
 *   PATCH /api/admin/accounts/:public_id          change role and/or status
 *   POST  /api/admin/accounts/:public_id/reset-password
 *
 * Every route requires a live session, the administrator role, and an account that is
 * not still on a temporary password. The role check happens after authentication, and
 * both read the account from the database on this request — a member cannot reach these
 * by editing anything they send.
 *
 * Temporary passwords are generated here, returned exactly once, and never logged or
 * audited. Only the scrypt hash is stored.
 */

import { Router } from 'express';

import type { RhodesDatabase } from '../db/index.js';
import type { Role, AccountStatus } from '../auth/accounts.js';
import {
  createAccount,
  findByPublicId,
  generateTemporaryPassword,
  listAccounts,
  patchAccount,
  resetPasswordByAdministrator,
  toAccountSummary,
} from '../auth/accounts.js';
import {
  accountNotFound,
  cannotModifySelf,
  invalidPersonnel,
  invalidRequest,
} from '../auth/errors.js';
import { currentAuth, requireAuth, requirePasswordChanged, requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import { validatePassword, validateUsername } from '../auth/policy.js';
import { noStore } from './respond.js';

export interface AdminRouteDeps {
  readonly db: RhodesDatabase;
  readonly now: () => Date;
}

function roleOrUndefined(value: unknown): Role | undefined {
  if (value === undefined) return undefined;
  if (value === 'administrator' || value === 'member') return value;
  throw invalidRequest('The role must be administrator or member.');
}

function statusOrUndefined(value: unknown): AccountStatus | undefined {
  if (value === undefined) return undefined;
  if (value === 'active' || value === 'disabled') return value;
  throw invalidRequest('The status must be active or disabled.');
}

export function createAdminRouter(deps: AdminRouteDeps): Router {
  const router = Router();
  router.use(noStore);
  router.use(requireAuth({ db: deps.db.handle, now: deps.now }));
  router.use(requireRole('administrator'));
  router.use(requirePasswordChanged());

  router.get('/accounts', (_req, res) => {
    res.status(200).json({ accounts: listAccounts(deps.db.handle) });
  });

  router.post('/accounts', async (req, res) => {
    const auth = currentAuth(req);
    const db = deps.db.handle;
    const body = (req.body ?? {}) as { username?: unknown; role?: unknown; personnelPublicId?: unknown };

    const username = validateUsername(body.username);
    const role = roleOrUndefined(body.role);
    if (!role) throw invalidRequest('The role must be administrator or member.');

    let personnelId: number | null = null;
    if (body.personnelPublicId !== undefined && body.personnelPublicId !== null) {
      if (typeof body.personnelPublicId !== 'string') throw invalidPersonnel();
      const person = db
        .prepare('select id from personnel where public_id = ? and deleted_at is null')
        .get(body.personnelPublicId) as { id: number } | undefined;
      if (!person) throw invalidPersonnel();
      personnelId = person.id;
    }

    // A temporary password the administrator reads out to the new user. It satisfies the
    // length policy and is discarded by the server the moment it is hashed.
    const temporaryPassword = generateTemporaryPassword();
    validatePassword(temporaryPassword);
    const passwordHash = await hashPassword(temporaryPassword);

    const account = createAccount(db, {
      username,
      passwordHash,
      role,
      personnelId,
      mustChangePassword: true,
      actor: auth.publicId,
      now: deps.now().toISOString(),
    });

    const person = personnelId
      ? (db.prepare('select public_id from personnel where id = ?').get(personnelId) as { public_id: string } | undefined)
      : undefined;

    res.status(201).json({
      account: toAccountSummary(account, person?.public_id ?? null),
      // Shown once. The server keeps only the hash and cannot reproduce this value.
      temporaryPassword,
      mustChangePassword: true,
    });
  });

  router.patch('/accounts/:publicId', (req, res) => {
    const auth = currentAuth(req);
    const body = (req.body ?? {}) as { role?: unknown; status?: unknown };
    const role = roleOrUndefined(body.role);
    const status = statusOrUndefined(body.status);
    if (role === undefined && status === undefined) {
      throw invalidRequest('Supply a role, a status, or both.');
    }

    const result = patchAccount(deps.db.handle, {
      publicId: String(req.params.publicId),
      actorAccountId: auth.accountId,
      actorPublicId: auth.publicId,
      role,
      status,
      now: deps.now().toISOString(),
    });

    res.status(200).json({
      account: toAccountSummary(result.account),
      sessionsRevoked: result.sessionsRevoked,
    });
  });

  router.post('/accounts/:publicId/reset-password', async (req, res) => {
    const auth = currentAuth(req);
    const db = deps.db.handle;

    // Refuse the caller's own account before doing any work: self-service has its own
    // endpoint, and a locked-out administrator has the local recovery command.
    const target = findByPublicId(db, String(req.params.publicId));
    if (!target) throw accountNotFound();
    if (target.id === auth.accountId) {
      throw cannotModifySelf(
        'Use the change-password endpoint for your own account, or the local recovery command if you are locked out.',
      );
    }

    const temporaryPassword = generateTemporaryPassword();
    validatePassword(temporaryPassword);
    const passwordHash = await hashPassword(temporaryPassword);

    const account = resetPasswordByAdministrator(db, {
      publicId: target.public_id,
      passwordHash,
      actorAccountId: auth.accountId,
      actorPublicId: auth.publicId,
      now: deps.now().toISOString(),
    });

    res.status(200).json({
      account: toAccountSummary(account),
      temporaryPassword,
      mustChangePassword: true,
    });
  });

  return router;
}
