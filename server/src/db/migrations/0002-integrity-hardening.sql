-- ============================================================================
-- RHODES · migration 0002 · integrity hardening
-- ============================================================================
-- Closes five gaps found in the LAN-1 review. Nothing here alters 0001: that file is
-- applied, checksummed and immutable. Every rule below is added as a trigger rather
-- than a CHECK constraint because SQLite cannot add a CHECK to an existing table, and
-- rebuilding tables that already carry foreign keys would be far riskier than this.
--
-- ── why triggers are the right tool here ────────────────────────────────────
--
-- 0001's GLOB checks prove a date *looks* like YYYY-MM-DD. They cannot prove it exists:
--
--     date('2025-02-29') -> '2025-03-01'   (normalised, not rejected)
--     date('2026-04-31') -> '2026-05-01'   (normalised, not rejected)
--     date('2026-13-01') -> NULL
--     strftime('%H:%M', '24:00') -> '00:00'
--
-- So the rule is equality against the normalised form: a real value comes back
-- unchanged, an impossible one comes back different or NULL. `IS NOT` is used rather
-- than `!=` because it is null-safe — `NULL != '2026-13-01'` is NULL (false), which
-- would let an invalid value through.
--
-- Dates are validated on INSERT and on UPDATE *of that column only*. A database
-- created before this migration may hold a date that 0001 accepted and this migration
-- rejects; such a row must still be editable (for example, soft-deletable) — only a
-- change to the bad value itself is refused.
--
-- ── 1. calendar dates ───────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────

create trigger if not exists trg_meetings_meeting_date_insert
before insert on meetings
when date(new.meeting_date) is not new.meeting_date
begin
  select raise(abort, 'meetings.meeting_date must be a real calendar date (YYYY-MM-DD)');
end;

create trigger if not exists trg_meetings_meeting_date_update
before update of meeting_date on meetings
when date(new.meeting_date) is not new.meeting_date
begin
  select raise(abort, 'meetings.meeting_date must be a real calendar date (YYYY-MM-DD)');
end;

create trigger if not exists trg_meetings_next_meeting_date_insert
before insert on meetings
when new.next_meeting_date is not null
 and new.next_meeting_date <> ''
 and date(new.next_meeting_date) is not new.next_meeting_date
begin
  select raise(abort, 'meetings.next_meeting_date must be null, empty, or a real calendar date');
end;

create trigger if not exists trg_meetings_next_meeting_date_update
before update of next_meeting_date on meetings
when new.next_meeting_date is not null
 and new.next_meeting_date <> ''
 and date(new.next_meeting_date) is not new.next_meeting_date
begin
  select raise(abort, 'meetings.next_meeting_date must be null, empty, or a real calendar date');
end;

create trigger if not exists trg_decisions_decision_date_insert
before insert on decisions
when new.decision_date <> ''
 and date(new.decision_date) is not new.decision_date
begin
  select raise(abort, 'decisions.decision_date must be empty or a real calendar date');
end;

create trigger if not exists trg_decisions_decision_date_update
before update of decision_date on decisions
when new.decision_date <> ''
 and date(new.decision_date) is not new.decision_date
begin
  select raise(abort, 'decisions.decision_date must be empty or a real calendar date');
end;

create trigger if not exists trg_action_items_due_date_insert
before insert on action_items
when new.due_date <> ''
 and date(new.due_date) is not new.due_date
begin
  select raise(abort, 'action_items.due_date must be empty or a real calendar date');
end;

create trigger if not exists trg_action_items_due_date_update
before update of due_date on action_items
when new.due_date <> ''
 and date(new.due_date) is not new.due_date
begin
  select raise(abort, 'action_items.due_date must be empty or a real calendar date');
end;

-- ── 2. clock times ──────────────────────────────────────────────────────────
-- 24:00 normalises to 00:00 and 12:60 yields NULL, so both fail the equality test.
-- ─────────────────────────────────────────────────────────────────────────────

create trigger if not exists trg_meetings_start_time_insert
before insert on meetings
when new.start_time <> ''
 and strftime('%H:%M', new.start_time) is not new.start_time
begin
  select raise(abort, 'meetings.start_time must be empty or a 24-hour time (HH:MM)');
end;

create trigger if not exists trg_meetings_start_time_update
before update of start_time on meetings
when new.start_time <> ''
 and strftime('%H:%M', new.start_time) is not new.start_time
begin
  select raise(abort, 'meetings.start_time must be empty or a 24-hour time (HH:MM)');
end;

create trigger if not exists trg_meetings_end_time_insert
before insert on meetings
when new.end_time <> ''
 and strftime('%H:%M', new.end_time) is not new.end_time
begin
  select raise(abort, 'meetings.end_time must be empty or a 24-hour time (HH:MM)');
end;

create trigger if not exists trg_meetings_end_time_update
before update of end_time on meetings
when new.end_time <> ''
 and strftime('%H:%M', new.end_time) is not new.end_time
begin
  select raise(abort, 'meetings.end_time must be empty or a 24-hour time (HH:MM)');
end;

-- ── 3. agenda links must stay inside their own meeting ──────────────────────
-- A decision or action item may point at an agenda item, and that agenda item must
-- belong to the same meeting. The foreign key in 0001 only proves the agenda item
-- exists — not that it belongs here.
--
-- `IS NOT` again: if the agenda item does not exist the subquery yields NULL and the
-- comparison is still true, so a dangling link is refused by this trigger too.
-- ─────────────────────────────────────────────────────────────────────────────

create trigger if not exists trg_decisions_agenda_same_meeting_insert
before insert on decisions
when new.agenda_item_id is not null
 and (select meeting_id from agenda_items where id = new.agenda_item_id) is not new.meeting_id
begin
  select raise(abort, 'decisions.agenda_item_id must reference an agenda item of the same meeting');
end;

create trigger if not exists trg_decisions_agenda_same_meeting_update
before update of meeting_id, agenda_item_id on decisions
when new.agenda_item_id is not null
 and (select meeting_id from agenda_items where id = new.agenda_item_id) is not new.meeting_id
begin
  select raise(abort, 'decisions.agenda_item_id must reference an agenda item of the same meeting');
end;

create trigger if not exists trg_action_items_agenda_same_meeting_insert
before insert on action_items
when new.agenda_item_id is not null
 and (select meeting_id from agenda_items where id = new.agenda_item_id) is not new.meeting_id
begin
  select raise(abort, 'action_items.agenda_item_id must reference an agenda item of the same meeting');
end;

create trigger if not exists trg_action_items_agenda_same_meeting_update
before update of meeting_id, agenda_item_id on action_items
when new.agenda_item_id is not null
 and (select meeting_id from agenda_items where id = new.agenda_item_id) is not new.meeting_id
begin
  select raise(abort, 'action_items.agenda_item_id must reference an agenda item of the same meeting');
end;

-- The other side of the same rule: an agenda item cannot be moved to another meeting
-- while a decision or action item still links to it from the old one. Otherwise the
-- relationship would be silently invalidated by an innocent-looking update.
create trigger if not exists trg_agenda_items_meeting_move_guard
before update of meeting_id on agenda_items
when exists (select 1 from decisions where agenda_item_id = new.id and meeting_id is not new.meeting_id)
  or exists (select 1 from action_items where agenda_item_id = new.id and meeting_id is not new.meeting_id)
begin
  select raise(abort, 'agenda_items.meeting_id cannot change while a decision or action item in another meeting links to it');
end;

-- ── 4. note revision history cannot be destroyed ────────────────────────────
-- 0001 already refuses UPDATE of a revision. Deletion was still possible, and a hard
-- delete of the meeting took its revisions with it via the cascade.
--
-- Policy from here on:
--   · a revision is never deleted individually;
--   · a meeting that has revision history cannot be hard-deleted at all;
--   · meetings are soft-deleted (deleted_at), which never touches revisions;
--   · revisions remain readable and new ones can always be appended.
--
-- EXCEPTION, NOT IMPLEMENTED HERE: permanently purging a meeting's history would have
-- to be an explicit, separately reviewed administrative procedure — never an ordinary
-- delete statement. This migration deliberately provides no escape hatch.
-- ─────────────────────────────────────────────────────────────────────────────

create trigger if not exists trg_note_revisions_no_delete
before delete on note_revisions
begin
  select raise(abort, 'note revision history cannot be deleted');
end;

create trigger if not exists trg_meetings_delete_guard
before delete on meetings
when exists (select 1 from note_revisions where meeting_id = old.id)
begin
  select raise(abort, 'a meeting with note revision history cannot be hard-deleted; soft-delete it with deleted_at instead');
end;
