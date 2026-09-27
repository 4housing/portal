-- ============================================================================
-- Portal 4housing — 062 · Validación del canary RLS de Diseño (SIN cambiar datos)
-- ============================================================================
-- Correr DESPUÉS de 060 y 061. Prueba que "solo visión" no puede escribir y que
-- un editor sí, impersonando a cada usuario por auth.uid() y revirtiendo todo al
-- final (rollback). No modifica datos ni necesita que nadie inicie sesión.
--
-- PASO 1 (elegí los usuarios): reemplazá los dos emails de abajo por uno con
-- cargo lector/lectura y otro con cargo que edite (diseno/coordinador/admin),
-- ambos del sector diseño. Para verlos, corré primero esta consulta:
--
--   select p.email, ps.cargo
--     from public.perfiles p
--     join public.perfiles_sector ps on ps.perfil_id = p.id
--    where ps.sector = 'diseno' order by ps.cargo;
--
-- PASO 2: pegá los emails y ejecutá TODO el bloque begin…rollback.
-- Resultado esperado:
--   lector_puede_editar   = false      lector_update_filas   = 0
--   editor_puede_editar   = true       editor_update_filas   > 0  (si hay proyectos)
-- ============================================================================

begin;

create temp table _val(lector uuid, editor uuid) on commit drop;
insert into _val(lector, editor) values (
  (select id from public.perfiles where email = 'REEMPLAZAR_LECTOR@4housing.com.ar'),
  (select id from public.perfiles where email = 'REEMPLAZAR_EDITOR@4housing.com.ar')
);

-- ---- LECTOR: no debe poder editar ----
select set_config('request.jwt.claims',
  json_build_object('sub', (select lector from _val), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.puede_editar_sector('diseno') as lector_puede_editar;   -- esperado: false
with u as (update public.diseno_proyectos set nombre = nombre returning 1)
  select count(*) as lector_update_filas from u;                      -- esperado: 0
reset role;

-- ---- EDITOR: sí debe poder editar ----
select set_config('request.jwt.claims',
  json_build_object('sub', (select editor from _val), 'role', 'authenticated')::text, true);
set local role authenticated;
select public.puede_editar_sector('diseno') as editor_puede_editar;   -- esperado: true
with u as (update public.diseno_proyectos set nombre = nombre returning 1)
  select count(*) as editor_update_filas from u;                      -- esperado: > 0
reset role;

rollback;  -- no se cambió ningún dato
