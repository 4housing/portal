-- ============================================================================
-- Portal 4housing — 065 · "solo visión" = solo lectura en LABO (RLS)
-- ============================================================================
-- PRE-REQUISITO: 060. Mismo patrón que Diseño (061), con UNA diferencia clave:
-- solo se restringen UPDATE y DELETE, NO el INSERT. Motivo: los vendedores
-- EXTERNOS (sin sector) insertan su cotización en labocomercial_leads, y la
-- ingesta web escribe contactos por una función SECURITY DEFINER. Bloquear el
-- INSERT rompería esos flujos. Restringiendo UPDATE/DELETE se logra el objetivo:
-- un 'lector' interno no puede modificar ni borrar datos existentes.
-- Los counters se escriben por RPC (SECURITY DEFINER, ignora RLS).
-- Validá con el test del 062 cambiando 'diseno'→'labocomercial' y la tabla por
-- labocomercial_leads (que suele tener datos), probando un UPDATE.
-- ============================================================================

begin;
do $$
declare
  t text;
  tbls text[] := array[
    'labocomercial_leads','labocomercial_counters','labocomercial_contactos_web'
  ];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo %, no existe', t; continue; end if;
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.puede_editar_sector(''labocomercial'')) with check (public.puede_editar_sector(''labocomercial''))', t||'_solo_editores_upd', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.puede_editar_sector(''labocomercial''))', t||'_solo_editores_del', t);
  end loop;
end $$;
commit;

select tablename, cmd from pg_policies
 where schemaname='public' and tablename like 'labocomercial_%' and policyname like '%_solo_editores_%'
 order by tablename, cmd;

-- ROLLBACK (descomentar para deshacer):
-- do $$
-- declare t text; tbls text[] := array['labocomercial_leads','labocomercial_counters','labocomercial_contactos_web'];
-- begin
--   foreach t in array tbls loop
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
--   end loop;
-- end $$;
