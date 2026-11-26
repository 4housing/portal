-- ============================================================================
-- Diseño — 161 · "Validación por asistente IA" la tilda el responsable
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase, ANTES de
-- publicar el js/app.js sin la solapa Auditoría IA. Idempotente.
--
-- Decisión de Diseño (2026-11-26): se quita la solapa Auditoría IA de la app.
-- Era lo único que tildaba la tarea "Validación por asistente IA" (auto_ia).
-- Ahora la tilda su responsable a mano (o coordinación), como cualquier tarea.
-- Cambia SOLO eso en la regla de tareas de 160: se quita el requisito de una
-- auditoría limpia de los últimos 30 min. Lo demás de 160 queda igual.
-- ============================================================================

begin;

create or replace function public.diseno_tareas_reglas()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cambios text[];
begin
  if coalesce(auth.role(), '') <> 'authenticated' or public.diseno_es_coord() then
    return new;
  end if;
  -- (alta y baja ya son solo coordinación por RLS; acá: qué puede cambiar el responsable)
  cambios := public.diseno_columnas_cambiadas(to_jsonb(new), to_jsonb(old), array['cumplido', 'cumplido_en']);
  if array_length(cambios, 1) > 0 then
    raise exception 'Diseño: el responsable solo puede tildar su tarea; "%" lo cambia la coordinación.', cambios[1] using errcode = '42501';
  end if;
  if new.cumplido is not distinct from old.cumplido then
    return new;
  end if;
  if old.analisis_general or old.asigna_roles then
    raise exception 'Diseño: "%" se completa sola (no se tilda a mano).', old.nombre using errcode = '42501';
  end if;
  -- "Validación por asistente IA" (auto_ia): la tilda el responsable a mano, como cualquier tarea
  -- (decisión de Diseño 2026-11-26: la auditoría IA ya no se hace desde la app).
  return new;
end;
$$;

commit;

-- ROLLBACK: volver a correr la sección 3 de 160_reglas_pantalla_en_base.sql
