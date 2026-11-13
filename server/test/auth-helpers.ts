/**
 * Authentication test helpers.
 *
 * Fixtures use a deliberately *weaker* scrypt cost than production (N = 2^14 instead of
 * 2^17, roughly 40 ms instead of 300 ms per hash). The stored format is the same, and
 * verification always uses the parameters recorded in the row, so every code path under
 * test is the real one — only the cost differs. Tests that exercise the production
 * parameters call `hashPassword` directly.
 */

import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

import { createAccount, type AccountRow, type Role } from '../src/auth/accounts.js';
import type { RhodesDatabase } from '../src/db/index.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const TEST_SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 } as const;

/** The password every fixture account uses unless it says otherwise. */
export const TEST_PASSWORD = 'correct horse battery staple';
/** A second password, for change-password flows. */
export const TEST_PASSWORD_2 = 'a much better passphrase, honestly';

export async function fastHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, TEST_SCRYPT.keyLength, {
    N: TEST_SCRYPT.N,
    r: TEST_SCRYPT.r,
    p: TEST_SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    '1',
    `N=${TEST_SCRYPT.N},r=${TEST_SCRYPT.r},p=${TEST_SCRYPT.p}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export interface SeedAccountOptions {
  readonly username: string;
  readonly role?: Role;
  readonly password?: string;
  readonly mustChangePassword?: boolean;
  readonly personnelId?: number | null;
}

export async function seedAccount(db: RhodesDatabase, options: SeedAccountOptions): Promise<AccountRow> {
  const password = options.password ?? TEST_PASSWORD;
  return createAccount(db.handle, {
    username: options.username,
    passwordHash: await fastHash(password),
    role: options.role ?? 'member',
    personnelId: options.personnelId ?? null,
    mustChangePassword: options.mustChangePassword ?? false,
    actor: 'test',
  });
}

export interface HttpResponse<T = Record<string, unknown>> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export async function api<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<HttpResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text.length > 0 ? JSON.parse(text) : {}) as T,
  };
}

export async function postJson<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<HttpResponse<T>> {
  return api<T>(baseUrl, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function getJson<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<HttpResponse<T>> {
  return api<T>(baseUrl, path, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export async function patchJson<T = Record<string, unknown>>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<HttpResponse<T>> {
  return api<T>(baseUrl, path, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export interface LoginResult {
  readonly status: number;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly mustChangePassword?: boolean;
  readonly user?: { publicId: string; username: string; role: Role };
  readonly body: Record<string, unknown>;
}

export async function login(baseUrl: string, username: string, password: string): Promise<LoginResult> {
  const response = await postJson<{
    token?: string;
    expiresAt?: string;
    mustChangePassword?: boolean;
    user?: { publicId: string; username: string; role: Role };
  }>(baseUrl, '/api/auth/login', { username, password });
  return {
    status: response.status,
    token: response.body.token,
    expiresAt: response.body.expiresAt,
    mustChangePassword: response.body.mustChangePassword,
    user: response.body.user,
    body: response.body as unknown as Record<string, unknown>,
  };
}

/** Sign in and return the token, failing loudly if the fixture is wrong. */
export async function loginOrThrow(baseUrl: string, username: string, password = TEST_PASSWORD): Promise<string> {
  const result = await login(baseUrl, username, password);
  if (!result.token) throw new Error(`login failed for ${username}: ${JSON.stringify(result.body)}`);
  return result.token;
}

export function errorCode(body: unknown): string | undefined {
  const candidate = body as { error?: { code?: string; message?: string } } | undefined;
  return candidate?.error?.code;
}

export function errorMessage(body: unknown): string | undefined {
  const candidate = body as { error?: { code?: string; message?: string } } | undefined;
  return candidate?.error?.message;
}
