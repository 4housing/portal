-- ============================================================================
-- NOTA (repo público): los mails y nombres reales se reemplazaron por marcadores
-- (personaNN@ejemplo.invalid / <nombre>). Esta migración YA se aplicó con los datos
-- reales; re-correrla así no hace nada (no matchea ningún perfil). Para re-usarla,
-- completar a mano los mails en el SQL Editor, sin commitearlos.
-- Migración Diseño — 130 · Sector y cargo para el equipo de diseño
-- ============================================================================
-- ⚠ Correr en el proyecto del PORTAL (wcpkpwxhqdcdljfwzcmy).
--
-- IDEMPOTENTE: se puede correr todas las veces que haga falta. Solo afecta
-- a quienes YA se loguearon al portal al menos una vez (el login Microsoft
-- crea el perfil; este script lo activa y le asigna sector/cargo).
-- Flujo esperado: avisarle al equipo de diseño que entre una vez al portal
-- → correr esto → correrlo de nuevo si faltaba alguien.
--
-- Mapeo de cargos: tomado del proyecto viejo el 2026-07-18 (query sobre
-- perfiles + auth.users). Además fija perfiles.nombre al valor canónico
-- que usa la app en tareas.responsable ("Nombre Apellido", sin el sufijo
-- "- 4housing" que trae el display name de Microsoft) — de eso depende la
-- política RLS diseno_tareas_update_resp.
-- ============================================================================

-- A · Activar + nombre canónico + sector/cargo (upsert)
with equipo (email, nombre, cargo) as (
  values
    ('persona08@ejemplo.invalid',    '<nombre>',     'diseno'),
    ('persona09@ejemplo.invalid',      '<nombre>', 'diseno'),
    ('persona10@ejemplo.invalid',  '<nombre>',   'diseno'),
    ('persona11@ejemplo.invalid',    '<nombre>',     'coordinador'),
    ('persona12@ejemplo.invalid',      '<nombre>',       'diseno'),
    ('persona13@ejemplo.invalid', '<nombre>',  'diseno'),
    ('persona06@ejemplo.invalid',    '<nombre>',     'diseno'),
    ('persona14@ejemplo.invalid',   '<nombre>',    'diseno'),
    ('persona01@ejemplo.invalid',    '<nombre>',     'coordinador')
),
act as (
  update public.perfiles p
     set nombre = e.nombre,
         activo = true
    from equipo e
   where p.email = e.email
  returning p.id, p.email
)
insert into public.perfiles_sector (perfil_id, sector, cargo)
select p.id, 'diseno'::public.sector_portal, e.cargo
  from equipo e
  join public.perfiles p on p.email = e.email
on conflict (perfil_id, sector) do update
   set cargo = excluded.cargo;

-- B · Verificación: quién quedó asignado y quién falta (todavía no logueó)
with equipo (email, cargo_esperado) as (
  values
    ('persona08@ejemplo.invalid',    '<nombre>'),
    ('persona09@ejemplo.invalid',      '<nombre>'),
    ('persona10@ejemplo.invalid',  '<nombre>'),
    ('persona11@ejemplo.invalid',    '<nombre>'),
    ('persona12@ejemplo.invalid',      '<nombre>'),
    ('persona13@ejemplo.invalid', '<nombre>'),
    ('persona06@ejemplo.invalid',    '<nombre>'),
    ('persona14@ejemplo.invalid',   '<nombre>'),
    ('persona01@ejemplo.invalid',    '<nombre>')
)
select e.email,
       e.cargo_esperado,
       case
         when p.id is null then '✗ todavía no logueó al portal'
         when ps.perfil_id is null then '⚠ perfil sin sector (raro, re-correr A)'
         else '✓ asignado como ' || ps.cargo
       end as estado
  from equipo e
  left join public.perfiles p on p.email = e.email
  left join public.perfiles_sector ps
         on ps.perfil_id = p.id and ps.sector = 'diseno'
 order by e.email;
