-- ============================================================================
-- Portal 4housing — 090 · Alta de los sectores 'adminfin' y 'rrhh'
-- ============================================================================
-- Dos apps nuevas: "Administración y Finanzas" y "Recursos Humanos".
-- Arrancan como esqueleto vacío (mismo shell de acceso que el resto del
-- portal, sin funcionalidad propia todavía) en:
--   https://4housing.github.io/4housing-adminfin/
--   https://4housing.github.io/4housing-rrhh/
--
-- Sin este alta, perfiles_sector no puede guardar sector='adminfin' /
-- sector='rrhh' y nadie salvo dirección puede entrar a esas apps.
--
-- Correr esta migración en el editor SQL de Supabase. Después de correrla,
-- ambas opciones aparecen en la pantalla de Usuarios (/portal/admin.html)
-- y se les puede asignar el sector a cualquier perfil.
--
-- NOTA: ALTER TYPE ... ADD VALUE debe ejecutarse fuera de un bloque de
-- transacción. El editor SQL de Supabase corre cada sentencia por separado,
-- así que alcanza con ejecutar estas líneas sueltas.
-- ============================================================================

-- A · Agregar los sectores al enum. Idempotente (IF NOT EXISTS).
alter type public.sector_portal add value if not exists 'adminfin';
alter type public.sector_portal add value if not exists 'rrhh';

-- B · Verificación: listar los valores del enum. Deben aparecer ambos.
select enumlabel
  from pg_enum
 where enumtypid = 'public.sector_portal'::regtype
 order by enumsortorder;
