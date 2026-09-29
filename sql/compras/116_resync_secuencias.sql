-- ============================================================================
-- Portal 4housing — Compras · 116 · Resync de secuencias (correr DESPUÉS de cargar datos)
-- ============================================================================
-- Los datos se cargan por REST (INSERT con id explícito), así que las secuencias
-- identity no avanzan solas. Esto las pone al máximo actual para que los próximos
-- inserts no colisionen. Es chico: se puede pegar en el SQL Editor de wcpk.
-- Idempotente: se puede correr varias veces.
-- ============================================================================
select setval(pg_get_serial_sequence('public.compras_articulos','id'),        coalesce((select max(id) from public.compras_articulos),1),        (select max(id) is not null from public.compras_articulos));
select setval(pg_get_serial_sequence('public.compras_aux_opciones','id'),      coalesce((select max(id) from public.compras_aux_opciones),1),      (select max(id) is not null from public.compras_aux_opciones));
select setval(pg_get_serial_sequence('public.compras_aux_tipos','id'),         coalesce((select max(id) from public.compras_aux_tipos),1),         (select max(id) is not null from public.compras_aux_tipos));
select setval(pg_get_serial_sequence('public.compras_caja_ingresos','id'),     coalesce((select max(id) from public.compras_caja_ingresos),1),     (select max(id) is not null from public.compras_caja_ingresos));
select setval(pg_get_serial_sequence('public.compras_certificadores','id'),    coalesce((select max(id) from public.compras_certificadores),1),    (select max(id) is not null from public.compras_certificadores));
select setval(pg_get_serial_sequence('public.compras_clasif_renglon','id'),    coalesce((select max(id) from public.compras_clasif_renglon),1),    (select max(id) is not null from public.compras_clasif_renglon));
select setval(pg_get_serial_sequence('public.compras_cuentas','id'),           coalesce((select max(id) from public.compras_cuentas),1),           (select max(id) is not null from public.compras_cuentas));
select setval(pg_get_serial_sequence('public.compras_cuentas_contables','id'), coalesce((select max(id) from public.compras_cuentas_contables),1), (select max(id) is not null from public.compras_cuentas_contables));
select setval(pg_get_serial_sequence('public.compras_depositos','id'),         coalesce((select max(id) from public.compras_depositos),1),         (select max(id) is not null from public.compras_depositos));
select setval(pg_get_serial_sequence('public.compras_herr_operaciones','id'),  coalesce((select max(id) from public.compras_herr_operaciones),1),  (select max(id) is not null from public.compras_herr_operaciones));
select setval(pg_get_serial_sequence('public.compras_herramientas','id'),      coalesce((select max(id) from public.compras_herramientas),1),      (select max(id) is not null from public.compras_herramientas));
select setval(pg_get_serial_sequence('public.compras_inspecciones','id'),      coalesce((select max(id) from public.compras_inspecciones),1),      (select max(id) is not null from public.compras_inspecciones));
select setval(pg_get_serial_sequence('public.compras_mantenimiento','id'),     coalesce((select max(id) from public.compras_mantenimiento),1),     (select max(id) is not null from public.compras_mantenimiento));
select setval(pg_get_serial_sequence('public.compras_modulos','id'),           coalesce((select max(id) from public.compras_modulos),1),           (select max(id) is not null from public.compras_modulos));
select setval(pg_get_serial_sequence('public.compras_motivos_cierre','id'),    coalesce((select max(id) from public.compras_motivos_cierre),1),    (select max(id) is not null from public.compras_motivos_cierre));
select setval(pg_get_serial_sequence('public.compras_oc_informe','id'),        coalesce((select max(id) from public.compras_oc_informe),1),        (select max(id) is not null from public.compras_oc_informe));
select setval(pg_get_serial_sequence('public.compras_og_certificados','id'),   coalesce((select max(id) from public.compras_og_certificados),1),   (select max(id) is not null from public.compras_og_certificados));
select setval(pg_get_serial_sequence('public.compras_ogs','id'),               coalesce((select max(id) from public.compras_ogs),1),               (select max(id) is not null from public.compras_ogs));
select setval(pg_get_serial_sequence('public.compras_opciones_og','id'),       coalesce((select max(id) from public.compras_opciones_og),1),       (select max(id) is not null from public.compras_opciones_og));
select setval(pg_get_serial_sequence('public.compras_pagos','id'),             coalesce((select max(id) from public.compras_pagos),1),             (select max(id) is not null from public.compras_pagos));
select setval(pg_get_serial_sequence('public.compras_panol_egresos','id'),     coalesce((select max(id) from public.compras_panol_egresos),1),     (select max(id) is not null from public.compras_panol_egresos));
select setval(pg_get_serial_sequence('public.compras_proveedores','id'),       coalesce((select max(id) from public.compras_proveedores),1),       (select max(id) is not null from public.compras_proveedores));
select setval(pg_get_serial_sequence('public.compras_proyectos','id'),         coalesce((select max(id) from public.compras_proyectos),1),         (select max(id) is not null from public.compras_proyectos));
select setval(pg_get_serial_sequence('public.compras_series','id'),            coalesce((select max(id) from public.compras_series),1),            (select max(id) is not null from public.compras_series));
select setval(pg_get_serial_sequence('public.compras_solicitudes_pago','id'),  coalesce((select max(id) from public.compras_solicitudes_pago),1),  (select max(id) is not null from public.compras_solicitudes_pago));
select setval(pg_get_serial_sequence('public.compras_tipos_aux','id'),         coalesce((select max(id) from public.compras_tipos_aux),1),         (select max(id) is not null from public.compras_tipos_aux));
-- secuencias no-identity (default nextval):
select setval('public.compras_ogs_numero_seq', greatest(coalesce((select max(numero::bigint) from public.compras_ogs where numero ~ '^[0-9]+$'),1),1));
select setval('public.compras_pagos_op_seq',   greatest(coalesce((select max(op_numero) from public.compras_pagos),1),1));
