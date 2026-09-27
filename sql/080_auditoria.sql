-- ============================================================================
-- Portal 4housing — 080 · Auditoría automática (quién/qué/cuándo/cómo)
-- ============================================================================
-- Correr en el proyecto del PORTAL. Igual de completo que el audit_log de
-- Comercial (captura INSERT/UPDATE/DELETE con fila ANTES y DESPUÉS, usuario y
-- fecha), pero en UNA tabla compartida con columna `sector`. Así funciona como
-- "log por app" (se filtra por sector, y la RLS deja ver solo lo del propio
-- sector) y a la vez como base del consolidado de indicadores más adelante.
--
-- Comercial sigue con su audit_log actual (ya funciona); el dashboard consolidado
-- luego unirá ambas fuentes. Se puede correr de nuevo sin problema (idempotente).
-- ============================================================================

-- 1) Tabla de auditoría --------------------------------------------------------
create table if not exists public.core_auditoria (
  id           bigint generated always as identity primary key,
  sector       public.sector_portal not null,
  tabla        text        not null,
  registro_id  text,
  accion       text        not null,   -- INSERT | UPDATE | DELETE
  datos_antes  jsonb,
  datos_despues jsonb,
  usuario_id   uuid,
  usuario_email text,
  cambiado_en  timestamptz not null default now()
);
create index if not exists core_auditoria_sector_fecha on public.core_auditoria (sector, cambiado_en desc);
create index if not exists core_auditoria_tabla_reg   on public.core_auditoria (tabla, registro_id);

alter table public.core_auditoria enable row level security;
grant select on public.core_auditoria to authenticated;
-- Lectura: cada sector ve lo suyo (dirección ve todo). Nadie escribe directo:
-- solo el trigger (SECURITY DEFINER) inserta, así que no hay policy de escritura.
drop policy if exists core_auditoria_select on public.core_auditoria;
create policy core_auditoria_select on public.core_auditoria
  for select to authenticated using (public.tiene_sector(sector));

-- 2) Función de trigger genérica ----------------------------------------------
-- El sector se pasa como argumento del trigger: EXECUTE FUNCTION fn_core_auditoria('labocomercial')
create or replace function public.fn_core_auditoria()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_sector public.sector_portal := TG_ARGV[0]::public.sector_portal;
  v_uid uuid := auth.uid();
  v_email text;
  j_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
  j_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end;
begin
  if v_uid is not null then
    select email into v_email from public.perfiles where id = v_uid;
  end if;
  insert into public.core_auditoria(sector, tabla, registro_id, accion, datos_antes, datos_despues, usuario_id, usuario_email)
  values (v_sector, TG_TABLE_NAME, coalesce(j_new->>'id', j_old->>'id'), TG_OP, j_old, j_new, v_uid, v_email);
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

-- 3) Enganchar el trigger a las tablas de cada app ----------------------------
-- LABO
do $$
declare t text; tbls text[] := array[
  'labocomercial_leads','labocomercial_counters','labocomercial_contactos_web'];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo %', t; continue; end if;
    execute format('drop trigger if exists zz_auditoria on public.%I', t);
    execute format('create trigger zz_auditoria after insert or update or delete on public.%I for each row execute function public.fn_core_auditoria(%L)', t, 'labocomercial');
  end loop;
end $$;

-- COMPRAS (se excluyen ui_prefs y los feeds de cotización usd_diario*, que son ruido)
do $$
declare t text; tbls text[] := array[
  'articulos','aux_opciones','aux_tipos','caja','caja_ingresos','clasif_comprobantes',
  'clasif_renglon','cuentas_contables','depositos','herr_operaciones','herramientas',
  'inspecciones','mantenimiento','motivos_cierre','oc_informe','og_certificados','ogs',
  'pagos','panol_egresos','proveedores','series_activas','solicitudes_pago','stock_saldos',
  'usuarios_autorizados','usuarios_publicos'];
begin
  foreach t in array tbls loop
    if to_regclass('public.'||t) is null then raise notice 'salteo %', t; continue; end if;
    execute format('drop trigger if exists zz_auditoria on public.%I', t);
    execute format('create trigger zz_auditoria after insert or update or delete on public.%I for each row execute function public.fn_core_auditoria(%L)', t, 'compras');
  end loop;
end $$;

-- EERR: pendiente de confirmar sus tablas (parece guardar bastante en localStorage).
-- Cuando confirmemos las tablas reales, se agrega un bloque igual con sector 'eerr'.

-- 4) Verificación --------------------------------------------------------------
select event_object_table as tabla, trigger_name
  from information_schema.triggers
 where trigger_name = 'zz_auditoria'
 order by 1;
