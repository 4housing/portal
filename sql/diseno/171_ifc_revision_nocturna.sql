-- ============================================================================
-- Diseño — 171 · Revisión nocturna de modelos IFC (2:00 hora Argentina)
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase, DESPUÉS de
-- desplegar la Edge Function ifc-nocturno. Idempotente. Rollback al final.
-- Requiere 170 (tablas IFC).
--
-- 1) Clave de la tarea programada: se GENERA y GUARDA DENTRO de la base (Vault).
--    Nunca sale de la base ni queda escrita en el código: la tarea la lee del
--    Vault al llamar a la función, y la función la valida con
--    ifc_nocturno_token_valido() (solo service role).
-- 2) diseno_ifc_nocturno_log: qué hizo cada noche (archivos revisados, lanzados,
--    errores). Lo lee el sector Diseño (también desde Claude).
-- 3) pg_cron: todas las noches a las 05:00 UTC (= 2:00 en Argentina) llama a
--    ifc-nocturno. La función responde enseguida y trabaja en segundo plano.
-- ============================================================================

begin;

-- 1 · Clave en el Vault (si no existe) + validación ----------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ifc_nocturno_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ifc_nocturno_token',
      'Clave con la que pg_cron llama a la Edge Function ifc-nocturno (sql/diseno/171)');
  end if;
end $$;

create or replace function public.ifc_nocturno_token_valido(t text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(t, '') <> '' and t = (select decrypted_secret from vault.decrypted_secrets where name = 'ifc_nocturno_token');
$$;
revoke all on function public.ifc_nocturno_token_valido(text) from public, anon, authenticated;
grant execute on function public.ifc_nocturno_token_valido(text) to service_role;

-- 2 · Registro de cada noche ---------------------------------------------------
create table if not exists public.diseno_ifc_nocturno_log (
  id               bigint generated always as identity primary key,
  ejecutado_en     timestamptz not null default now(),
  terminado_en     timestamptz,
  carpetas         integer,          -- carpetas 10-BIM / Estudio de proyecto revisadas
  ifc_vistos       integer,          -- .ifc encontrados
  modificados      integer,          -- modificados en la ventana (últimas 26 h)
  lanzados         integer,          -- procesamientos lanzados
  detalle          jsonb,            -- archivos lanzados / salteados (y por qué)
  error            text
);
alter table public.diseno_ifc_nocturno_log enable row level security;
revoke all on public.diseno_ifc_nocturno_log from anon, authenticated;
grant select on public.diseno_ifc_nocturno_log to authenticated;
drop policy if exists diseno_ifc_nocturno_log_select on public.diseno_ifc_nocturno_log;
create policy diseno_ifc_nocturno_log_select on public.diseno_ifc_nocturno_log
  for select to authenticated using (public.tiene_sector('diseno'::public.sector_portal));

-- 3 · Tarea programada (05:00 UTC = 2:00 ART) -----------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'ifc-nocturno';
select cron.schedule('ifc-nocturno', '0 5 * * *', $cron$
  select net.http_post(
    url := 'https://wcpkpwxhqdcdljfwzcmy.supabase.co/functions/v1/ifc-nocturno',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-ifc-nocturno', (select decrypted_secret from vault.decrypted_secrets where name = 'ifc_nocturno_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$cron$);

commit;

-- 4 · Verificación (solo lectura) ----------------------------------------------
select jobname, schedule, active from cron.job where jobname = 'ifc-nocturno';
select name from vault.secrets where name = 'ifc_nocturno_token';   -- (solo el nombre)

-- Correrla a mano (sin esperar a la noche):
--   select net.http_post(url := 'https://wcpkpwxhqdcdljfwzcmy.supabase.co/functions/v1/ifc-nocturno',
--     headers := jsonb_build_object('content-type','application/json','x-ifc-nocturno',
--       (select decrypted_secret from vault.decrypted_secrets where name = 'ifc_nocturno_token')),
--     body := '{"solo_mirar": true}'::jsonb);
--   ("solo_mirar": revisa y registra en el log qué procesaría, sin lanzar nada)

-- ROLLBACK
-- begin;
-- select cron.unschedule(jobid) from cron.job where jobname = 'ifc-nocturno';
-- drop table if exists public.diseno_ifc_nocturno_log;
-- drop function if exists public.ifc_nocturno_token_valido(text);
-- delete from vault.secrets where name = 'ifc_nocturno_token';
-- commit;
