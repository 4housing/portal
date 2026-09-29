-- ============================================================================
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
  ('administracion@4housing.com.ar'),
  ('agustinarodriguez@4housing.com.ar'),
  ('alejozucchelli@4housing.com.ar'),
  ('anabustillo@4housing.com.ar'),
  ('andrealiendro@4housing.com.ar'),
  ('camiladimeo@4housing.com.ar'),
  ('daianamartin@4housing.com.ar'),
  ('depositos@4housing.com.ar'),
  ('emilianaalvarez@4housing.com.ar'),
  ('ezequielbosco@4housing.com.ar'),
  ('fabianarubio@4housing.com.ar'),
  ('facturacion@4housing.com.ar'),
  ('gonzalopalacios@4housing.com.ar'),
  ('gustavopedretti@4housing.com.ar'),
  ('hectorbermudez@4housing.com.ar'),
  ('ignaciosanchez@4housing.com.ar'),
  ('ileanacallero@4housing.com.ar'),
  ('ivangaray@4housing.com.ar'),
  ('juancallero@4housing.com.ar'),
  ('leandroseoane@4housing.com.ar'),
  ('micaela@4housing.com.ar'),
  ('milagroscortinas@4housing.com.ar'),
  ('nicolaskomina@4housing.com.ar'),
  ('nicolasmendoza@4housing.com.ar'),
  ('pablospinetto@4housing.com.ar'),
  ('valentinaquiencke@4housing.com.ar'),
  ('victorialopezaybar@4housing.com.ar')
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
