-- ============================================================================
-- Portal 4housing — 064 · "solo visión" = solo lectura en Comercial (RLS)
-- ============================================================================
-- PRE-REQUISITO: 060. Mismo patrón validado en Diseño (061). Políticas
-- RESTRICTIVE de escritura, aditivas y reversibles; el SELECT no se toca.
-- Excluidas a propósito:
--   - audit_log: solo-lectura (lo escribe fn_audit por trigger, SECURITY DEFINER).
--   - cierres_mensuales: cierre automático al abrir la app (no se gatea).
-- Los contadores (contador/contadores) se escriben por RPC next_seq/next_seq_un
-- (SECURITY DEFINER, ignora RLS), así que la restricción no afecta ese flujo.
-- Validá con el test del 062 cambiando 'diseno'→'fhcomercial' y la tabla por una
-- con datos (p.ej. clientes o cotizaciones).
-- ============================================================================

begin;
do $$
declare
  t text;
  tbls text[] := array[
    'actividades','adicionales','catalogo','clientes','cobranzas',
    'contador','contadores','cotizaciones','empresas_prospecto','facturas',
    'gestiones_cobranza','mails_entrantes','oportunidades','pagos','pedidos','prospectos'
  ];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo %, no existe', t; continue; end if;
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.puede_editar_sector(''fhcomercial''))', t||'_solo_editores_ins', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.puede_editar_sector(''fhcomercial'')) with check (public.puede_editar_sector(''fhcomercial''))', t||'_solo_editores_upd', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.puede_editar_sector(''fhcomercial''))', t||'_solo_editores_del', t);
  end loop;
end $$;
commit;

select tablename, cmd from pg_policies
 where schemaname='public' and policyname like '%_solo_editores_%'
   and tablename in ('actividades','adicionales','catalogo','clientes','cobranzas','contador',
     'contadores','cotizaciones','empresas_prospecto','facturas','gestiones_cobranza',
     'mails_entrantes','oportunidades','pagos','pedidos','prospectos')
 order by tablename, cmd;

-- ROLLBACK (descomentar para deshacer):
-- do $$
-- declare t text; tbls text[] := array[
--   'actividades','adicionales','catalogo','clientes','cobranzas','contador','contadores',
--   'cotizaciones','empresas_prospecto','facturas','gestiones_cobranza','mails_entrantes',
--   'oportunidades','pagos','pedidos','prospectos'];
-- begin
--   foreach t in array tbls loop
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_ins', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
--   end loop;
-- end $$;
