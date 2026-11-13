-- ============================================================================
-- RHODES · migration 0001 · initial shared schema
-- ============================================================================
-- Establishes the relational model for one organizational workspace served by the
-- RHODES API. This migration creates SCHEMA ONLY. It inserts no records: a freshly
-- initialized database is empty by design (§ requirement 3 of LAN-1).
--
-- ── modelling rules encoded here ─────────────────────────────────────────────
--
-- 1. PERSONNEL ARE NOT LOGIN ACCOUNTS.
--    `personnel` describes people who attend meetings, including people who will
--    never sign in. Authentication tables (`users`, `sessions`) arrive in a later
--    phase; this schema is shaped so they can be added without rewriting anything.
--
-- 2. ATTENDANCE IS A ROW, NOT A JSON MAP.
--    The existing browser application stores `attendance` as a JSON object inside
--    the meeting record, so two organisers marking different people collide on the
--    same row. Here every participant has their own row and their own version.
--
-- 3. MUTABLE RECORDS CARRY `row_version` + timestamps.
--    `row_version` starts at 1 and is incremented by the API on every accepted
--    update; it is the basis of optimistic concurrency in a later phase. The
--    database does not bump it (no trigger): the server writes it explicitly inside
--    the same transaction as the change, so a version can never advance without a
--    committed edit.
--
-- 4. HISTORICAL RELATIONSHIPS SURVIVE DELETION.
--    · References to PEOPLE are `ON DELETE RESTRICT`. Deleting a person must never
--      erase their attendance history, minutes or decisions; the application must
--      detach references explicitly, and that act is auditable.
--    · Rows that exist only as part of a meeting (attendees, agenda items, notes,
--      note revisions, decisions, action items) cascade with that meeting, because
--      they have no meaning without it. Meetings themselves are SOFT-deleted
--      (`deleted_at`), so this cascade is a safety net, not the normal path.
--    · `agenda_item_id` on decisions/actions is `ON DELETE SET NULL`: it points at
--      a discussion topic, not at an identity, and detaching is the documented
--      behaviour of the existing application.
--
-- 5. USER INTERFACE SETTINGS ARE NOT HERE.
--    Theme, motion, density, font size and date/time format are personal display
--    preferences. They stay local to each workstation. Putting them in the shared
--    database would let one person's theme change another person's screen.
--
-- 6. DATES AND TIMES.
--    `meeting_date`, `start_time` and `end_time` are LOCAL wall-clock values, which
--    is exactly how the current application models them. Only audit columns and
--    created/updated stamps are UTC ISO-8601.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- personnel — the roster. Not accounts.
-- ─────────────────────────────────────────────────────────────────────────────
create table personnel (
  id            integer primary key,
  -- Stable external identifier, safe to expose in URLs and exports.
  public_id     text    not null unique default (lower(hex(randomblob(16)))),
  -- Original browser id (e.g. 'p_amara'), filled by the controlled import phase.
  legacy_id     text    unique,
  code          text    not null,
  full_name     text    not null check (length(trim(full_name)) > 0),
  role          text    not null default '',
  department    text    not null default '',
  email         text,
  phone         text    not null default '',
  notes         text    not null default '',
  active        integer not null default 1 check (active in (0, 1)),
  row_version   integer not null default 1 check (row_version >= 1),
  created_at    text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    text,
  check (email is null or length(trim(email)) > 0)
);

-- A personnel code is unique among live records, and may be reused after the
-- previous holder is soft-deleted. A bare UNIQUE constraint would block reuse
-- forever and force operators to invent codes.
create unique index ux_personnel_code_live on personnel (code) where deleted_at is null;
create index ix_personnel_deleted_at on personnel (deleted_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- meetings
-- ─────────────────────────────────────────────────────────────────────────────
create table meetings (
  id                 integer primary key,
  public_id          text    not null unique default (lower(hex(randomblob(16)))),
  legacy_id          text    unique,
  title              text    not null check (length(trim(title)) > 0),
  purpose            text    not null default '',
  meeting_type       text    not null default 'in-person'
                     check (meeting_type in ('in-person', 'online', 'hybrid')),
  -- Manually entered by the organiser. RHODES never creates a meeting room and
  -- never calls a calendar API.
  meet_url           text,
  meeting_date       text    not null
                     check (meeting_date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time         text    not null default ''
                     check (start_time = '' or start_time glob '[0-9][0-9]:[0-9][0-9]'),
  end_time           text    not null default ''
                     check (end_time = '' or end_time glob '[0-9][0-9]:[0-9][0-9]'),
  venue              text    not null default '',
  organizer_person_id integer references personnel (id) on delete restrict,
  status             text    not null default 'upcoming'
                     check (status in ('upcoming', 'in-progress', 'completed', 'cancelled')),
  closing_notes      text    not null default '',
  next_meeting_date  text,
  minute_override    text,
  row_version        integer not null default 1 check (row_version >= 1),
  created_at         text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at         text,
  -- A Meet link only makes sense on an online or hybrid meeting; an in-person
  -- meeting cannot carry a stale one.
  check (meet_url is null or meeting_type in ('online', 'hybrid')),
  check (meet_url is null or meet_url like 'https://%')
);

create index ix_meetings_date on meetings (meeting_date);
create index ix_meetings_status on meetings (status);
create index ix_meetings_organizer on meetings (organizer_person_id);
create index ix_meetings_deleted_at on meetings (deleted_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- meeting_attendees — one row per participant (see modelling rule 2)
-- ─────────────────────────────────────────────────────────────────────────────
create table meeting_attendees (
  meeting_id  integer not null references meetings (id) on delete cascade,
  person_id   integer not null references personnel (id) on delete restrict,
  invited     integer not null default 1 check (invited in (0, 1)),
  attendance  text    not null default 'invited'
              check (attendance in ('invited', 'present', 'absent', 'excused')),
  row_version integer not null default 1 check (row_version >= 1),
  created_at  text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (meeting_id, person_id)
);

create index ix_attendees_person on meeting_attendees (person_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- agenda_items
-- ─────────────────────────────────────────────────────────────────────────────
create table agenda_items (
  id                  integer primary key,
  public_id           text    not null unique default (lower(hex(randomblob(16)))),
  legacy_id           text    unique,
  meeting_id          integer not null references meetings (id) on delete cascade,
  title               text    not null check (length(trim(title)) > 0),
  description         text    not null default '',
  presenter_person_id integer references personnel (id) on delete restrict,
  estimated_minutes   integer not null default 10 check (estimated_minutes >= 0),
  sort_order          integer not null default 0 check (sort_order >= 0),
  status              text    not null default 'not-started'
                      check (status in ('not-started', 'in-discussion', 'discussed', 'skipped', 'postponed')),
  row_version         integer not null default 1 check (row_version >= 1),
  created_at          text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at          text
);

create index ix_agenda_meeting_order on agenda_items (meeting_id, sort_order);
create index ix_agenda_presenter on agenda_items (presenter_person_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- meeting_notes — one note document per meeting, plus its revision history
-- ─────────────────────────────────────────────────────────────────────────────
create table meeting_notes (
  meeting_id  integer primary key references meetings (id) on delete cascade,
  content     text    not null default '',
  row_version integer not null default 1 check (row_version >= 1),
  created_at  text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Placeholder for the account id introduced in the accounts phase.
  updated_by  text
);

-- Every accepted save of the note document is appended here BEFORE the current
-- content is replaced, so a conflict can never destroy prose that someone typed.
create table note_revisions (
  id          integer primary key,
  meeting_id  integer not null references meetings (id) on delete cascade,
  revision_no integer not null check (revision_no >= 1),
  content     text    not null,
  author      text,
  created_at  text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (meeting_id, revision_no)
);

create index ix_note_revisions_meeting on note_revisions (meeting_id, revision_no);

-- A revision is immutable once written. Rewriting one would destroy the very record
-- that exists to recover lost prose, so UPDATE is refused outright.
--
-- DELETE is deliberately NOT blocked by a trigger: revisions are removed only by the
-- cascade from a hard-deleted meeting, and a trigger cannot distinguish that cascade
-- from a direct delete. Meetings are soft-deleted (`deleted_at`), so in normal
-- operation nothing here is ever removed; the application rule is that revision
-- history is never deleted on its own.
create trigger trg_note_revisions_no_update
before update on note_revisions
begin
  select raise(abort, 'note_revisions is append-only');
end;

-- ─────────────────────────────────────────────────────────────────────────────
-- decisions
-- ─────────────────────────────────────────────────────────────────────────────
create table decisions (
  id                     integer primary key,
  public_id              text    not null unique default (lower(hex(randomblob(16)))),
  legacy_id              text    unique,
  meeting_id             integer not null references meetings (id) on delete cascade,
  agenda_item_id         integer references agenda_items (id) on delete set null,
  title                  text    not null check (length(trim(title)) > 0),
  description            text    not null default '',
  approved_by_person_id  integer references personnel (id) on delete restrict,
  decision_date          text    not null default ''
                         check (decision_date = ''
                                or decision_date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status                 text    not null default 'proposed'
                         check (status in ('proposed', 'approved', 'rejected', 'deferred')),
  row_version            integer not null default 1 check (row_version >= 1),
  created_at             text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at             text
);

create index ix_decisions_meeting on decisions (meeting_id);
create index ix_decisions_agenda on decisions (agenda_item_id);
create index ix_decisions_approved_by on decisions (approved_by_person_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- action_items
-- ─────────────────────────────────────────────────────────────────────────────
create table action_items (
  id                integer primary key,
  public_id         text    not null unique default (lower(hex(randomblob(16)))),
  legacy_id         text    unique,
  meeting_id        integer not null references meetings (id) on delete cascade,
  agenda_item_id    integer references agenda_items (id) on delete set null,
  title             text    not null check (length(trim(title)) > 0),
  description       text    not null default '',
  assignee_person_id integer references personnel (id) on delete restrict,
  due_date          text    not null default ''
                    check (due_date = ''
                           or due_date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  priority          text    not null default 'medium'
                    check (priority in ('low', 'medium', 'high', 'critical')),
  status            text    not null default 'pending'
                    check (status in ('pending', 'in-progress', 'completed')),
  row_version       integer not null default 1 check (row_version >= 1),
  created_at        text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at        text
);

create index ix_action_items_meeting on action_items (meeting_id);
create index ix_action_items_agenda on action_items (agenda_item_id);
create index ix_action_items_assignee on action_items (assignee_person_id);
create index ix_action_items_status on action_items (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_records — WHO did WHAT, written by the API
-- ─────────────────────────────────────────────────────────────────────────────
-- `actor` is a text placeholder for the account identity added in a later phase.
-- It is NULL for system actions (migrations, scheduled maintenance).
-- `detail` must never contain credentials, session tokens, or recipient address
-- lists: an audit trail is not a second copy of personal data.
create table audit_records (
  id          integer primary key,
  occurred_at text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor       text,
  action      text    not null,
  entity      text    not null,
  entity_key  text,
  outcome     text    not null default 'ok' check (outcome in ('ok', 'denied', 'conflict', 'error')),
  detail      text
);

create index ix_audit_occurred_at on audit_records (occurred_at);
create index ix_audit_entity on audit_records (entity, entity_key);
