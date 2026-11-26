-- ============================================================================
-- Diseño — 170 · Modelos IFC procesados (ifc-procesador / GitHub Actions)
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase, ANTES de
-- desplegar la función que revisa SharePoint y el procesador. Idempotente.
-- Rollback al final. Aditivo: tablas nuevas, no toca nada existente.
--
-- Carpetas, dentro de cada proyecto de "01 DISEÑO Y DESARROLLO" (con subcarpetas,
-- salteando las que tengan "superado", "old" o "backup" en el nombre):
--     */10-BIM/**                                           (carpeta = 'bim')
--     */00-Estudios particulares/01-Estudio de proyecto/**  (carpeta = 'estudio')
--
-- Flujo (decisión de Diseño, 2026-11-26: nada cada 15 min, para no procesar las
-- exportaciones intermedias del modelado):
--   1. A DEMANDA desde Claude: un editor de Diseño pide procesar un IFC puntual
--      (herramienta del conector, con su propia cuenta Microsoft) → fila 'pendiente'
--      (origen 'claude') y se manda a GitHub Actions.
--   2. REVISIÓN NOCTURNA: una vez por noche se recorren las carpetas y, por cada
--      .ifc nuevo o modificado en el día, se procesa SOLO su última versión
--      (origen 'nocturno'). Las versiones intermedias del día no se procesan.
--   3. El procesador carga los elementos y deja el modelo en 'ok' (o 'error').
--   4. Al quedar 'ok', se borran los ELEMENTOS de las versiones anteriores de ese
--      mismo archivo (las filas de modelo quedan como historial), salvo las
--      versiones congeladas. Hasta que la nueva está 'ok', la anterior sigue con
--      sus datos (nunca hay un momento sin datos).
--   5. "Congelada": la marca la coordinación (o Claude en su nombre). Esa versión
--      conserva sus elementos para comparar cambios posteriores.
--
-- Acceso: lee el sector Diseño. Escribe el servidor (service role; el pedido desde
-- Claude lo registra el conector después de verificar que la persona edita Diseño).
-- Por la API, solo: pedir reprocesar una versión (editores) y congelar/descongelar
-- (coordinación).
-- Sin trigger zz_auditoria en elementos (serían cientos de miles de filas por
-- modelo en core_auditoria); los cambios de estado/congelado sí quedan registrados.
-- Requiere 160 (diseno_es_coord) aplicado.
-- ============================================================================

begin;

-- 1 · Modelos (una fila por archivo + versión de SharePoint) ------------------
create table if not exists public.diseno_ifc_modelos (
  id                 bigint generated always as identity primary key,
  proyecto_id        uuid references public.diseno_proyectos(id) on delete set null,
  nro_if             text,                    -- sacado de la carpeta del proyecto ("IF 4432" → IF4432)
  carpeta            text not null check (carpeta in ('bim', 'estudio')),
  ruta               text not null,           -- relativa a "01 DISEÑO Y DESARROLLO", con el nombre del archivo
  archivo            text not null,
  sp_item_id         text not null,           -- id del archivo en SharePoint (se mantiene entre versiones)
  sp_version         text not null,           -- eTag/cTag de SharePoint: cambia con cada versión guardada
  sp_modificado_en   timestamptz,
  sp_modificado_por  text,
  tamano_bytes       bigint,
  vigente            boolean not null default true,   -- última versión conocida de ese archivo
  origen             text not null check (origen in ('claude', 'nocturno')),
  estado             text not null default 'pendiente'
                       check (estado in ('pendiente', 'procesando', 'ok', 'error')),
  solicitado_por     uuid references auth.users(id) on delete set null,
  solicitado_en      timestamptz,
  procesado_en       timestamptz,
  duracion_s         integer,
  schema_ifc         text,                    -- IFC2X3 / IFC4 …
  cant_elementos     integer,
  error              text,
  run_url            text,                    -- link a la corrida de GitHub Actions
  congelada          boolean not null default false,
  congelada_por      text,
  congelada_en       timestamptz,
  creado_en          timestamptz not null default now(),
  unique (sp_item_id, sp_version)
);
create index if not exists idx_diseno_ifc_modelos_proy on public.diseno_ifc_modelos (proyecto_id, vigente);
create index if not exists idx_diseno_ifc_modelos_item on public.diseno_ifc_modelos (sp_item_id, creado_en desc);
create index if not exists idx_diseno_ifc_modelos_estado on public.diseno_ifc_modelos (estado) where estado in ('pendiente', 'procesando');

-- 2 · Elementos (uno por GlobalId de cada versión procesada) -----------------
create table if not exists public.diseno_ifc_elementos (
  modelo_id   bigint not null references public.diseno_ifc_modelos(id) on delete cascade,
  global_id   text not null,
  clase       text not null,          -- IfcWall, IfcSlab, IfcDoor, …
  nombre      text,
  familia     text,                   -- familia de Revit
  tipo        text,                   -- tipo de Revit
  nivel       text,                   -- IfcBuildingStorey
  material    text,
  parametros  jsonb,                  -- parámetros principales (lista a validar con el IFC de SIDE)
  -- caja envolvente en mm, coordenadas del proyecto (para interferencias/contactos)
  min_x double precision, min_y double precision, min_z double precision,
  max_x double precision, max_y double precision, max_z double precision,
  primary key (modelo_id, global_id)
);
create index if not exists idx_diseno_ifc_elem_clase on public.diseno_ifc_elementos (modelo_id, clase);
create index if not exists idx_diseno_ifc_elem_gid on public.diseno_ifc_elementos (global_id);

-- 3 · Al quedar 'ok': limpiar elementos de versiones anteriores no congeladas --
--     Al descongelar una versión que ya no es la vigente: borrar sus elementos.
create or replace function public.diseno_ifc_modelos_limpiar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.estado = 'ok' and old.estado is distinct from 'ok' then
    delete from public.diseno_ifc_elementos e
     using public.diseno_ifc_modelos m
     where e.modelo_id = m.id
       and m.sp_item_id = new.sp_item_id
       and m.id <> new.id
       and m.creado_en <= new.creado_en
       and not m.congelada;
  end if;
  if old.congelada and not new.congelada and not new.vigente then
    delete from public.diseno_ifc_elementos where modelo_id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists trg_diseno_ifc_modelos_limpiar on public.diseno_ifc_modelos;
create trigger trg_diseno_ifc_modelos_limpiar
  after update of estado, congelada on public.diseno_ifc_modelos
  for each row execute function public.diseno_ifc_modelos_limpiar();

-- 4 · Qué puede cambiar un usuario logueado (el resto, solo el servidor) ------
create or replace function public.diseno_ifc_modelos_reglas()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cambios text[];
  c text;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  cambios := public.diseno_columnas_cambiadas(to_jsonb(new), to_jsonb(old));
  foreach c in array cambios loop
    if c in ('congelada', 'congelada_por', 'congelada_en') then
      if not public.diseno_es_coord() then
        raise exception 'Diseño: solo la coordinación congela o descongela una versión del modelo.' using errcode = '42501';
      end if;
    elsif c in ('estado', 'solicitado_por', 'solicitado_en') then
      if not (new.estado = 'pendiente' and old.estado in ('ok', 'error')) then
        raise exception 'Diseño: desde la app o Claude solo se puede pedir reprocesar el modelo (estado pendiente).' using errcode = '42501';
      end if;
    else
      raise exception 'Diseño: "%" del modelo IFC lo completa el procesador.', c using errcode = '42501';
    end if;
  end loop;
  -- quién y cuándo: los pone la base, no el cliente
  if new.estado = 'pendiente' and old.estado is distinct from 'pendiente' then
    new.solicitado_por := auth.uid();
    new.solicitado_en  := now();
  end if;
  if new.congelada is distinct from old.congelada then
    new.congelada_por := case when new.congelada then public.diseno_mi_nombre() end;
    new.congelada_en  := case when new.congelada then now() end;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_diseno_ifc_modelos_reglas on public.diseno_ifc_modelos;
create trigger trg_diseno_ifc_modelos_reglas
  before update on public.diseno_ifc_modelos
  for each row execute function public.diseno_ifc_modelos_reglas();

-- Registro de cambios de estado / congelado (tabla chica)
drop trigger if exists zz_auditoria on public.diseno_ifc_modelos;
create trigger zz_auditoria
  after insert or delete or update on public.diseno_ifc_modelos
  for each row execute function public.fn_core_auditoria('diseno');

-- 5 · RLS ---------------------------------------------------------------------
alter table public.diseno_ifc_modelos enable row level security;
alter table public.diseno_ifc_elementos enable row level security;
-- Sin los permisos por defecto (incluido TRUNCATE, que no pasa por RLS): solo lectura
-- y, en modelos, editar las columnas de "pedir reprocesar" y "congelar".
revoke all on public.diseno_ifc_modelos, public.diseno_ifc_elementos from anon, authenticated;
grant select on public.diseno_ifc_modelos, public.diseno_ifc_elementos to authenticated;
grant update (estado, solicitado_por, solicitado_en, congelada, congelada_por, congelada_en)
  on public.diseno_ifc_modelos to authenticated;

drop policy if exists diseno_ifc_modelos_select on public.diseno_ifc_modelos;
create policy diseno_ifc_modelos_select on public.diseno_ifc_modelos
  for select to authenticated using (public.tiene_sector('diseno'::public.sector_portal));

drop policy if exists diseno_ifc_modelos_update on public.diseno_ifc_modelos;
create policy diseno_ifc_modelos_update on public.diseno_ifc_modelos
  for update to authenticated
  using (public.puede_editar_sector('diseno'::public.sector_portal))
  with check (public.puede_editar_sector('diseno'::public.sector_portal));

drop policy if exists diseno_ifc_elementos_select on public.diseno_ifc_elementos;
create policy diseno_ifc_elementos_select on public.diseno_ifc_elementos
  for select to authenticated using (public.tiene_sector('diseno'::public.sector_portal));

commit;

-- 6 · Verificación (solo lectura) ---------------------------------------------
select tablename, policyname, cmd from pg_policies
 where tablename in ('diseno_ifc_modelos', 'diseno_ifc_elementos') order by 1, 2;
select tgname, tgrelid::regclass from pg_trigger
 where tgrelid in ('public.diseno_ifc_modelos'::regclass, 'public.diseno_ifc_elementos'::regclass) and not tgisinternal;
-- esperado: limpiar + reglas + zz_auditoria en modelos; ninguno en elementos

-- ROLLBACK
-- begin;
-- drop table if exists public.diseno_ifc_elementos;
-- drop table if exists public.diseno_ifc_modelos;
-- drop function if exists public.diseno_ifc_modelos_limpiar();
-- drop function if exists public.diseno_ifc_modelos_reglas();
-- commit;
