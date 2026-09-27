-- ============================================================================
-- Portal 4housing — 070 · Limpieza de cargos heredados (opción A)
-- ============================================================================
-- Correr en el proyecto del PORTAL. Convierte solo los cargos viejos que NO son
-- roles de la app a su equivalente nuevo. Los cargos 'coordinador', 'pm' y
-- 'diseno' NO se tocan: ahora son roles de verdad en el panel (Diseño y
-- Planificación los usan internamente; cambiarlos rompería, p.ej., quién puede
-- tildar tareas en Diseño).
--   lectura → lector     (ambos = solo visión; unifica el nombre)
--   miembro → editor     (miembro = edita; el rol nuevo equivalente es 'editor')
-- Idempotente. Mostrá el "antes" para ver si hay algo que convertir.
-- ============================================================================

-- Antes:
select cargo, count(*) from public.perfiles_sector group by cargo order by cargo;

update public.perfiles_sector set cargo = 'lector' where cargo = 'lectura';
update public.perfiles_sector set cargo = 'editor' where cargo = 'miembro';

-- Después:
select cargo, count(*) from public.perfiles_sector group by cargo order by cargo;
