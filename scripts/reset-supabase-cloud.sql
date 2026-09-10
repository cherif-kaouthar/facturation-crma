-- ============================================================================
-- reset-supabase-cloud.sql
--
-- VIDE TOUTES LES DONNÉES DE L'APPLICATION dans la base Supabase (le cloud) :
--   settings        → entreprise + paramètres (billing, branding, ...)
--   clients         → clients
--   invoices        → factures (+ lignes via invoice_lines)
--   invoice_lines   → lignes de facture (les "services")
--   units           → sites de production
--   counters        → compteur de numérotation par année
--
-- Statistiques : aucune table dédiée, elles sont recalculées en direct à
-- partir de invoices / clients / settings, donc vidées automatiquement.
--
-- STRUCTURE CONSERVÉE À L'IDENTIQUE :
--   - Aucune table, fonction, trigger, index ni politique RLS n'est supprimé.
--   - public.profiles        (accroche auth, dormante)  → conservé
--   - public.schema_migrations (suivi des migrations)    → conservé
--
-- NUMÉROTATION remise à zéro : public.counters est vidé. Le trigger
-- invoices_assign_number() et reserve_invoice_numbers() le recréent à
-- next_seq = 1 → la première facture de CHAQUE année repart au numéro 1.
--
-- À exécuter dans SQL Editor du Dashboard Supabase (rôle postgres, qui
-- contourne RLS), ou en psql :  \i scripts/reset-supabase-cloud.sql
-- ============================================================================

begin;

-- Enfants d'abord, puis parents (respect des clés étrangères).
-- TRUNCATE n'enclenche pas les triggers de numérotation, c'est voulu :
-- on repart d'un comptage vide.
truncate table public.invoice_lines;
truncate table public.invoices;
truncate table public.units;
truncate table public.clients;
truncate table public.counters;
truncate table public.settings;

-- Vérification : aucune donnée applicative ne doit rester.
do $$
declare
  v_invoice_lines bigint := (select count(*) from public.invoice_lines);
  v_invoices      bigint := (select count(*) from public.invoices);
  v_units         bigint := (select count(*) from public.units);
  v_clients       bigint := (select count(*) from public.clients);
  v_counters      bigint := (select count(*) from public.counters);
  v_settings      bigint := (select count(*) from public.settings);
begin
  if v_invoice_lines + v_invoices + v_units + v_clients + v_counters + v_settings <> 0 then
    raise exception 'ÉCHEC : des données applicatives restent présentes (invoice_lines=%, invoices=%, units=%, clients=%, counters=%, settings=%)',
      v_invoice_lines, v_invoices, v_units, v_clients, v_counters, v_settings;
  end if;
  raise notice 'Base vidée. counters vide → la première facture de chaque année sera numérotée 1.';
end $$;

commit;