-- ============================================================================
-- Portal 4housing — Compras · 117 · Policies del bucket de Storage "facturas"
-- ============================================================================
-- El bucket "facturas" (privado) ya se creó en wcpk. Estas policies permiten que
-- los usuarios del sector compras suban/lean/borren archivos de ESE bucket
-- (la app sube con el token del usuario y descarga con URL firmada).
-- Correr en el SQL Editor de wcpk. Chico. Idempotente (drop if exists).
-- ============================================================================
drop policy if exists compras_facturas_rw on storage.objects;
create policy compras_facturas_rw on storage.objects
  for all to authenticated
  using  (bucket_id = 'facturas' and public.tiene_sector('compras'::public.sector_portal))
  with check (bucket_id = 'facturas' and public.tiene_sector('compras'::public.sector_portal));
