-- ============================================================================
-- Portal 4housing — 085 · prov_evaluaciones: auditoría por sentencia + limpieza
-- ============================================================================
-- El tablero seguía mostrando ~10.518 movimientos en compras_prov_evaluaciones.
-- Esa tabla recibe una IMPORTACIÓN MASIVA (evaluaciones de proveedores) y tenía
-- auditoría FILA-POR-FILA, así que cada fila importada contaba como un movimiento.
-- (El trigger no está versionado en el repo: la tabla se creó directo en Supabase,
-- así que acá se busca y reemplaza cualquier trigger de auditoría que tenga, sin
-- depender de su nombre.)
--
-- Mismo criterio que 084: pasa a auditoría por SENTENCIA → una importación = un
-- movimiento; una evaluación cargada a mano = un movimiento. (La app ya importa en
-- un solo POST.) Y limpia los movimientos ya inflados.
--
-- Requiere que exista fn_core_auditoria_stmt (creada en 084). Correr en wcpk
-- después de 084. Idempotente.
-- ============================================================================

-- 1) Sacar cualquier trigger de auditoría FILA-POR-FILA que tenga la tabla
--    (sea cual sea su nombre, mientras llame a fn_core_auditoria / _stmt).
do $$
declare r record;
begin
  if to_regclass('public.compras_prov_evaluaciones') is null then
    raise notice 'compras_prov_evaluaciones no existe; nada que hacer'; return;
  end if;
  for r in
    select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc  p on p.oid = t.tgfoid
     where c.relname = 'compras_prov_evaluaciones'
       and not t.tgisinternal
       and p.proname in ('fn_core_auditoria','fn_core_auditoria_stmt')
  loop
    execute format('drop trigger if exists %I on public.compras_prov_evaluaciones', r.tgname);
  end loop;

  -- 2) Instalar auditoría por SENTENCIA (una por operación, con su tabla de transición).
  execute 'create trigger zz_aud_stmt_ins after insert on public.compras_prov_evaluaciones referencing new table as added   for each statement execute function public.fn_core_auditoria_stmt(''compras'')';
  execute 'create trigger zz_aud_stmt_upd after update on public.compras_prov_evaluaciones referencing new table as added   for each statement execute function public.fn_core_auditoria_stmt(''compras'')';
  execute 'create trigger zz_aud_stmt_del after delete on public.compras_prov_evaluaciones referencing old table as removed for each statement execute function public.fn_core_auditoria_stmt(''compras'')';
end $$;

-- 3) Limpieza: borrar los movimientos ya inflados (filas por-fila) de esa tabla.
delete from public.core_auditoria
 where sector = 'compras'
   and tabla  = 'compras_prov_evaluaciones'
   and accion in ('INSERT','UPDATE','DELETE');

-- Verificación: movimientos de Compras por tabla (prov_evaluaciones debería desaparecer o quedar mínimo).
select tabla, count(*) as movimientos
  from public.core_auditoria
 where sector = 'compras'
 group by tabla order by movimientos desc;
