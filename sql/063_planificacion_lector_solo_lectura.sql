-- ============================================================================
-- Portal 4housing — 063 · "solo visión" = solo lectura en Planificación (RLS)
-- ============================================================================
-- PRE-REQUISITO: 060 (crea puede_editar_sector). Mismo patrón validado en Diseño
-- (061): políticas RESTRICTIVE de escritura, aditivas y reversibles. El SELECT no
-- se toca. El log de actividad (planificacion_actividad_log) queda AFUERA a
-- propósito (es append-only y no debe gatearse).
-- Validá con el test del 062 cambiando 'diseno'→'planificacion' y la tabla por
-- una con datos (p.ej. planificacion_proyectos).
-- ============================================================================

begin;
do $$
declare
  t text;
  tbls text[] := array[
    'planificacion_personal','planificacion_proyectos','planificacion_trailers',
    'planificacion_feriados','planificacion_no_disponibilidad',
    'planificacion_valor_hora_hist','planificacion_especialidad_hist',
    'planificacion_bloques','planificacion_bloques_personal','planificacion_supervision',
    'planificacion_mant_tareas','planificacion_mant_tareas_personal',
    'planificacion_mant_parte','planificacion_mant_tareas_tipicas',
    'planificacion_stock_items','planificacion_stock_mov',
    'planificacion_stock_mov_item','planificacion_stock_mov_trailer',
    'planificacion_detalle_diario','planificacion_presupuesto_compras',
    'planificacion_traslados_compras'
  ];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo %, no existe', t; continue; end if;
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (public.puede_editar_sector(''planificacion''))', t||'_solo_editores_ins', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (public.puede_editar_sector(''planificacion'')) with check (public.puede_editar_sector(''planificacion''))', t||'_solo_editores_upd', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (public.puede_editar_sector(''planificacion''))', t||'_solo_editores_del', t);
  end loop;
end $$;
commit;

select tablename, cmd from pg_policies
 where schemaname='public' and tablename like 'planificacion_%' and policyname like '%_solo_editores_%'
 order by tablename, cmd;

-- ROLLBACK (descomentar para deshacer):
-- do $$
-- declare t text; tbls text[] := array[
--   'planificacion_personal','planificacion_proyectos','planificacion_trailers',
--   'planificacion_feriados','planificacion_no_disponibilidad','planificacion_valor_hora_hist',
--   'planificacion_especialidad_hist','planificacion_bloques','planificacion_bloques_personal',
--   'planificacion_supervision','planificacion_mant_tareas','planificacion_mant_tareas_personal',
--   'planificacion_mant_parte','planificacion_mant_tareas_tipicas','planificacion_stock_items',
--   'planificacion_stock_mov','planificacion_stock_mov_item','planificacion_stock_mov_trailer',
--   'planificacion_detalle_diario','planificacion_presupuesto_compras','planificacion_traslados_compras'];
-- begin
--   foreach t in array tbls loop
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_ins', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
--   end loop;
-- end $$;
