-- ============================================================================
-- Diseño — 150 · Semáforo de proyectos (lo carga Claude) + actualizado_en automático
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase, ANTES de
-- publicar el js/app.js que lo muestra. Idempotente. Rollback al final.
-- Aditivo: no cambia permisos (RLS de diseno_proyectos sin tocar).
--
-- 1) Tres columnas en diseno_proyectos para el semáforo que actualiza Claude
--    (conector 4housing Apps) todos los días:
--      semaforo                 'verde' | 'ambar' | 'rojo' (o null = sin evaluar)
--      semaforo_motivo          texto corto: por qué (avance verificado, días sin
--                               verificar, rubros que faltan antes de la reunión, …)
--      semaforo_actualizado_en  cuándo se evaluó por última vez
--
-- 2) Trigger BEFORE UPDATE:
--    · actualizado_en = now() cuando cambia CUALQUIER dato del proyecto, venga de
--      la app o del conector. (Hasta ahora no lo actualizaba nadie.) No se mueve
--      si lo único que cambió es el semáforo: si no, la evaluación diaria marcaría
--      todos los proyectos como "actualizados" todos los días.
--    · semaforo_actualizado_en = now() cuando cambia el color o el motivo y quien
--      edita no lo mandó. Si Claude reevalúa y deja todo igual, conviene que mande
--      semaforo_actualizado_en para registrar el chequeo.
--    Quién cambió qué ya queda en la auditoría (trigger zz_auditoria existente).
--
-- 3) v_diseno_proyectos: se agregan las 3 columnas AL FINAL (create or replace
--    view solo permite agregar al final). Definición base = la vigente en
--    producción al 2026-11-25 (relevada con pg_get_viewdef).
-- ============================================================================

begin;

-- 1 · Columnas ---------------------------------------------------------------
alter table public.diseno_proyectos
  add column if not exists semaforo text,
  add column if not exists semaforo_motivo text,
  add column if not exists semaforo_actualizado_en timestamptz;

alter table public.diseno_proyectos drop constraint if exists diseno_proyectos_semaforo_chk;
alter table public.diseno_proyectos add constraint diseno_proyectos_semaforo_chk
  check (semaforo is null or semaforo in ('verde', 'ambar', 'rojo'));

-- 2 · Trigger ----------------------------------------------------------------
create or replace function public.diseno_proyectos_marcar_actualizado()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  ign text[] := array['actualizado_en', 'semaforo', 'semaforo_motivo', 'semaforo_actualizado_en'];
begin
  if (to_jsonb(new) - ign) is distinct from (to_jsonb(old) - ign) then
    new.actualizado_en := now();
  end if;
  if (new.semaforo, new.semaforo_motivo) is distinct from (old.semaforo, old.semaforo_motivo)
     and new.semaforo_actualizado_en is not distinct from old.semaforo_actualizado_en then
    new.semaforo_actualizado_en := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_diseno_proyectos_actualizado on public.diseno_proyectos;
create trigger trg_diseno_proyectos_actualizado
  before update on public.diseno_proyectos
  for each row execute function public.diseno_proyectos_marcar_actualizado();

-- 3 · Vista (misma definición + 3 columnas al final) --------------------------
create or replace view public.v_diseno_proyectos
with (security_invoker = on) as
with hojas as (
  select t.proyecto_id, t.id, t.etapa, t.orden, t.nombre, t.cumplido, t.parent_id,
         not (exists (select 1 from public.diseno_tareas c
                       where c.parent_id = t.id and c.eliminada = false)) as es_hoja
    from public.diseno_tareas t
   where t.eliminada = false
), av as (
  select hojas.proyecto_id,
         count(*) filter (where hojas.es_hoja) as total,
         count(*) filter (where hojas.es_hoja and hojas.cumplido) as hechos
    from hojas
   group by hojas.proyecto_id
), actual as (
  select distinct on (hojas.proyecto_id) hojas.proyecto_id,
         hojas.nombre as tarea_actual,
         hojas.etapa as etapa_actual
    from hojas
   where hojas.es_hoja and not hojas.cumplido
   order by hojas.proyecto_id, hojas.etapa, hojas.orden
)
select p.id, p.cotizacion_id, p.nro_if, p.cliente, p.nombre, p.ficha,
       p.plazo_entrega, p.responsable, p.estado, p.plan_inicio, p.plan_fin_f1,
       p.plan_fin_f2, p.creado_en, p.actualizado_en, p.resp_diseno,
       p.resp_documentacion, p.resp_tecnico, p.coord_produccion, p.inputs,
       coalesce(av.hechos, 0::bigint) as checks_hechos,
       coalesce(av.total, 0::bigint) as checks_total,
       case
         when coalesce(av.total, 0::bigint) = 0 then 0::numeric
         else round(coalesce(av.hechos, 0::bigint)::numeric / av.total::numeric * 100::numeric)
       end as avance_pct,
       ac.tarea_actual, ac.etapa_actual,
       p.categoria, p.rubros_redibujar, p.modo_etapa3, p.asesorias,
       p.ia_revisado_por, p.ia_revisado_en,
       p.semaforo, p.semaforo_motivo, p.semaforo_actualizado_en
  from public.diseno_proyectos p
  left join av on av.proyecto_id = p.id
  left join actual ac on ac.proyecto_id = p.id;

commit;

-- 4 · Verificación (solo lectura) --------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'v_diseno_proyectos'
   and column_name like 'semaforo%';
select tgname from pg_trigger
 where tgrelid = 'public.diseno_proyectos'::regclass and not tgisinternal;

-- ROLLBACK
-- begin;
-- drop trigger if exists trg_diseno_proyectos_actualizado on public.diseno_proyectos;
-- drop function if exists public.diseno_proyectos_marcar_actualizado();
-- (la vista con las 3 columnas extra no molesta; para sacarlas: drop view y
--  recrearla con la definición de 141 — ojo, la app depende de la vista)
-- alter table public.diseno_proyectos drop constraint if exists diseno_proyectos_semaforo_chk;
-- commit;
-- Las columnas se dejan (borrarlas requiere sacarlas antes de la vista).
