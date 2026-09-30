-- ============================================================================
-- Portal 4housing — 091 · Auditoría de Compras (post-migración a wcpk)
-- ============================================================================
-- Correr en el proyecto del PORTAL (wcpkpwxhqdcdljfwzcmy) — el mismo proyecto
-- que usa 4housing-compras desde la migración de septiembre 2026.
--
-- Por qué no aparecían movimientos de Compras en /portal/actividad.html: el
-- comentario original de 080_auditoria.sql decía que Compras y EERR vivían en
-- el proyecto viejo (aaqp) y por eso quedaban afuera de la auditoría
-- automática. Eso ya no es así — Compras está en este mismo proyecto — pero
-- nadie había dado el paso de engancharle los triggers después de la
-- migración. La vista core_actividad (081) ya lee de core_auditoria sin
-- filtrar por sector, así que apenas estos triggers empiecen a escribir con
-- sector='compras', el tablero los muestra solo, sin tocar la vista.
--
-- Alcance: solo tablas de MOVIMIENTO real (altas/cambios que hace una persona
-- en el día a día: OGs, certificaciones, pagos, caja, SOLP, pañol,
-- herramientas, mantenimiento, inspecciones, evaluación de proveedores).
-- Quedan afuera a propósito los diccionarios/catálogos (compras_proveedores,
-- compras_articulos, compras_clasif_renglon, compras_aux_opciones, etc.) y las
-- tablas que se resincronizan en bloque desde Excel/Tango (compras_stock_saldos,
-- compras_series_activas, compras_solp_rubros, compras_oc_informe,
-- compras_depositos): auditarlas ensuciaría el tablero con cientos de filas
-- idénticas cada vez que alguien aprieta "Sincronizar". Si más adelante Compras
-- quiere auditar también esas, es un archivo aparte — no hace falta bloquear
-- esto por eso.
--
-- compras_caja (catálogo de cajas, PK "cod") también queda afuera por lo mismo:
-- no es un movimiento, es una lista corta que casi no cambia.
--
-- Idempotente: se puede correr de nuevo.
-- ============================================================================

do $$
declare t text; tbls text[] := array[
  'compras_ogs',
  'compras_og_certificados',
  'compras_pagos',
  'compras_caja_ingresos',
  'compras_solicitudes_pago',
  'compras_solp_items',
  'compras_panol_egresos',
  'compras_herr_operaciones',
  'compras_mantenimiento',
  'compras_inspecciones',
  'compras_prov_evaluaciones',
  'compras_prov_criticos'];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo % (no existe todavía)', t; continue; end if;
    execute format('drop trigger if exists zz_auditoria on public.%I', t);
    execute format('create trigger zz_auditoria after insert or update or delete on public.%I for each row execute function public.fn_core_auditoria(%L)', t, 'compras');
  end loop;
end $$;

-- Verificación: una fila por tabla, con los 3 eventos cubiertos (insert, update, delete)
select event_object_table as tabla, string_agg(event_manipulation, ', ' order by event_manipulation) as eventos
  from information_schema.triggers
 where trigger_name = 'zz_auditoria'
   and event_object_table = any(array[
     'compras_ogs','compras_og_certificados','compras_pagos','compras_caja_ingresos',
     'compras_solicitudes_pago','compras_solp_items','compras_panol_egresos',
     'compras_herr_operaciones','compras_mantenimiento','compras_inspecciones',
     'compras_prov_evaluaciones','compras_prov_criticos'])
 group by event_object_table
 order by 1;

-- Prueba rápida: movimientos de compras ya registrados (va a dar 0 hasta que alguien
-- use la app de nuevo después de correr esto — la auditoría es hacia adelante, no
-- reconstruye el histórico de movimientos que ya pasaron).
select count(*) as movimientos_compras, max(cambiado_en) as ultimo
  from public.core_auditoria
 where sector = 'compras';
