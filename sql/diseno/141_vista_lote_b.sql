-- 141_vista_lote_b.sql
-- Diseño · Lote B (complemento de 140). La app lee los proyectos desde la vista
-- v_diseno_proyectos, no desde la tabla. El 140 agregó columnas a la TABLA
-- diseno_proyectos (asesorias, ia_revisado_por, ia_revisado_en) pero la vista no
-- las expone. Esto recrea la vista agregando esas 3 columnas AL FINAL del select
-- (create or replace view permite agregar columnas nuevas al final; no reordena
-- ni renombra las existentes). No cambia RLS: sigue con security_invoker.
--
-- Correr en el SQL Editor de Supabase (proyecto unificado wcpk) DESPUÉS del 140.

create or replace view public.v_diseno_proyectos
with (security_invoker = on) as
with hojas as (
  select t.proyecto_id, t.id, t.etapa, t.orden, t.nombre, t.cumplido, t.parent_id,
         (not exists (select 1 from public.diseno_tareas c
                       where c.parent_id = t.id and c.eliminada = false)) as es_hoja
    from public.diseno_tareas t
   where t.eliminada = false
), av as (
  select proyecto_id,
         count(*) filter (where es_hoja) as total,
         count(*) filter (where es_hoja and cumplido) as hechos
    from hojas
   group by proyecto_id
), actual as (
  select distinct on (proyecto_id) proyecto_id,
         nombre as tarea_actual,
         etapa  as etapa_actual
    from hojas
   where es_hoja and not cumplido
   order by proyecto_id, etapa, orden
)
select p.id, p.cotizacion_id, p.nro_if, p.cliente, p.nombre, p.ficha,
       p.plazo_entrega, p.responsable, p.estado, p.plan_inicio, p.plan_fin_f1,
       p.plan_fin_f2, p.creado_en, p.actualizado_en, p.resp_diseno,
       p.resp_documentacion, p.resp_tecnico, p.coord_produccion, p.inputs,
       coalesce(av.hechos, 0) as checks_hechos,
       coalesce(av.total, 0)  as checks_total,
       case when coalesce(av.total, 0) = 0 then 0::numeric
            else round((coalesce(av.hechos, 0)::numeric / av.total::numeric) * 100)
       end as avance_pct,
       ac.tarea_actual, ac.etapa_actual,
       p.categoria, p.rubros_redibujar, p.modo_etapa3,
       -- columnas nuevas del Lote B (140):
       p.asesorias, p.ia_revisado_por, p.ia_revisado_en
  from public.diseno_proyectos p
  left join av on av.proyecto_id = p.id
  left join actual ac on ac.proyecto_id = p.id;
