-- ============================================================================
-- Portal 4housing — Compras · 100 · RADIOGRAFÍA del proyecto aaqp (SOLO LECTURA)
-- ============================================================================
-- Correr en el SQL Editor de Supabase DEL PROYECTO DE COMPRAS
-- (aaqpzamcdxldhqyuqlgm), NO en el del portal (wcpk). Es 100% lectura: no
-- crea, no modifica, no borra nada. Devuelve TODO en una sola celda JSON
-- (el editor solo muestra el resultado de la última consulta): hacer clic en
-- la celda, copiar y pegar el bloque completo en el chat.
--
-- Sirve para replicar el esquema de Compras en wcpk con prefijo compras_,
-- migrar datos, buckets de Storage y usuarios. Incluye código de funciones y
-- definición de vistas para poder recrearlas idénticas.
-- ============================================================================

select jsonb_pretty(jsonb_build_object(

  -- 1 · Tablas del esquema public + RLS + estimación de filas + tamaño
  'tablas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', c.relname,
             'rls_activado', c.relrowsecurity,
             'filas_estimadas', c.reltuples::bigint,
             'tamano', pg_size_pretty(pg_total_relation_size(c.oid))
           ) order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  ),

  -- 2 · Columnas (tipo, nullable, default, orden)
  'columnas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', table_name,
             'columna', column_name,
             'tipo', data_type,
             'udt', udt_name,
             'nullable', is_nullable,
             'default', column_default,
             'pos', ordinal_position
           ) order by table_name, ordinal_position), '[]'::jsonb)
      from information_schema.columns
     where table_schema = 'public'
  ),

  -- 3 · Primary keys
  'primary_keys', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', tc.table_name,
             'columna', kcu.column_name,
             'constraint', tc.constraint_name
           ) order by tc.table_name, kcu.ordinal_position), '[]'::jsonb)
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
       and kcu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'
  ),

  -- 4 · Foreign keys (para saber qué depende de qué y el orden de carga)
  'foreign_keys', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', tc.table_name,
             'columna', kcu.column_name,
             'referencia_tabla', ccu.table_name,
             'referencia_columna', ccu.column_name,
             'constraint', tc.constraint_name
           ) order by tc.table_name), '[]'::jsonb)
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
  ),

  -- 5 · Check constraints (roles, enums simulados por check, etc.)
  'checks', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', rel.relname,
             'constraint', con.conname,
             'definicion', pg_get_constraintdef(con.oid)
           ) order by rel.relname, con.conname), '[]'::jsonb)
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public' and con.contype = 'c'
  ),

  -- 6 · Índices
  'indices', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', tablename,
             'indice', indexname,
             'definicion', indexdef
           ) order by tablename, indexname), '[]'::jsonb)
      from pg_indexes
     where schemaname = 'public'
  ),

  -- 7 · RLS: políticas
  'politicas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', tablename,
             'politica', policyname,
             'roles', roles::text,
             'cmd', cmd,
             'using', qual,
             'check', with_check
           ) order by tablename, policyname), '[]'::jsonb)
      from pg_policies
     where schemaname = 'public'
  ),

  -- 8 · Grants a anon / authenticated
  'grants', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', g.table_name,
             'rol', g.grantee,
             'privilegios', g.privs
           ) order by g.table_name, g.grantee), '[]'::jsonb)
      from (select table_name, grantee, string_agg(privilege_type, ',') as privs
              from information_schema.role_table_grants
             where table_schema = 'public' and grantee in ('anon','authenticated')
             group by table_name, grantee) g
  ),

  -- 9 · Funciones / RPCs con su código completo (para recrearlas idénticas)
  'funciones', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'funcion', p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'security_definer', p.prosecdef,
             'lang', l.lanname,
             'acl', p.proacl::text,
             'codigo', pg_get_functiondef(p.oid)
           ) order by p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public'
  ),

  -- 10 · Triggers
  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tabla', c.relname,
             'trigger', t.tgname,
             'definicion', pg_get_triggerdef(t.oid)
           ) order by c.relname, t.tgname), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal
  ),

  -- 11 · Vistas (con definición)
  'vistas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'vista', table_name,
             'definicion', view_definition
           ) order by table_name), '[]'::jsonb)
      from information_schema.views
     where table_schema = 'public'
  ),

  -- 12 · Secuencias (identity/serial) con su valor actual
  'secuencias', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'secuencia', sequencename,
             'ultimo_valor', last_value
           ) order by sequencename), '[]'::jsonb)
      from pg_sequences
     where schemaname = 'public'
  ),

  -- 13 · Storage: buckets + cantidad de objetos por bucket
  'storage_buckets', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'bucket', b.id,
             'nombre', b.name,
             'publico', b.public,
             'objetos', (select count(*) from storage.objects o where o.bucket_id = b.id)
           ) order by b.id), '[]'::jsonb)
      from storage.buckets b
  ),

  -- 14 · Usuarios de auth (para pre-crear/vincular por email en wcpk)
  'auth_usuarios', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'email', u.email,
             'confirmado', (u.email_confirmed_at is not null),
             'creado', u.created_at,
             'ultimo_login', u.last_sign_in_at
           ) order by u.email), '[]'::jsonb)
      from auth.users u
  )

)) as radiografia_aaqp;
