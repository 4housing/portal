-- ============================================================================
-- Portal 4housing — 083 · Vista consolidada de actividad (v2, comparable)
-- ============================================================================
-- Reemplaza la vista de 081. Ahora que 082 extendió la auditoría fila-por-fila
-- (`core_auditoria`) a Diseño, Planificación, Compras y EERR (y LABO ya estaba),
-- la actividad de TODOS los sectores vive en `core_auditoria`, medida igual.
--
-- Por eso esta versión toma SOLO dos fuentes equivalentes (ambas fila-por-fila):
--   core_auditoria  → todos los sectores del portal (sector propio de cada fila)
--   audit_log       → Comercial (su auditoría equivalente, en su propia tabla)
--
-- Se QUITAN las ramas de `planificacion_actividad_log` y `diseno_historial_actividad`
-- (logs de eventos que la app escribía a mano): ya no se usan para el consolidado
-- porque duplicarían con la auditoría nueva. Las tablas siguen existiendo intactas;
-- solo dejan de alimentar este tablero. (Nota: las filas históricas de esos logs
-- previas a 082 no aparecen más en el tablero; la actividad real se cuenta desde la
-- auditoría a partir de ahora.)
--
-- security_invoker = true → respeta RLS por viewer (dirección ve todo vía tiene_sector).
-- Correr en wcpk después de 082. Idempotente.
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
