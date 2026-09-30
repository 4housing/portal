-- ============================================================================
-- Portal 4housing — 081 · Vista consolidada de actividad (para indicadores)
-- ============================================================================
-- Correr en el proyecto del PORTAL. Une en una sola vista las fuentes de
-- actividad que viven en este proyecto, normalizadas a: sector, fecha, usuario,
-- accion, fuente. Alimenta el tablero portal/actividad.html.
--
--   core_auditoria               → LABO + perfiles_sector (permisos) + Compras
--                                   (desde 091_auditoria_compras.sql)  [sector propio]
--   planificacion_actividad_log  → Planificación
--   diseno_historial_actividad   → Diseño
--   audit_log                    → Comercial (fhcomercial)
--
-- security_invoker = true → respeta la RLS de cada tabla según quién consulta
-- (dirección ve todo; un usuario de un sector solo lo suyo). Esta vista no
-- necesita cambios cuando se suma un sector nuevo a core_auditoria (como
-- Compras): ya lee de ahí sin filtrar por sector. EERR todavía no tiene
-- auditoría propia.
-- ============================================================================

create or replace view public.core_actividad
with (security_invoker = true) as
  select sector::text as sector,
         cambiado_en   as fecha,
         coalesce(usuario_email, '—') as usuario,
         accion,
         coalesce(tabla, '') as fuente
    from public.core_auditoria
  union all
  select 'planificacion',
         creado_en,
         coalesce(usuario_email, '—'),
         coalesce(accion, ''),
         coalesce(entidad, '')
    from public.planificacion_actividad_log
  union all
  select 'diseno',
         created_at,
         coalesce(hecho_por_nombre, '—'),
         coalesce(tipo, ''),
         coalesce(descripcion, '')
    from public.diseno_historial_actividad
  union all
  -- Comercial: audit_log. Se leen las columnas por to_jsonb para no romper la
  -- vista si algún nombre difiere (columna ausente → null, sin error).
  select 'fhcomercial',
         (to_jsonb(a) ->> 'cambiado_en')::timestamptz,
         coalesce(to_jsonb(a) ->> 'usuario', to_jsonb(a) ->> 'usuario_email', '—'),
         coalesce(to_jsonb(a) ->> 'operacion', to_jsonb(a) ->> 'accion', ''),
         coalesce(to_jsonb(a) ->> 'tabla', '')
    from public.audit_log a;

grant select on public.core_actividad to authenticated;

-- Prueba rápida:
select sector, count(*) as movimientos, max(fecha) as ultimo
  from public.core_actividad
 group by sector order by movimientos desc;
