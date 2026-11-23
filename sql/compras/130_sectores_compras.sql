-- ============================================================================
-- NOTA (repo público): los mails y nombres reales se reemplazaron por marcadores
-- (personaNN@ejemplo.invalid / <nombre>). Esta migración YA se aplicó con los datos
-- reales; re-correrla así no hace nada (no matchea ningún perfil). Para re-usarla,
-- completar a mano los mails en el SQL Editor, sin commitearlos.
-- Portal 4housing — Compras · 130 · Asignación de sector 'compras' a los usuarios
-- ============================================================================
-- Activa (activo=true) y asigna el sector 'compras' a los usuarios reales de la
-- app de Compras (los 27 de compras_usuarios_autorizados, excluyendo los 3
-- *.SIN-LOGIN@ que son solo nombres para el desplegable de certificador).
--
-- EERR: lo ven dirección (Pablo y Micaela ya tienen es_direccion=true, que ve
-- TODOS los sectores). Por eso NO hace falta ninguna fila de sector 'eerr'.
--
-- Idempotente y re-ejecutable: solo afecta a los perfiles que YA existen. Los que
-- todavía no están en wcpk hay que pre-crearlos primero (Auth → Add user, o vía
-- service key); después re-correr este archivo para que los tome.
--
-- Correr en el SQL Editor de wcpk.
-- ============================================================================

-- Lista de emails del sector compras (27 reales)
with compras_emails(email) as (values
  ('persona15@ejemplo.invalid'),
  ('persona16@ejemplo.invalid'),
  ('persona17@ejemplo.invalid'),
  ('persona09@ejemplo.invalid'),
  ('persona18@ejemplo.invalid'),
  ('persona19@ejemplo.invalid'),
  ('persona20@ejemplo.invalid'),
  ('persona21@ejemplo.invalid'),
  ('persona10@ejemplo.invalid'),
  ('persona22@ejemplo.invalid'),
  ('persona02@ejemplo.invalid'),
  ('persona23@ejemplo.invalid'),
  ('persona24@ejemplo.invalid'),
  ('persona25@ejemplo.invalid'),
  ('persona26@ejemplo.invalid'),
  ('persona03@ejemplo.invalid'),
  ('persona11@ejemplo.invalid'),
  ('persona27@ejemplo.invalid'),
  ('persona12@ejemplo.invalid'),
  ('persona28@ejemplo.invalid'),
  ('persona05@ejemplo.invalid'),
  ('persona13@ejemplo.invalid'),
  ('persona06@ejemplo.invalid'),
  ('persona14@ejemplo.invalid'),
  ('persona01@ejemplo.invalid'),
  ('persona29@ejemplo.invalid'),
  ('persona30@ejemplo.invalid')
)
-- 1) activar los perfiles que existan y estén inactivos
, activados as (
  update public.perfiles p
     set activo = true
    from compras_emails ce
   where p.email = ce.email and p.activo = false
  returning p.email
)
-- 2) asignar el sector compras (cargo 'miembro'); el detalle fino de permisos
--    lo sigue manejando compras_usuarios_autorizados dentro de la app.
insert into public.perfiles_sector (perfil_id, sector, cargo)
select p.id, 'compras'::public.sector_portal, 'miembro'
  from public.perfiles p
  join compras_emails ce on ce.email = p.email
on conflict (perfil_id, sector) do nothing;

-- Verificación: quiénes quedaron con sector compras
select p.email, p.activo, p.es_direccion
  from public.perfiles p
  join public.perfiles_sector ps on ps.perfil_id = p.id and ps.sector = 'compras'
 order by p.email;
