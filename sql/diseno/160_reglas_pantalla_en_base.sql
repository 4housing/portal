-- ============================================================================
-- Diseño — 160 · Las reglas de la pantalla, también en la base
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase. Idempotente.
-- Rollback al final. Sin cambios en el HTML/JS.
--
-- Por qué: la app de Diseño valida muchas cosas solo en pantalla (esCoord(),
-- soyResponsable()). Desde Claude (conector 4housing Apps) o la API se podían
-- saltear. Pedido de Diseño (validado 2026-11-26): que valgan las mismas reglas
-- que en la pantalla, y semáforo + desvíos/NC solo coordinación.
--
-- Coordinación = dirección o cargo admin/coordinador en Diseño.
--
-- Qué queda en la base (relevado de js/app.js, commit 387f349):
--   diseno_proyectos
--     · crear / borrar ............................ solo coordinación
--     · estado .................................... cualquier editor (como la pantalla)
--     · asesorias ................................. coordinación o el responsable técnico del proyecto
--     · ia_revisado_por / ia_revisado_en .......... coordinación o el responsable de diseño (a su nombre)
--     · todo lo demás (semáforo, responsables, planificación, análisis general,
--       modo etapa 3, datos del proyecto) ........ solo coordinación
--   diseno_tareas (alta/baja ya eran solo coordinación; tildar ya era responsable o coordinación)
--     · el responsable solo puede tildar/destildar (cumplido, cumplido_en): fechas,
--       responsable, revisión en planta, etc. → solo coordinación
--     · "Análisis general" y "Asignación de responsables" se completan solas:
--       el responsable no las tilda a mano
--     · "Validación IA" (auto_ia): el responsable solo la tilda si en los últimos 30 min
--       cargó una auditoría IA de ese proyecto SIN inconsistencias (alta/media) ni
--       interferencias (mismo criterio que auditoriaLimpia() de la app)
--   diseno_minutas
--     · cargar ................................... coordinación o el responsable de la tarea, a su nombre
--   diseno_desvios_nc ............................ ya era solo coordinación (sin cambios)
--
-- No se tocan: la Edge Function / Power Automate (service role) ni el SQL Editor:
-- las reglas aplican solo a usuarios logueados (rol authenticated).
-- Políticas: solo se AGREGA una RESTRICTIVE en minutas (no amplía nada).
-- ============================================================================

begin;

-- 1 · Helpers ----------------------------------------------------------------
create or replace function public.diseno_es_coord()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.cargo_en_sector('diseno'::public.sector_portal), '') in ('direccion', 'admin', 'coordinador');
$$;
revoke all on function public.diseno_es_coord() from public, anon;
grant execute on function public.diseno_es_coord() to authenticated;

-- Nombre canónico de quien está logueado (el que usa la app para "responsable").
create or replace function public.diseno_mi_nombre()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.nombre from public.perfiles p where p.id = (select auth.uid());
$$;
revoke all on function public.diseno_mi_nombre() from public, anon;
grant execute on function public.diseno_mi_nombre() to authenticated;

-- Columnas que cambian entre dos versiones de una fila (ignorando las indicadas).
create or replace function public.diseno_columnas_cambiadas(nueva jsonb, vieja jsonb, ignorar text[] default '{}')
returns text[]
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(k order by k), '{}')
    from jsonb_object_keys(nueva) k
   where not (k = any(ignorar))
     and (nueva -> k) is distinct from (vieja -> k);
$$;

-- 2 · Proyectos --------------------------------------------------------------
create or replace function public.diseno_proyectos_reglas()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cambios text[];
  c text;
  yo text;
begin
  -- Solo usuarios logueados (app / conector). Service role y SQL Editor, sin cambios.
  if coalesce(auth.role(), '') <> 'authenticated' or public.diseno_es_coord() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'Diseño: solo la coordinación crea proyectos.' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    raise exception 'Diseño: solo la coordinación elimina proyectos.' using errcode = '42501';
  end if;

  yo := public.diseno_mi_nombre();
  cambios := public.diseno_columnas_cambiadas(to_jsonb(new), to_jsonb(old), array['actualizado_en']);
  foreach c in array cambios loop
    if c = 'estado' then
      continue;                                             -- cualquier editor (como la pantalla)
    elsif c = 'asesorias' and yo is not null and yo = old.resp_tecnico then
      continue;                                             -- responsable técnico
    elsif c in ('ia_revisado_por', 'ia_revisado_en') and yo is not null and yo = old.resp_diseno
          and new.ia_revisado_por is not distinct from yo then
      continue;                                             -- responsable de diseño, a su nombre
    else
      raise exception 'Diseño: solo la coordinación puede cambiar "%" del proyecto.', c using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_diseno_proyectos_reglas on public.diseno_proyectos;
create trigger trg_diseno_proyectos_reglas
  before insert or update or delete on public.diseno_proyectos
  for each row execute function public.diseno_proyectos_reglas();

-- 3 · Tareas -----------------------------------------------------------------
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
  if old.auto_ia then
    if new.cumplido is not true or not exists (
      select 1 from public.diseno_auditorias a
       where a.proyecto_id = old.proyecto_id
         and a.creado_por = (select auth.uid())
         and a.estado = 'completada'
         and a.creado_en > now() - interval '30 minutes'
         -- mismo criterio que auditoriaLimpia() de la app
         and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(a.hallazgos -> 'hallazgos') = 'array'
                                                                  then a.hallazgos -> 'hallazgos' else '[]'::jsonb end) x
                          where lower(coalesce(x ->> 'severidad', '')) in ('alta', 'media')
                             or lower(coalesce(x ->> 'tipo', '')) like '%interferencia%')
         and coalesce(jsonb_array_length(case when jsonb_typeof(a.hallazgos -> 'interferencias') = 'array'
                                              then a.hallazgos -> 'interferencias' end), 0) = 0
    ) then
      raise exception 'Diseño: "%" se tilda sola cuando la auditoría IA no detecta inconsistencias ni interferencias.', old.nombre using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_diseno_tareas_reglas on public.diseno_tareas;
create trigger trg_diseno_tareas_reglas
  before update on public.diseno_tareas
  for each row execute function public.diseno_tareas_reglas();

-- 4 · Minutas ----------------------------------------------------------------
drop policy if exists diseno_minutas_coord_o_responsable on public.diseno_minutas;
create policy diseno_minutas_coord_o_responsable on public.diseno_minutas
  as restrictive for insert to authenticated
  with check (
    public.diseno_es_coord()
    or (
      creado_por is not distinct from (select auth.uid())
      and exists (select 1 from public.diseno_tareas t
                   where t.id = tarea_id
                     and t.responsable is not null
                     and t.responsable = public.diseno_mi_nombre())
    )
  );

commit;

-- 5 · Verificación (solo lectura) --------------------------------------------
select tgname from pg_trigger
 where tgrelid in ('public.diseno_proyectos'::regclass, 'public.diseno_tareas'::regclass)
   and tgname like '%reglas';                                    -- esperado: 2
select policyname, permissive from pg_policies
 where tablename = 'diseno_minutas' and policyname = 'diseno_minutas_coord_o_responsable';

-- ROLLBACK
-- begin;
-- drop trigger if exists trg_diseno_proyectos_reglas on public.diseno_proyectos;
-- drop trigger if exists trg_diseno_tareas_reglas on public.diseno_tareas;
-- drop policy if exists diseno_minutas_coord_o_responsable on public.diseno_minutas;
-- drop function if exists public.diseno_proyectos_reglas();
-- drop function if exists public.diseno_tareas_reglas();
-- drop function if exists public.diseno_columnas_cambiadas(jsonb, jsonb, text[]);
-- drop function if exists public.diseno_mi_nombre();
-- drop function if exists public.diseno_es_coord();
-- commit;
