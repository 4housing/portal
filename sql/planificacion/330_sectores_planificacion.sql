-- ============================================================================
-- NOTA (repo público): los mails y nombres reales se reemplazaron por marcadores
-- (personaNN@ejemplo.invalid / <nombre>). Esta migración YA se aplicó con los datos
-- reales; re-correrla así no hace nada (no matchea ningún perfil). Para re-usarla,
-- completar a mano los mails en el SQL Editor, sin commitearlos.
-- Migración Planificación — 330 · Sector y cargo para el equipo
-- ============================================================================
-- ⚠ Correr en el proyecto del PORTAL. IDEMPOTENTE (re-correr las veces que
-- haga falta; también sirve para ajustar cargos editando y re-corriendo).
--
-- PRE-REQUISITO para los que no tienen cuenta en el portal todavía
-- (Leandro Chinni, Micaela, Fabiana): pre-crearlos en el dashboard
-- (Authentication → Users → Add user → Create new user, con Auto Confirm),
-- igual que se hizo con el equipo de diseño. Después correr esto.
--
-- Mapeo de cargos (del proyecto viejo, 2026-07-19):
--   micaela  → admin (ve_sueldos)     · pablo → admin (ve_sueldos; además dirección)
--   nicolas  → coordinador            · fabiana → pm
--   ignacio y leandro NO tenían perfil en el viejo (usaban la app sin rol
--   especial) → cargo coordinador por defecto; ajustable acá y re-corriendo.
-- ve_sueldos viaja como permiso jsonb en perfiles_sector.permisos.
-- ============================================================================

with equipo (email, cargo, permisos) as (
  values
    ('persona02@ejemplo.invalid',   'pm',          '{}'::jsonb),
    ('persona03@ejemplo.invalid', 'coordinador', '{}'::jsonb),
    ('persona04@ejemplo.invalid',  'coordinador', '{}'::jsonb),
    ('persona05@ejemplo.invalid',        'admin',       '{"ve_sueldos": true}'::jsonb),
    ('persona06@ejemplo.invalid',  'coordinador', '{}'::jsonb),
    ('persona01@ejemplo.invalid',  'admin',       '{"ve_sueldos": true}'::jsonb)
)
insert into public.perfiles_sector (perfil_id, sector, cargo, permisos)
select p.id, 'planificacion'::public.sector_portal, e.cargo, e.permisos
  from equipo e
  join public.perfiles p on p.email = e.email
on conflict (perfil_id, sector) do update
   set cargo = excluded.cargo,
       permisos = excluded.permisos;

-- Activar a los pre-creados que sigan inactivos
update public.perfiles set activo = true
 where email in (
   'persona02@ejemplo.invalid','persona03@ejemplo.invalid',
   'persona04@ejemplo.invalid','persona05@ejemplo.invalid',
   'persona06@ejemplo.invalid','persona01@ejemplo.invalid');

-- Verificación
with equipo (email) as (
  values
    ('persona02@ejemplo.invalid'),('persona03@ejemplo.invalid'),
    ('persona04@ejemplo.invalid'),('persona05@ejemplo.invalid'),
    ('persona06@ejemplo.invalid'),('persona01@ejemplo.invalid')
)
select e.email,
       case
         when p.id is null then '✗ sin cuenta en el portal (pre-crearla en el dashboard)'
         when ps.perfil_id is null then '⚠ sin sector (re-correr la parte de arriba)'
         else '✓ ' || ps.cargo || case when coalesce((ps.permisos->>'ve_sueldos')::boolean,false) then ' + ve_sueldos' else '' end
       end as estado
  from equipo e
  left join public.perfiles p on p.email = e.email
  left join public.perfiles_sector ps
         on ps.perfil_id = p.id and ps.sector = 'planificacion'
 order by e.email;
