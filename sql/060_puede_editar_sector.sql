-- ============================================================================
-- Portal 4housing — 060 · Helper puede_editar_sector() + diagnóstico
-- ============================================================================
-- ⚠ Correr en el proyecto del PORTAL (Supabase → SQL Editor).
--
-- Este archivo es SEGURO: solo crea una función y corre consultas de lectura.
-- NO cambia ninguna política RLS. El endurecimiento real (que sí cambia
-- políticas) va en los archivos 061+ , de a un módulo por vez.
--
-- Contexto: la RLS por SECTOR ya existe (tiene_sector('...') en los 4 módulos:
-- CRM/040, diseño/110, labo/210, planificación/310). Eso aísla los datos entre
-- módulos. Lo que falta a nivel base es distinguir EDICIÓN de solo-lectura: hoy
-- cualquiera con el sector puede escribir por API aunque en la app sea "solo
-- visión". Esta función habilita cerrar esa brecha con políticas restrictivas.
--
-- puede_editar_sector(s): true si el usuario puede EDITAR ese sector, es decir
-- tiene el sector y su cargo NO es 'lector'/'lectura' (dirección siempre puede).
-- Es el análogo de escritura de tiene_sector() (que se queda para el SELECT).
-- ============================================================================

create or replace function public.puede_editar_sector(s public.sector_portal)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.tiene_sector(s)
     and coalesce(public.cargo_en_sector(s), '') not in ('lector', 'lectura');
$$;

revoke all on function public.puede_editar_sector(public.sector_portal) from public, anon;
grant execute on function public.puede_editar_sector(public.sector_portal) to authenticated;

comment on function public.puede_editar_sector(public.sector_portal) is
  'true si el usuario actual puede EDITAR el sector (tiene el sector y su cargo no es lector/lectura; dirección siempre). Para políticas RLS de escritura; el SELECT sigue usando tiene_sector().';

-- ---------------------------------------------------------------------------
-- DIAGNÓSTICO (solo lectura): políticas actuales por módulo. Copiá el resultado
-- para armar/ajustar el endurecimiento de cada módulo con los nombres exactos.
-- ---------------------------------------------------------------------------
select schemaname, tablename, policyname, cmd, permissive, roles
  from pg_policies
 where schemaname = 'public'
   and (
        tablename like 'diseno_%'
     or tablename like 'labocomercial_%'
     or tablename like 'planificacion_%'
     or tablename in ('clientes','cotizaciones','catalogo','actividades','oportunidades',
                      'cobranzas','pagos','adicionales','gestiones_cobranza','empresas_prospecto',
                      'prospectos','cierres_mensuales','agenda_tareas','contador','contadores',
                      'facturas','pedidos','mails_entrantes','audit_log')
   )
 order by tablename, cmd, policyname;
