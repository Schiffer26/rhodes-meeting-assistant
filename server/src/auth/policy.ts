/**
 * RHODES API · credential policy
 *
 * One place decides what a username and a password may look like, so the CLI, the
 * login route and the account-administration routes cannot disagree.
 *
 * Passwords are deliberately simple to police: a length floor, a length ceiling, and
 * nothing else. Composition rules ("one capital, one digit, one symbol") produce
 * predictable substitutions like `Password1!` and are no longer recommended; length is
 * what actually costs an attacker. Nothing here trims, normalises or truncates a
 * password — the string the user typed is the string that is hashed, byte for byte.
 */

import { AppError } from '../errors.js';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

/** Usernames are typed on a keyboard and read aloud: keep the alphabet boring. */
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Normalised form used for uniqueness.
 *
 * NFKC folds visually identical code points (a full-width `ａ` becomes `a`), and
 * lower-casing makes `Amara` and `amara` the same account. The database stores this
 * value and puts a UNIQUE constraint on it, so the rule cannot be bypassed by a code
 * path that forgets to check.
 */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/** Length in Unicode code points, so an emoji or an accented letter counts as one. */
export function passwordLength(password: string): number {
  return [...password].length;
}

/**
 * True when a secret is longer than any password this system can hold.
 *
 * Used as a pre-flight guard on the sign-in and change-password paths: a value this long
 * cannot match a stored password (they are all capped at `PASSWORD_MAX_LENGTH`), so it
 * must be refused *before* it is handed to the key-derivation function.
 */
export function passwordExceedsLimit(password: string): boolean {
  return passwordLength(password) > PASSWORD_MAX_LENGTH;
}

export function validateUsername(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('auth.invalid_username', 'A username is required.', {
      httpStatus: 400,
      exposure: 'safe',
    });
  }
  const username = raw.normalize('NFKC').trim();
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    throw new AppError(
      'auth.invalid_username',
      `A username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters.`,
      { httpStatus: 400, exposure: 'safe' },
    );
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new AppError(
      'auth.invalid_username',
      'A username may contain only letters, digits, dots, hyphens and underscores.',
      { httpStatus: 400, exposure: 'safe' },
    );
  }
  return username;
}

/**
 * Validate a password against the policy.
 *
 * Called before any key derivation, so an over-long or empty input never reaches
 * scrypt. The message says what is wrong without echoing the value.
 */
export function validatePassword(password: unknown): string {
  if (typeof password !== 'string') {
    throw new AppError('auth.invalid_password', 'A password is required.', {
      httpStatus: 400,
      exposure: 'safe',
    });
  }
  // Counted in code points, not UTF-16 units: a passphrase written in a non-Latin
  // script should not be measured twice as long as it reads.
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      'auth.password_too_short',
      `A password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
      { httpStatus: 400, exposure: 'safe' },
    );
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      'auth.password_too_long',
      `A password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
      { httpStatus: 400, exposure: 'safe' },
    );
  }
  return password;
}
