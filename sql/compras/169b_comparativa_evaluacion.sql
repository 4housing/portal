-- ============================================================================
-- Portal 4housing · 169b · Comparativas: evaluación del proveedor por oferta
-- ============================================================================
-- Agrega la columna para el factor "evaluación del proveedor" (0–10) que entra en
-- el puntaje guía (precio 60% · plazo 20% · evaluación 20%). Por ahora se carga a
-- mano por oferta; más adelante se puede auto-completar desde compras_prov_evaluaciones.
-- Correr en wcpk después de 169. Idempotente.
-- ============================================================================

alter table public.compras_comparativa_ofertas
  add column if not exists evaluacion numeric;   -- 0 a 10 (opcional)
