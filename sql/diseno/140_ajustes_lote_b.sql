-- 140_ajustes_lote_b.sql
-- Diseño · Lote B de ajustes. Solo agrega columnas (idempotente). Correr en el
-- SQL Editor de Supabase (proyecto unificado wcpk). No toca RLS: las columnas
-- nuevas heredan las policies de sus tablas.
--
-- #10 (retrasos que se borran al tildar "hecho") NO necesita SQL: diseno_tareas
-- ya tiene cumplido_en; el arreglo es de la app (mostrar el atraso histórico).

-- ===========================================================================
-- #4 · Revisión en planta: resultado + observaciones + marca "detalle nuevo"
--     con código de formulario (texto libre, ej. RC-02.02).
-- ===========================================================================
alter table public.diseno_tareas add column if not exists rev_resultado    text;      -- 'conforme' | 'observaciones'
alter table public.diseno_tareas add column if not exists rev_observaciones text;
alter table public.diseno_tareas add column if not exists rev_detalle_nuevo boolean not null default false;
alter table public.diseno_tareas add column if not exists rev_codigo_form   text;      -- código del formulario (RC-02.02); a futuro, link

comment on column public.diseno_tareas.rev_resultado is
  'Revisión en planta: conforme / observaciones.';
comment on column public.diseno_tareas.rev_detalle_nuevo is
  'Marca que la revisión detectó un detalle nuevo (remite al formulario rev_codigo_form).';

-- ===========================================================================
-- #6 · Asesorías por rubro (Electricidad, Sanitarias, Estructura, Termomecánica).
--     Nombre del asesor (texto libre) + 2 checks por rubro (bases entregadas /
--     informe recibido), a cargo del responsable técnico. Se guarda como jsonb:
--     { "electricidad": {"asesor":"","bases":false,"informe":false}, ... }
-- ===========================================================================
alter table public.diseno_proyectos add column if not exists asesorias jsonb not null default '{}'::jsonb;

comment on column public.diseno_proyectos.asesorias is
  'Asesorías por rubro: {rubro: {asesor, bases, informe}}. A cargo del responsable técnico.';

-- ===========================================================================
-- #7 · Constancia de revisión de la Validación por asistente IA
--     (quién dejó constancia de haber revisado el resultado y cuándo).
-- ===========================================================================
alter table public.diseno_proyectos add column if not exists ia_revisado_por text;
alter table public.diseno_proyectos add column if not exists ia_revisado_en  timestamptz;

comment on column public.diseno_proyectos.ia_revisado_por is
  'Persona que dejó constancia de haber revisado el resultado de la Validación IA.';
