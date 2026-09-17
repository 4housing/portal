-- ============================================================================
-- Portal 4housing — 050 · Alta del sector 'eerr'
-- ============================================================================
-- La app "Gestión · EERR" ya figura como módulo en el portal (index.html),
-- pero su sector nunca se dio de alta en el enum sector_portal. Sin este
-- valor, perfiles_sector no puede guardar sector='eerr', así que la app solo
-- la ve dirección (que ve todos los módulos) y no se le puede asignar a nadie
-- más — de hecho el desplegable de admin.html tampoco la ofrecía.
--
-- Correr esta migración en el editor SQL de Supabase. Después de correrla,
-- la opción "Gestión · EERR" aparece en la pantalla de Usuarios (/portal/admin.html)
-- y se le puede asignar el sector a cualquier perfil.
--
-- NOTA: ALTER TYPE ... ADD VALUE debe ejecutarse fuera de un bloque de
-- transacción. El editor SQL de Supabase corre cada sentencia por separado,
-- así que alcanza con ejecutar esta línea sola.
-- ============================================================================

-- A · Agregar 'eerr' al enum de sectores. Idempotente (IF NOT EXISTS).
alter type public.sector_portal add value if not exists 'eerr';

-- B · Verificación: listar los valores del enum. Debe aparecer 'eerr'.
select enumlabel
  from pg_enum
 where enumtypid = 'public.sector_portal'::regtype
 order by enumsortorder;
