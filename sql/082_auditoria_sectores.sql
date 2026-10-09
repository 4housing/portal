-- ============================================================================
-- Portal 4housing — 082 · Nivelar la auditoría entre sectores
-- ============================================================================
-- Hoy el tablero de actividad no es comparable: Comercial audita fila por fila
-- (cada INSERT/UPDATE/DELETE) mientras Diseño/Planificación solo registran los
-- eventos que la app escribe a mano, LABO solo 3 tablas, y Compras/EERR nada.
--
-- Este archivo extiende la auditoría genérica `fn_core_auditoria(sector)` (de 080)
-- a las tablas de negocio CLAVE de Diseño, Planificación, Compras y EERR, para que
-- todos registren actividad real fila por fila y los números sean comparables.
--
-- CRITERIO de qué se audita: tablas donde cada cambio = una acción de una persona.
-- NO se auditan: catálogos/maestros (import masivo), índices/cotizaciones de dólar,
-- snapshots, logs, caches, ni tablas de sub-renglones de alto movimiento.
--
-- IMPORTACIONES (pedido de Pablo): una importación de Tango = UN movimiento del
-- que la hizo. Por eso se audita la CABECERA `compras_gp_importaciones` (una fila
-- por import, usuario = quien importó) y NO el snapshot `compras_gp_oc` (que se
-- reemplaza entero en cada import → generaría miles de filas de ruido).
--
-- LABO ya quedó cubierto en 080 (sus 3 únicas tablas). Idempotente, guardado con
-- to_regclass (si una tabla no existe, se saltea sin error). Correr en wcpk.
-- ============================================================================

do $$
declare
  t text;
  -- sector -> tablas a auditar
  diseno text[] := array[
    'diseno_proyectos','diseno_cotizaciones','diseno_etapas','diseno_tareas',
    'diseno_minutas','diseno_desvios_nc','diseno_auditorias','diseno_proyecto_checklist'];
  planif text[] := array[
    'planificacion_proyectos','planificacion_bloques','planificacion_bloques_personal',
    'planificacion_personal','planificacion_no_disponibilidad','planificacion_supervision',
    'planificacion_traslados_compras','planificacion_mant_tareas','planificacion_mant_parte',
    'planificacion_stock_mov','planificacion_stock_items','planificacion_trailers',
    'planificacion_detalle_diario'];
  compras text[] := array[
    'compras_ogs','compras_solicitudes_pago','compras_solp_items','compras_pagos',
    'compras_og_certificados','compras_inspecciones','compras_mantenimiento',
    'compras_herr_operaciones','compras_herramientas','compras_panol_egresos',
    'compras_caja','compras_caja_ingresos','compras_gp_proyectos','compras_gp_presupuesto',
    'compras_gp_traslados_mo','compras_gp_reparto','compras_gp_importaciones'];
  eerr text[] := array['eerr_estado'];
  procesar record;
begin
  for procesar in
    select 'diseno'        as sect, diseno        as tbls union all
    select 'planificacion' as sect, planif        as tbls union all
    select 'compras'       as sect, compras       as tbls union all
    select 'eerr'          as sect, eerr          as tbls
  loop
    foreach t in array procesar.tbls loop
      if to_regclass('public.'||t) is null then raise notice 'salteo % (no existe)', t; continue; end if;
      execute format('drop trigger if exists zz_auditoria on public.%I', t);
      execute format('create trigger zz_auditoria after insert or update or delete on public.%I for each row execute function public.fn_core_auditoria(%L)', t, procesar.sect);
    end loop;
  end loop;
end $$;

-- Verificación: una fila por tabla con triggers de auditoría.
select event_object_table as tabla, string_agg(distinct event_manipulation, ', ') as eventos
  from information_schema.triggers
 where trigger_name = 'zz_auditoria'
 group by event_object_table
 order by 1;
