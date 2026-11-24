-- ============================================================================
-- Portal 4housing — 101 · Conector 4housing Apps: lectura general con permisos
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase. Idempotente.
-- Rollback al final. Es ADITIVO: no cambia permisos de nadie.
--
-- Dos funciones que usa el conector de Claude (Edge Function conector-4housing):
--
--   conector_tablas()          Lista las tablas/vistas de las apps que el usuario
--                              tiene (por sector del panel de Usuarios), con sus
--                              columnas. Dirección ve todas.
--   conector_consulta_sql(q,n) Ejecuta UN SELECT (o WITH … SELECT) escrito por
--                              Claude y devuelve hasta n filas en JSON.
--
-- SEGURIDAD de conector_consulta_sql (varias capas):
--   · SECURITY INVOKER: corre COMO EL USUARIO (rol authenticated + su JWT), así
--     que aplica toda la RLS: tiene_sector, compras_flag, edita_costos, etc.
--   · Exige transacción READ ONLY (PostgREST la abre así para GET; por POST se
--     niega): cualquier escritura falla ("cannot execute … in a read-only
--     transaction"), incluso dentro de funciones que la consulta llame.
--   · La consulta se envuelve como subconsulta: solo puede ser un SELECT / WITH;
--     un ";" o un DDL dan error de sintaxis.
--   · statement_timeout 15 s y tope de filas (máx. 2000).
--   · authenticated no tiene permisos de superusuario (no lee archivos del
--     servidor ni otras bases).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 · Tablas visibles por sector
-- ----------------------------------------------------------------------------
create or replace function public.conector_tablas()
returns table (tabla text, tipo text, sector text, columnas jsonb)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  -- Por oid (pg_catalog), no por nombre: has_table_privilege(oid, …) nunca falla por
  -- tablas de otros esquemas ni depende del orden en que Postgres evalúe las condiciones.
  with base as (
    select c.relname::text as tabla,
           case c.relkind when 'v' then 'vista' when 'm' then 'vista' else 'tabla' end as tipo,
           split_part(c.relname, '_', 1) as prefijo,
           (select jsonb_agg(jsonb_build_object('columna', a.attname, 'tipo', format_type(a.atttypid, a.atttypmod))
                             order by a.attnum)
              from pg_attribute a
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columnas
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm')
       and has_table_privilege(c.oid, 'select')
  ), sectores as (
    select e.enumlabel::text as sector
      from pg_enum e join pg_type ty on ty.oid = e.enumtypid
     where ty.typname = 'sector_portal'
  )
  select b.tabla, b.tipo, s.sector, b.columnas
    from base b
    left join sectores s on s.sector = b.prefijo
   where (s.sector is null)                                           -- tablas del portal (perfiles, …): decide la RLS
      or public.tiene_sector(s.sector::public.sector_portal)          -- tablas de apps: solo los sectores del usuario
   order by s.sector nulls first, b.tabla;
$$;
revoke all on function public.conector_tablas() from public, anon;
grant execute on function public.conector_tablas() to authenticated;


-- ----------------------------------------------------------------------------
-- 2 · Consulta SQL de solo lectura, como el usuario
-- ----------------------------------------------------------------------------
create or replace function public.conector_consulta_sql(q text, limite integer default 500)
returns jsonb
language plpgsql stable security invoker
set search_path = public, pg_temp
set statement_timeout = '15s'
as $$
declare
  n integer := least(greatest(coalesce(limite, 500), 1), 2000);
  limpia text := regexp_replace(coalesce(q, ''), ';\s*$', '');   -- tolera un ";" final
  res jsonb;
begin
  -- Solo en transacción de solo lectura (PostgREST la abre así para GET): si alguien la
  -- llama por POST, se niega en vez de correr en una transacción que podría escribir.
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'conector_consulta_sql solo corre en una transacción de solo lectura (llamar por GET).' using errcode = '25006';
  end if;
  if limpia !~* '^\s*(select|with)\s' then
    raise exception 'Solo se permiten consultas SELECT (o WITH … SELECT).' using errcode = '42501';
  end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) s limit %s) t', limpia, n)
    into res;
  return res;
end;
$$;
revoke all on function public.conector_consulta_sql(text, integer) from public, anon;
grant execute on function public.conector_consulta_sql(text, integer) to authenticated;


-- ----------------------------------------------------------------------------
-- 3 · Verificación (solo lectura)
-- ----------------------------------------------------------------------------
select p.proname, p.prosecdef as security_definer, p.provolatile as volatilidad,
       array_to_string(p.proacl::text[], ',') as permisos, p.proconfig as config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('conector_tablas', 'conector_consulta_sql');
-- Esperado: security_definer = false, volatilidad = 's' (stable), sin anon.

-- ROLLBACK
-- drop function if exists public.conector_consulta_sql(text, integer);
-- drop function if exists public.conector_tablas();
