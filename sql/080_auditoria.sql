-- ============================================================================
-- Portal 4housing — 080 · Auditoría automática (quién/qué/cuándo/cómo)
-- ============================================================================
-- Correr en el proyecto del PORTAL (wcpkpwxhqdcdljfwzcmy). Igual de completo que
-- el audit_log de Comercial (INSERT/UPDATE/DELETE con fila ANTES y DESPUÉS,
-- usuario y fecha), en UNA tabla compartida con columna `sector` → sirve como
-- "log por app" (RLS: cada sector ve lo suyo) y como base del consolidado.
--
-- Alcance: LABO (vive en este proyecto) + perfiles_sector (cambios de permisos
-- del panel). COMPRAS y EERR viven en OTRO proyecto Supabase (aaqpzamcdxldhqyuqlgm),
-- así que su auditoría se corre allá con un archivo aparte (081). Comercial/Diseño/
-- Planificación ya tienen su propio registro.
-- Idempotente: se puede correr de nuevo.
-- ============================================================================

-- 0) Limpieza: sacar un trigger que quedó mal puesto en pagos (tabla de Comercial)
drop trigger if exists zz_auditoria on public.pagos;

-- 1) Tabla de auditoría --------------------------------------------------------
create table if not exists public.core_auditoria (
  id            bigint generated always as identity primary key,
  sector        public.sector_portal not null,
  tabla         text        not null,
  registro_id   text,
  accion        text        not null,   -- INSERT | UPDATE | DELETE
  datos_antes   jsonb,
  datos_despues jsonb,
  usuario_id    uuid,
  usuario_email text,
  cambiado_en   timestamptz not null default now()
);
create index if not exists core_auditoria_sector_fecha on public.core_auditoria (sector, cambiado_en desc);
create index if not exists core_auditoria_tabla_reg    on public.core_auditoria (tabla, registro_id);

alter table public.core_auditoria enable row level security;
grant select on public.core_auditoria to authenticated;
drop policy if exists core_auditoria_select on public.core_auditoria;
create policy core_auditoria_select on public.core_auditoria
  for select to authenticated using (public.tiene_sector(sector));

-- 2) Función de trigger genérica ----------------------------------------------
-- Sector: se pasa como argumento; o 'auto' para leerlo de la columna `sector` de
-- la propia fila (p.ej. perfiles_sector).
create or replace function public.fn_core_auditoria()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_sector public.sector_portal;
  j_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
  j_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end;
begin
  v_sector := case when TG_ARGV[0] = 'auto'
                   then coalesce(j_new->>'sector', j_old->>'sector')::public.sector_portal
                   else TG_ARGV[0]::public.sector_portal end;
  if v_uid is not null then
    select email into v_email from public.perfiles where id = v_uid;
  end if;
  insert into public.core_auditoria(sector, tabla, registro_id, accion, datos_antes, datos_despues, usuario_id, usuario_email)
  values (v_sector, TG_TABLE_NAME, coalesce(j_new->>'id', j_old->>'id'), TG_OP, j_old, j_new, v_uid, v_email);
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

-- 3) Triggers -----------------------------------------------------------------
-- LABO (tablas de este proyecto)
do $$
declare t text; tbls text[] := array[
  'labocomercial_leads','labocomercial_counters','labocomercial_contactos_web'];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo %', t; continue; end if;
    execute format('drop trigger if exists zz_auditoria on public.%I', t);
    execute format('create trigger zz_auditoria after insert or update or delete on public.%I for each row execute function public.fn_core_auditoria(%L)', t, 'labocomercial');
  end loop;
end $$;

-- perfiles_sector: auditar cambios de permisos hechos desde el panel.
-- Usa 'auto' → cada fila se etiqueta con el sector afectado.
drop trigger if exists zz_auditoria on public.perfiles_sector;
create trigger zz_auditoria after insert or update or delete on public.perfiles_sector
  for each row execute function public.fn_core_auditoria('auto');

-- 4) Verificación (una fila por evento: INSERT/UPDATE/DELETE) ------------------
select event_object_table as tabla, string_agg(event_manipulation, ', ' order by event_manipulation) as eventos
  from information_schema.triggers
 where trigger_name = 'zz_auditoria'
 group by event_object_table
 order by 1;
