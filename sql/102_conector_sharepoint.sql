-- ============================================================================
-- Portal 4housing — 102 · Conector 4housing Apps: escritura en SharePoint
-- ============================================================================
-- Correr A MANO (o con OK puntual) en el SQL Editor de Supabase, ANTES de
-- desplegar la versión del conector con herramientas de SharePoint.
-- Idempotente. Rollback al final. Aditivo.
--
-- 1) conector_ms_tokens: el permiso de Microsoft de cada persona (refresh token
--    de Microsoft Graph), CIFRADO (AES-GCM) por la Edge Function. RLS activada y
--    SIN políticas: nadie la lee ni la escribe por la API; solo la Edge Function
--    con la service role. Borrar la fila = desconectar a esa persona.
-- 2) diseno_sharepoint_log: registro de cada operación de escritura en
--    SharePoint hecha desde Claude (quién, qué, origen, destino, resultado).
--    La lee el sector Diseño; la escribe solo quien edita Diseño.
-- ============================================================================

begin;

-- 1 · Permisos de Microsoft (cifrados) ---------------------------------------
create table if not exists public.conector_ms_tokens (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  ms_email          text not null,
  refresh_token_enc text not null,          -- cifrado por la Edge Function (nunca en claro)
  conectado_en      timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);
alter table public.conector_ms_tokens enable row level security;
revoke all on public.conector_ms_tokens from anon, authenticated;
-- (sin políticas: solo la service role de la Edge Function accede)

-- 2 · Registro de operaciones -------------------------------------------------
create table if not exists public.diseno_sharepoint_log (
  id         bigint generated always as identity primary key,
  creado_en  timestamptz not null default now(),
  user_id    uuid not null default auth.uid(),
  email      text,
  accion     text not null,        -- crear_carpeta | copiar | guardar_archivo | mover
  origen     text,
  destino    text,
  resultado  text not null,        -- ok | error: …
  detalle    jsonb
);
create index if not exists idx_diseno_sp_log_creado on public.diseno_sharepoint_log (creado_en desc);
alter table public.diseno_sharepoint_log enable row level security;
revoke all on public.diseno_sharepoint_log from anon;
grant select, insert on public.diseno_sharepoint_log to authenticated;

drop policy if exists diseno_sp_log_select on public.diseno_sharepoint_log;
create policy diseno_sp_log_select on public.diseno_sharepoint_log
  for select to authenticated
  using (public.tiene_sector('diseno'::public.sector_portal));

drop policy if exists diseno_sp_log_insert on public.diseno_sharepoint_log;
create policy diseno_sp_log_insert on public.diseno_sharepoint_log
  for insert to authenticated
  with check (public.puede_editar_sector('diseno'::public.sector_portal) and user_id = auth.uid());

commit;

-- 3 · Verificación (solo lectura)
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public' and tablename in ('conector_ms_tokens', 'diseno_sharepoint_log')
 order by 1, 2;   -- esperado: conector_ms_tokens sin políticas; log con select + insert
select grantee, string_agg(privilege_type, ',') from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'conector_ms_tokens' and grantee in ('anon', 'authenticated')
 group by grantee; -- esperado: ninguna fila

-- ROLLBACK
-- drop table if exists public.diseno_sharepoint_log;
-- drop table if exists public.conector_ms_tokens;
