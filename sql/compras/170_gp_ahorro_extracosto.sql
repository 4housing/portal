-- ============================================================================
-- Portal 4housing · 170 · GP · Ahorro / extracosto + clasificación manual de OGs
-- ============================================================================
-- (1) "Cerrar rubro": marca una sección como COMPRA TERMINADA. Recién ahí el
--     (presupuesto - comprado) cuenta como AHORRO CONFIRMADO. El EXTRACOSTO
--     (comprado > presupuesto) se calcula siempre, esté o no cerrado el rubro.
--     Lo pueden marcar dirección o compradores.
-- (2) Clasificación manual de OGs: muchas OGs vienen con el costeo en "No Aplica"
--     u "Otros" y no se pueden imputar a un rubro. Esta tabla guarda, por proyecto
--     y por OG, a qué sección va (asignación a mano, una sola vez).
--
-- Correr en wcpk ANTES de publicar el HTML. Idempotente. RLS: sector compras.
-- ============================================================================

-- (1) Flag de rubro cerrado en el presupuesto del proyecto
alter table public.compras_gp_presupuesto
  add column if not exists cerrada     boolean not null default false,
  add column if not exists cerrada_por text,
  add column if not exists cerrada_en  timestamptz;

-- (2) Clasificación manual de OGs por proyecto (override de sección)
create table if not exists public.compras_gp_og_seccion (
  proyecto_id   bigint not null references public.compras_gp_proyectos(id) on delete cascade,
  og_id         bigint not null,
  seccion       text   not null,
  asignado_por  text,
  asignado_en   timestamptz not null default now(),
  primary key (proyecto_id, og_id)
);
create index if not exists compras_gp_og_seccion_proy on public.compras_gp_og_seccion(proyecto_id);

-- RLS: authenticated + sector compras (mismo patrón que el resto de compras_gp_*)
alter table public.compras_gp_og_seccion enable row level security;
revoke all on public.compras_gp_og_seccion from anon;
grant select, insert, update, delete on public.compras_gp_og_seccion to authenticated;
drop policy if exists compras_gp_og_seccion_sector on public.compras_gp_og_seccion;
create policy compras_gp_og_seccion_sector on public.compras_gp_og_seccion
  for all to authenticated
  using (public.tiene_sector('compras'::public.sector_portal))
  with check (public.tiene_sector('compras'::public.sector_portal));
