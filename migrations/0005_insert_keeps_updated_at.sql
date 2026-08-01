-- 0005_insert_keeps_updated_at.sql
-- invoices_assign_number() runs BEFORE INSERT and unconditionally did
--   new.updated_at := now();
-- which threw away the timestamp the pushing device supplied.
--
-- Consequences: the cloud row ended up newer than the local copy that had just
-- been pushed, so the very next pull dragged the whole invoice (and all its
-- lines) back down again — pointless traffic, a spurious "data changed" signal
-- on every device, and last-write-wins comparing the write instant instead of
-- the device timestamps that 0004 deliberately switched to.
--
-- Keep an explicitly supplied updated_at, exactly like set_updated_at() does
-- for UPDATEs; only stamp now() when the caller left it empty.

create or replace function public.invoices_assign_number() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_padding int;
  v_next    int;
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  new.updated_at := coalesce(new.updated_at, now());

  select coalesce((value ->> 'numberPadding')::int, 4) into v_padding
    from settings where key = 'billing';
  v_padding := coalesce(v_padding, 4);

  -- Explicit seq (imports, or numbers reserved via reserve_invoice_numbers):
  -- keep it, only re-anchor the counter so the next auto-assign never repeats.
  if new.seq is not null then
    insert into counters (year, next_seq) values (new.year, new.seq + 1)
      on conflict (year) do update set next_seq = greatest(counters.next_seq, excluded.next_seq);
    if new.number = '' then
      new.number := lpad(new.seq::text, v_padding, '0');
    end if;
    return new;
  end if;

  insert into counters (year, next_seq) values (new.year, 1)
    on conflict (year) do nothing;

  select next_seq into v_next from counters where year = new.year for update;

  select coalesce(max(seq), 0) + 1 into new.seq from invoices where year = new.year;
  new.seq := greatest(new.seq, v_next);

  update counters set next_seq = new.seq + 1 where year = new.year;

  new.number := lpad(new.seq::text, v_padding, '0');
  return new;
end $$;
