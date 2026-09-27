-- ============================================================================
-- Portal 4housing — 061 · CANARY: "solo visión" = solo lectura en Diseño (RLS)
-- ============================================================================
-- ⚠ Correr en el proyecto del PORTAL. PRE-REQUISITO: haber corrido el 060
-- (crea public.puede_editar_sector). Empezamos por Diseño porque es el módulo
-- más chico y NO tiene usuarios externos (a diferencia de LABO).
--
-- QUÉ HACE (aditivo y reversible): agrega políticas RLS *restrictivas* de
-- ESCRITURA (insert/update/delete) que exigen puede_editar_sector('diseno').
-- Las políticas restrictivas se COMBINAN CON AND sobre las permisivas que ya
-- existen; NO se toca ni se borra ninguna política actual. El SELECT queda igual
-- (los "solo visión" siguen leyendo). Efecto: un cargo 'lector'/'lectura' ya no
-- puede escribir por API, no solo en la UI. Dirección y el resto: sin cambios.
--
-- REVERSIBLE: al final está el rollback (comentado). Si algo sale mal, corrélo.
--
-- ⚠ No lo pude probar contra la base (no tengo acceso). Aplicalo y verificá con
-- un usuario 'lector' de prueba ANTES de replicar a los otros módulos.
-- ============================================================================

begin;

do $$
declare
  t text;
  tbls text[] := array[
    'diseno_auditorias','diseno_cotizaciones','diseno_desvios_nc','diseno_etapas',
    'diseno_historial_actividad','diseno_historial_fechas','diseno_historial_proyecto',
    'diseno_historial_responsable','diseno_minutas','diseno_proyecto_checklist',
    'diseno_proyectos','diseno_tareas'
  ];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then
      raise notice 'salteo %, no existe', t; continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_ins', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
    execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated '
      || 'with check (public.puede_editar_sector(''diseno''))', t||'_solo_editores_ins', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated '
      || 'using (public.puede_editar_sector(''diseno'')) '
      || 'with check (public.puede_editar_sector(''diseno''))', t||'_solo_editores_upd', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated '
      || 'using (public.puede_editar_sector(''diseno''))', t||'_solo_editores_del', t);
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Verificación: deberían verse 3 políticas restrictivas (RESTRICTIVE) por tabla
-- para insert/update/delete, además de las permisivas que ya existían.
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd, permissive
  from pg_policies
 where schemaname = 'public' and tablename like 'diseno_%'
   and policyname like '%_solo_editores_%'
 order by tablename, cmd;

-- ---------------------------------------------------------------------------
-- ROLLBACK (descomentar y correr para deshacer TODO lo de este archivo):
-- ---------------------------------------------------------------------------
-- do $$
-- declare
--   t text;
--   tbls text[] := array[
--     'diseno_auditorias','diseno_cotizaciones','diseno_desvios_nc','diseno_etapas',
--     'diseno_historial_actividad','diseno_historial_fechas','diseno_historial_proyecto',
--     'diseno_historial_responsable','diseno_minutas','diseno_proyecto_checklist',
--     'diseno_proyectos','diseno_tareas'
--   ];
-- begin
--   foreach t in array tbls loop
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_ins', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_upd', t);
--     execute format('drop policy if exists %I on public.%I', t||'_solo_editores_del', t);
--   end loop;
-- end $$;
