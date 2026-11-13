-- ============================================================================
-- RHODES · migration 0003 · authentication and authorization
-- ============================================================================
-- Introduces individual login accounts and server-side sessions for the RHODES API.
-- Backend only: no client is connected to these endpoints yet, and the listener remains
-- bound to loopback.
--
-- ── accounts are not people ─────────────────────────────────────────────────
--
-- `personnel` describes who attends meetings, including people who will never sign in.
-- `user_accounts` describes who may use the application. They are separate tables on
-- purpose:
--
--   · creating a Personnel record never creates a login account (nothing here does that);
--   · an account may link to at most one Personnel record, optionally;
--   · deleting a person who is linked to an account is refused (`ON DELETE RESTRICT`),
--     so history cannot lose the human it belongs to.
--
-- ── sessions ────────────────────────────────────────────────────────────────
--
-- Only a SHA-256 hash of the session token is stored. The raw token exists in exactly
-- two places: the response to a successful login, and the client that received it.
-- A copy of this database therefore cannot be used to impersonate anyone.
--
-- ── what is deliberately absent ─────────────────────────────────────────────
--
--   · no default account, no seeded password, no demo user;
--   · no MFA (documented as a future enhancement, not an implemented feature);
--   · no password recovery by email — recovery is a local operator command;
--   · no role or permission cache: the account row is read on every protected request.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- user_accounts
-- ─────────────────────────────────────────────────────────────────────────────
create table user_accounts (
  id                   integer primary key,
  public_id            text    not null unique default (lower(hex(randomblob(16)))),
  -- As typed by the administrator; shown back in the UI and in audit entries.
  username             text    not null check (length(username) between 3 and 64),
  -- Case-insensitive uniqueness is enforced here, not by hoping callers agree.
  username_normalized  text    not null unique
                       check (username_normalized = lower(username_normalized)
                              and length(username_normalized) between 3 and 64),
  -- Self-describing, versioned hash: algorithm, parameters, salt and derived key.
  -- This column never contains a password.
  password_hash        text    not null check (length(password_hash) > 0),
  role                 text    not null check (role in ('administrator', 'member')),
  status               text    not null default 'active' check (status in ('active', 'disabled')),
  must_change_password integer not null default 0 check (must_change_password in (0, 1)),
  -- Optional link to a Personnel record. UNIQUE permits many NULLs (unlinked accounts)
  -- while guaranteeing that one person cannot hold two accounts.
  personnel_id         integer unique references personnel (id) on delete restrict,
  row_version          integer not null default 1 check (row_version >= 1),
  password_changed_at  text,
  disabled_at          text,
  created_at           text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index ix_user_accounts_role on user_accounts (role);
create index ix_user_accounts_status on user_accounts (status);
create index ix_user_accounts_personnel on user_accounts (personnel_id);

-- Accounts are disabled, never deleted. `status` and `disabled_at` carry that policy,
-- and this trigger makes it hold even for a statement that forgot about it. A future
-- legal erasure request would have to be an explicit, separately reviewed procedure —
-- the same rule the note-revision history follows.
create trigger if not exists trg_user_accounts_no_delete
before delete on user_accounts
begin
  select raise(abort, 'user accounts cannot be deleted; disable the account instead');
end;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_sessions
-- ─────────────────────────────────────────────────────────────────────────────
create table user_sessions (
  id              integer primary key,
  public_id       text    not null unique default (lower(hex(randomblob(16)))),
  user_account_id integer not null references user_accounts (id) on delete restrict,
  -- SHA-256 of the opaque token, hex. Never the token itself.
  token_hash      text    not null unique check (length(token_hash) = 64),
  created_at      text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Absolute expiry: eight hours after creation. No sliding renewal in this phase.
  expires_at      text    not null,
  revoked_at      text,
  -- Why the session ended, for the operator. Values are a closed set so a typo cannot
  -- create an unqueryable state.
  revoked_reason  text    check (revoked_reason is null
                                 or revoked_reason in ('logout', 'password_change',
                                    'password_reset', 'admin_recovery', 'role_change',
                                    'account_disabled', 'expired_cleanup')),
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index ix_user_sessions_account on user_sessions (user_account_id);
create index ix_user_sessions_expires on user_sessions (expires_at);
create index ix_user_sessions_revoked on user_sessions (revoked_at);

-- Session rows are meant to be deleted once they expire or are revoked: they are
-- operational state, not history. The security history lives in `audit_records`.

-- ─────────────────────────────────────────────────────────────────────────────
-- audit history is append-only
-- ─────────────────────────────────────────────────────────────────────────────
-- `audit_records` already exists (migration 0001) with the shape this phase needs:
-- occurred_at, actor, action, entity, entity_key, outcome, detail. It is reused as-is;
-- no second audit table is introduced. These two triggers make it immutable, so an
-- incident cannot be reviewed from a trail that someone edited afterwards.
--
-- Never write passwords, password hashes, session tokens or Authorization headers into
-- `detail` — the audit trail is a record of events, not a copy of credentials.

create trigger if not exists trg_audit_records_no_update
before update on audit_records
begin
  select raise(abort, 'audit history is append-only');
end;

create trigger if not exists trg_audit_records_no_delete
before delete on audit_records
begin
  select raise(abort, 'audit history is append-only');
end;
