-- ============================================================================
-- Portal 4housing — 100 · "lector" = solo lectura en Compras, EERR y 2 tablas
--                        de Comercial que no tenían compuerta de escritura
-- ============================================================================
-- ESTADO: YA APLICADO en producción el 2026-11-22 (corrido vía Claude con OK
-- puntual de Pablo). Este archivo lo versiona. Es idempotente: re-correrlo deja
-- el mismo resultado.
--
-- PROBLEMA: estas tablas tenían una única política PERMISSIVE "FOR ALL USING
-- tiene_sector(x)", sin políticas de escritura (ni permisivas ni RESTRICTIVE).
-- Resultado: cualquier usuario con el sector, incluso cargo 'lector', podía
-- crear/modificar/borrar a nivel base.
--
-- CAMBIO: la política general pasa a FOR SELECT (mismo nombre, misma condición)
-- y se agregan políticas de escritura con puede_editar_sector(x).
--   · compras_proveedores conserva su DELETE false (nadie borra): no se le
--     agrega política de DELETE.
--
-- FUERA DE ALCANCE (a propósito): Planificación, Comercial (resto de tablas),
-- Diseño y LABO ya tienen políticas RESTRICTIVE de escritura (061/063/064/065).
-- NO aplicar este patrón ahí: quitar su FOR ALL deja a TODOS sin escritura,
-- porque las RESTRICTIVE solo restringen, no habilitan (incidente 2026-11-22,
-- revertido en el momento).
--
-- EFECTO EN USUARIOS: pierden escritura solo los cargos 'lector' de Compras
-- y EERR. Dirección no se ve afectada (cargo_en_sector devuelve 'direccion').
-- ============================================================================

begin;
do $$
declare
  item text;
  t text; pol text; sec text;
  items text[] := array[
    -- tabla : política general existente : sector
    'agenda_tareas:agenda_tareas_fhcomercial:fhcomercial',
    'cierres_mensuales:cierres_mensuales_fhcomercial:fhcomercial',
    'eerr_estado:eerr_sector:eerr',
    'compras_articulos:compras_sector:compras',
    'compras_caja_ingresos:compras_sector:compras',
    'compras_certificadores:compras_sector:compras',
    'compras_clasif_comprobantes:compras_sector:compras',
    'compras_clasif_renglon:compras_ref_write:compras',
    'compras_comparativa_ofertas:compras_comp_sector:compras',
    'compras_comparativas:compras_comp_sector:compras',
    'compras_depositos:compras_sector:compras',
    'compras_gp_importaciones:compras_gp_sector:compras',
    'compras_gp_mapeo:compras_gp_sector:compras',
    'compras_gp_oc:compras_gp_sector:compras',
    'compras_gp_og_seccion:compras_gp_og_seccion_sector:compras',
    'compras_gp_presupuesto:compras_gp_sector:compras',
    'compras_gp_proyectos:compras_gp_sector:compras',
    'compras_gp_reparto:compras_gp_sector:compras',
    'compras_herr_operaciones:compras_sector:compras',
    'compras_herramientas:compras_sector:compras',
    'compras_idx_cac:compras_sector:compras',
    'compras_idx_dolar_blue:compras_sector:compras',
    'compras_idx_dolar_oficial:compras_sector:compras',
    'compras_idx_facpce:compras_ref_write:compras',
    'compras_idx_ipc:compras_sector:compras',
    'compras_idx_poli:compras_sector:compras',
    'compras_idx_uva:compras_sector:compras',
    'compras_inspecciones:compras_sector:compras',
    'compras_mantenimiento:compras_sector:compras',
    'compras_modulos:compras_sector:compras',
    'compras_motivos_cierre:compras_sector:compras',
    'compras_og_certificados:compras_sector:compras',
    'compras_ogs:compras_sector:compras',
    'compras_opciones_og:compras_sector:compras',
    'compras_panol_egresos:compras_sector:compras',
    'compras_panol_galpones:compras_panol_galpones_all:compras',
    'compras_panol_herr:compras_panol_herr_all:compras',
    'compras_panol_kit_items:compras_panol_kit_items_all:compras',
    'compras_panol_kits:compras_panol_kits_all:compras',
    'compras_panol_om:compras_panol_om_all:compras',
    'compras_panol_om_cotizaciones:compras_panol_om_cot_all:compras',
    'compras_panol_om_motivos:compras_panol_om_motivos_all:compras',
    'compras_panol_operarios:compras_panol_operarios_all:compras',
    'compras_panol_precios_mes:compras_panol_precios_mes_all:compras',
    'compras_panol_responsables:compras_panol_responsables_all:compras',
    'compras_panol_solicitantes:compras_panol_solicitantes_all:compras',
    'compras_panol_solicitud_items:compras_panol_solicitud_items_all:compras',
    'compras_panol_solicitudes:compras_panol_solicitudes_all:compras',
    'compras_proveedores:compras_sector:compras',
    'compras_proyectos:compras_sector:compras',
    'compras_series:compras_sector:compras',
    'compras_series_activas:compras_sector:compras',
    'compras_solicitudes_pago:compras_sector:compras',
    'compras_stock_saldos:compras_sector:compras',
    'compras_unidades_medida:compras_unidades_medida_all:compras',
    'compras_usd_diario:compras_ref_write:compras',
    'compras_usd_diario_oficial:compras_ref_write:compras'
  ];
begin
  foreach item in array items loop
    t   := split_part(item, ':', 1);
    pol := split_part(item, ':', 2);
    sec := split_part(item, ':', 3);
    if to_regclass('public.'||t) is null then raise notice 'salteo %, no existe', t; continue; end if;

    -- 1) general -> solo lectura
    execute format('drop policy if exists %I on public.%I', pol, t);
    execute format('create policy %I on public.%I for select to authenticated using (public.tiene_sector(%L::sector_portal))', pol, t, sec);

    -- 2) escritura solo para quien puede editar el sector
    execute format('drop policy if exists %I on public.%I', t||'_insert_editor', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.puede_editar_sector(%L::sector_portal))', t||'_insert_editor', t, sec);

    execute format('drop policy if exists %I on public.%I', t||'_update_editor', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.puede_editar_sector(%L::sector_portal)) with check (public.puede_editar_sector(%L::sector_portal))', t||'_update_editor', t, sec, sec);

    if t <> 'compras_proveedores' then  -- proveedores: se mantiene "nadie borra"
      execute format('drop policy if exists %I on public.%I', t||'_delete_editor', t);
      execute format('create policy %I on public.%I for delete to authenticated using (public.puede_editar_sector(%L::sector_portal))', t||'_delete_editor', t, sec);
    end if;
  end loop;
end $$;
commit;

-- ============================================================================
-- ROLLBACK (manual, solo si hiciera falta volver atrás):
-- por cada tabla de la lista:
--   drop policy <t>_insert_editor / <t>_update_editor / <t>_delete_editor;
--   drop policy <pol>;
--   create policy <pol> on public.<t> for all to authenticated
--     using (public.tiene_sector('<sec>'::sector_portal))
--     with check (public.tiene_sector('<sec>'::sector_portal));
-- ============================================================================
