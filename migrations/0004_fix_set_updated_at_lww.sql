-- 0004_fix_set_updated_at_lww.sql
-- Replace set_updated_at so it only stamps now() when the caller did NOT
-- provide an updated_at. Sync pushes always carry the device's timestamp, so
-- last-write-wins must follow those timestamps — otherwise the trigger would
-- stamp the write instant and a stale device could overwrite a newer edit.
--
-- The three triggers (invoices, units, clients) reference this function, so
-- replacing the body upgrades all of them at once.

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;
