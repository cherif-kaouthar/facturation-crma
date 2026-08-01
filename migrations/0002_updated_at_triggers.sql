-- 0002_updated_at_triggers.sql
-- units/clients lack an updated_at trigger (invoices got one in 0001). Any
-- direct cloud edit or tombstone must bump updated_at so other devices pick
-- the row up in their next pull.
--
-- Note: the trigger keeps an explicitly-set updated_at (sync pushes always
-- carry one) so last-write-wins follows the device timestamps instead of the
-- write instant.

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_units_updated_at on public.units;
create trigger trg_units_updated_at
  before update on public.units
  for each row execute function public.set_updated_at();

drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();
