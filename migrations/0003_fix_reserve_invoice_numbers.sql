-- 0003_fix_reserve_invoice_numbers.sql
-- reserve_invoice_numbers declares OUT parameters named `seq` (RETURNS TABLE),
-- so inside the function `max(seq)` is ambiguous with the invoices.seq column:
-- PL/pgSQL's default variable_conflict mode raises
--   ERROR: column reference "seq" is ambiguous
-- when the function is actually called. Qualify the column to fix it.

create or replace function public.reserve_invoice_numbers(y integer, n integer)
returns table (seq integer, number text)
language plpgsql security definer set search_path = public as $$
declare
  v_padding int;
  v_start   int;
  v_count   int;
  v_cur     int;
begin
  if y is null or n is null or n < 1 or n > 1000 then
    raise exception 'reserve_invoice_numbers: invalid arguments';
  end if;

  select coalesce((value ->> 'numberPadding')::int, 4) into v_padding
    from settings where key = 'billing';

  insert into counters (year, next_seq) values (y, 1)
    on conflict (year) do nothing;

  select next_seq into v_start from counters where year = y for update;

  -- Re-anchor so already-issued numbers are never handed out twice.
  select coalesce(max(invoices.seq), 0) + 1 into v_cur
    from public.invoices where year = y;
  if v_cur > v_start then v_start := v_cur; end if;

  v_count := n;
  update counters set next_seq = v_start + v_count where year = y;

  for i in v_start .. v_start + v_count - 1 loop
    seq := i;
    number := lpad(i::text, v_padding, '0');
    return next;
  end loop;
end $$;

grant execute on function public.reserve_invoice_numbers(integer, integer)
  to anon, authenticated;
