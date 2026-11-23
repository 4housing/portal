-- ============================================================================
-- NOTA (repo público): los mails y nombres reales se reemplazaron por marcadores
-- (personaNN@ejemplo.invalid / <nombre>). Esta migración YA se aplicó con los datos
-- reales; re-correrla así no hace nada (no matchea ningún perfil). Para re-usarla,
-- completar a mano los mails en el SQL Editor, sin commitearlos.
-- Migración LABO — 230 · Sector labocomercial para el equipo
-- ============================================================================
-- ⚠ Correr en el proyecto del PORTAL. IDEMPOTENTE (re-correr las veces que
-- haga falta). Los 3 usuarios de la empresa ya existen en el portal (son del
-- equipo comercial), así que esto se puede correr YA, sin esperar logins.
--
-- LABO no tenía roles internos (todos operan todo) → cargo 'miembro' parejo.
--
-- VENDEDOR EXTERNO (, solo cotiza LABO): pendiente de que Azure
-- lo habilite (invitación B2B guest con su Gmail, o cuenta @4housing).
-- Cuando exista su cuenta y haya logueado una vez al portal, descomentar su
-- línea (con el email con el que haya quedado registrado) y re-correr.
-- Su aislamiento lo garantiza RLS: con solo el sector labocomercial no puede
-- leer ni una fila del CRM ni de diseño, sin importar qué URL abra.
-- ============================================================================

with equipo (email, cargo) as (
  values
    ('persona26@ejemplo.invalid', 'miembro'),
    ('persona31@ejemplo.invalid',  'miembro'),
    ('persona01@ejemplo.invalid',  'miembro')
    -- ,('persona32@ejemplo.invalid',       'miembro')  -- ← descomentar cuando su cuenta exista
)
insert into public.perfiles_sector (perfil_id, sector, cargo)
select p.id, 'labocomercial'::public.sector_portal, e.cargo
  from equipo e
  join public.perfiles p on p.email = e.email
on conflict (perfil_id, sector) do update
   set cargo = excluded.cargo;

-- Verificación
with equipo (email) as (
  values
    ('persona26@ejemplo.invalid'),
    ('persona31@ejemplo.invalid'),
    ('persona01@ejemplo.invalid'),
    ('persona32@ejemplo.invalid')
)
select e.email,
       case
         when p.id is null then '✗ sin cuenta en el portal todavía'
         when ps.perfil_id is null then '⚠ sin sector labo (¿línea comentada?)'
         else '✓ sector labocomercial (' || ps.cargo || ')'
       end as estado
  from equipo e
  left join public.perfiles p on p.email = e.email
  left join public.perfiles_sector ps
         on ps.perfil_id = p.id and ps.sector = 'labocomercial'
 order by e.email;
