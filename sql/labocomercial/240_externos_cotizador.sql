-- 240_externos_cotizador.sql
-- Habilita que un vendedor EXTERNO (sin sector) use SOLO el cotizador de LABO:
--   1) Contador de números (oferta/lead) como SECURITY DEFINER → devuelve un
--      número único a cualquier usuario autenticado SIN exponer datos ni requerir
--      el sector labocomercial (evita colisiones del fallback local).
--   2) Política de solo-INSERT en labocomercial_leads → el externo puede REGISTRAR
--      su cotización en el CRM, pero NO puede LEER el pipeline (el SELECT sigue
--      requiriendo tiene_sector('labocomercial')).
--
-- Contención: el externo no tiene sector → la RLS le bloquea la lectura de todo
-- (leads, contadores y los demás módulos). Solo puede insertar su propio lead.
-- Correr en el SQL Editor de Supabase (proyecto unificado wcpk...). Idempotente.

-- ===========================================================================
-- 1 · Contador atómico como SECURITY DEFINER (número único para todos)
-- ===========================================================================
create or replace function public.labocomercial_next_counter(counter_name text)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.labocomercial_counters
     set value = value + 1
   where name = counter_name
  returning value;
$$;

revoke all on function public.labocomercial_next_counter(text) from public, anon;
grant execute on function public.labocomercial_next_counter(text) to authenticated, service_role;

-- ===========================================================================
-- 2 · labocomercial_leads: permitir INSERT a autenticados (sin dar lectura)
-- ===========================================================================
-- La política existente labocomercial_leads_all (FOR ALL con tiene_sector) sigue
-- gobernando SELECT/UPDATE/DELETE (solo internos con sector). Esta política extra,
-- permisiva, se suma SOLO para INSERT: como las permisivas se combinan con OR, el
-- INSERT queda habilitado para cualquier autenticado, mientras que leer/editar/
-- borrar sigue exigiendo el sector.
drop policy if exists labocomercial_leads_insert_externos on public.labocomercial_leads;
create policy labocomercial_leads_insert_externos on public.labocomercial_leads
  for insert to authenticated
  with check (true);
