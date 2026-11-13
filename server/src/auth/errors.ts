/**
 * RHODES API · authentication error vocabulary
 *
 * Every failure a client can see is one of these. They are deliberately few and
 * generic: the same 401 message covers "no such user", "wrong password" and "account
 * disabled", so a response cannot be used to enumerate accounts.
 */

import { AppError } from '../errors.js';

/** The one response for every failed credential check. */
export function invalidCredentials(): AppError {
  return new AppError('auth.invalid_credentials', 'Invalid username or password.', {
    httpStatus: 401,
    exposure: 'safe',
  });
}

export function unauthenticated(): AppError {
  return new AppError('auth.unauthenticated', 'Authentication is required.', {
    httpStatus: 401,
    exposure: 'safe',
  });
}

export function forbidden(): AppError {
  return new AppError('auth.forbidden', 'You do not have permission to perform this action.', {
    httpStatus: 403,
    exposure: 'safe',
  });
}

export function passwordChangeRequired(): AppError {
  return new AppError(
    'auth.password_change_required',
    'You must change your password before using this part of RHODES.',
    { httpStatus: 403, exposure: 'safe' },
  );
}

export function tooManyAttempts(retryAfterSeconds: number): AppError {
  const error = new AppError(
    'auth.too_many_attempts',
    'Too many sign-in attempts. Wait a moment before trying again.',
    { httpStatus: 429, exposure: 'safe', details: { retryAfterSeconds } },
  );
  return error;
}

export function currentPasswordIncorrect(): AppError {
  return new AppError('auth.current_password_incorrect', 'The current password is not correct.', {
    httpStatus: 400,
    exposure: 'safe',
  });
}

export function accountNotFound(): AppError {
  return new AppError('admin.account_not_found', 'No such account.', {
    httpStatus: 404,
    exposure: 'safe',
  });
}

export function usernameTaken(): AppError {
  return new AppError('admin.username_taken', 'That username is already in use.', {
    httpStatus: 409,
    exposure: 'safe',
  });
}

export function cannotModifySelf(reason: string): AppError {
  return new AppError('admin.cannot_modify_self', reason, { httpStatus: 403, exposure: 'safe' });
}

export function lastAdministrator(): AppError {
  return new AppError(
    'admin.last_administrator',
    'RHODES must keep at least one active administrator. Grant another account the administrator role first.',
    { httpStatus: 409, exposure: 'safe' },
  );
}

export function invalidRole(): AppError {
  return new AppError('admin.invalid_role', 'The role must be administrator or member.', {
    httpStatus: 400,
    exposure: 'safe',
  });
}

export function invalidStatus(): AppError {
  return new AppError('admin.invalid_status', 'The status must be active or disabled.', {
    httpStatus: 400,
    exposure: 'safe',
  });
}

export function invalidPersonnel(): AppError {
  return new AppError('admin.invalid_personnel', 'No Personnel record matches that identifier.', {
    httpStatus: 400,
    exposure: 'safe',
  });
}

export function invalidRequest(message = 'The request could not be understood.'): AppError {
  return new AppError('auth.invalid_request', message, { httpStatus: 400, exposure: 'safe' });
}
