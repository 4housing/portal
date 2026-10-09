-- ============================================================================
-- Portal 4housing — 084 · Importaciones = UN movimiento (auditoría por sentencia)
-- ============================================================================
-- Problema: tras 082, el tablero mostró ~10.811 movimientos de Compras. La causa
-- es la IMPORTACIÓN masiva de SOLP (lista "Seguimiento Compras" de SharePoint):
-- insertaba miles de filas y la auditoría fila-por-fila contaba cada una como un
-- movimiento. Habíamos definido que cada importación es UN solo movimiento.
--
-- Solución: para las tablas con cargas masivas (compras_solp_items y el "pedir pago"
-- múltiple de compras_solicitudes_pago) se usa auditoría a NIVEL DE SENTENCIA:
-- una sentencia INSERT/UPDATE/DELETE = UN movimiento, sin importar cuántas filas.
--   · Un alta/edición normal (una fila)      → 1 movimiento.
--   · Una importación (un POST de N filas)    → 1 movimiento (dice "INSERT ×N").
-- (La app ya hace la importación de SOLP en un solo POST, así es 1 movimiento.)
--
-- Correr en wcpk después de 082/083. Idempotente.
-- ============================================================================

-- 1) Función de auditoría a nivel de sentencia (cuenta filas por tabla de transición)
create or replace function public.fn_core_auditoria_stmt()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_sector public.sector_portal := TG_ARGV[0]::public.sector_portal;
  v_n int := 0;
begin
  if TG_OP = 'DELETE' then select count(*) into v_n from removed;
  else                      select count(*) into v_n from added;
  end if;
  if v_n = 0 then return null; end if;
  if v_uid is not null then select email into v_email from public.perfiles where id = v_uid; end if;
  insert into public.core_auditoria(sector, tabla, registro_id, accion, datos_antes, datos_despues, usuario_id, usuario_email)
  values (v_sector, TG_TABLE_NAME, null,
          TG_OP || (case when v_n > 1 then ' ×' || v_n else '' end),
          null, null, v_uid, v_email);
  return null;
end $$;

-- 2) Cambiar esas tablas de auditoría por-fila (zz_auditoria de 082) a por-sentencia.
do $$
declare t text; tbls text[] := array['compras_solp_items','compras_solicitudes_pago'];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo % (no existe)', t; continue; end if;
    -- saca el trigger por-fila
    execute format('drop trigger if exists zz_auditoria on public.%I', t);
    -- triggers por-sentencia (uno por operación, con su tabla de transición)
    execute format('drop trigger if exists zz_aud_stmt_ins on public.%I', t);
    execute format('drop trigger if exists zz_aud_stmt_upd on public.%I', t);
    execute format('drop trigger if exists zz_aud_stmt_del on public.%I', t);
    execute format('create trigger zz_aud_stmt_ins after insert on public.%I referencing new table as added   for each statement execute function public.fn_core_auditoria_stmt(%L)', t, 'compras');
    execute format('create trigger zz_aud_stmt_upd after update on public.%I referencing new table as added   for each statement execute function public.fn_core_auditoria_stmt(%L)', t, 'compras');
    execute format('create trigger zz_aud_stmt_del after delete on public.%I referencing old table as removed for each statement execute function public.fn_core_auditoria_stmt(%L)', t, 'compras');
  end loop;
end $$;

-- 3) Limpieza: borrar los movimientos ya inflados por la importación de SOLP
--    (las filas por-fila que registró la auditoría de 082 antes de este arreglo).
delete from public.core_auditoria
 where sector = 'compras'
   and tabla  = 'compras_solp_items'
   and accion in ('INSERT','UPDATE','DELETE');   -- las por-fila; las nuevas por-sentencia dicen "INSERT ×N"

-- Verificación: movimientos de Compras por tabla (debería bajar muchísimo).
select tabla, count(*) as movimientos
  from public.core_auditoria
 where sector = 'compras'
 group by tabla order by movimientos desc;
