-- ============================================================================
-- Migración Planificación — 340 · Alta de Matías Formica (acceso restringido)
-- ============================================================================
-- ⚠ Correr en el proyecto del PORTAL. IDEMPOTENTE (re-correr las veces que
-- haga falta; también sirve para ajustar sus permisos editando y re-corriendo).
--
-- PRE-REQUISITO: matiasformica@4housing.com.ar debe tener cuenta en el portal.
-- Si todavía no la tiene, pre-crearla en el dashboard de Supabase (proyecto del
-- portal): Authentication → Users → Add user → Create new user, con Auto Confirm.
-- Recién después correr este script.
--
-- Permisos pedidos para Matías:
--   • cargo coordinador  → NO es dirección/admin → NO ve la pestaña "Actividad".
--   • ve_sueldos: false  → NO ve "Personal y tarifas" (ni "Traslados").
--   • ve_neuquen: false  → NO puede entrar a la sede "Base Neuquén"
--                          (el selector de sede no le muestra Neuquén).
-- Los permisos viajan como jsonb en perfiles_sector.permisos.
-- ============================================================================

-- Asegurar que su perfil esté activo y NO marcado como dirección
update public.perfiles
   set activo = true,
       es_direccion = false
 where email = 'matiasformica@4housing.com.ar';

-- Asignar/ajustar el sector planificación con sus permisos
insert into public.perfiles_sector (perfil_id, sector, cargo, permisos)
select p.id,
       'planificacion'::public.sector_portal,
       'coordinador',
       '{"ve_sueldos": false, "ve_neuquen": false}'::jsonb
  from public.perfiles p
 where p.email = 'matiasformica@4housing.com.ar'
on conflict (perfil_id, sector) do update
   set cargo = excluded.cargo,
       permisos = excluded.permisos;

-- Verificación
select e.email,
       case
         when p.id is null then '✗ sin cuenta en el portal (pre-crearla en el dashboard)'
         when ps.perfil_id is null then '⚠ sin sector (re-correr la parte de arriba)'
         else '✓ ' || ps.cargo
              || case when coalesce((ps.permisos->>'ve_sueldos')::boolean,false) then ' + ve_sueldos' else ' · sin sueldos' end
              || case when coalesce((ps.permisos->>'ve_neuquen')::boolean,true)  then ' · ve Neuquén'  else ' · sin Neuquén'  end
              || case when p.es_direccion then ' · DIRECCIÓN(admin)' else '' end
       end as estado
  from (values ('matiasformica@4housing.com.ar')) as e(email)
  left join public.perfiles p on p.email = e.email
  left join public.perfiles_sector ps
         on ps.perfil_id = p.id and ps.sector = 'planificacion';
