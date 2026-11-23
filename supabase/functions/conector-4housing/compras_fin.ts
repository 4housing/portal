// ============================================================================
// Compras · Foto FINANCIERA de un proyecto (OGs: certificado / pagado; OC: facturado)
// ----------------------------------------------------------------------------
// COPIA de la lógica de la app 4housing-compras (index.html), commit 33f8945
// (2026-11-18). Funciones de origen (mismos nombres): certsOf, pagosOf,
// armadasOf, pagoArmado, pagoMontoOG, certMonto, ogAcumMonto, ogLiberado,
// itemAcumPct, pagoPctEfectivo, ogPagadoPct, ogPagadoMonto, ogAnticipoMonto,
// ogMaxPagable, ogPendPagoMonto, ogArmadoMonto, ogEstado, ogPesosPagados,
// _pgBonifOG, _asiPctPago, _asiPctGasto, asientoRepartoRenglones,
// pgLiberadoRenglon, pgPagadoRenglon. Decisión 2026-11-23 (Pablo):
//   · OG compartida entre obras: EXACTO POR RENGLÓN (solo los renglones de esta
//     obra, con el mismo reparto de pagos de la app). OG entera de la obra: las
//     funciones de OG de la app, sin cambios.
//   · Moneda: cada OG en su moneda pactada + pesos al TC de la OG (mismo
//     criterio que el comprado de la foto económica). Pagado además en pesos
//     reales (cada pago a su propio TC), como ogPesosPagados.
//   · OC de Tango: facturado / pendiente de facturar del Informe OC importado
//     (los pagos de OC no están en la app).
// Si cambia la lógica en la app, hay que actualizar esto también.
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import { itemTotal, ogTotal, itemCerradoPct, ogCerradoMonto, ogMonedaCode, _obraNums, gpOGsDelProyecto } from './compras_gp.ts';

type Row = Record<string, any>;

export interface CtxFin {
  proyecto: Row;
  ogs: Row[];            // compras_ogs (todas; se filtran por N° de obra)
  certificados: Row[];   // compras_og_certificados
  pagos: Row[];          // compras_pagos (incluye OPs armadas)
  oc: Row[];             // compras_gp_oc del proyecto (Informe OC de Tango)
}

// ---- Índices (equivalente a _RIDX de la app) ----
function indices(ctx: CtxFin) {
  const c = new Map<string, Row[]>(), p = new Map<string, Row[]>(), a = new Map<string, Row[]>();
  const push = (m: Map<string, Row[]>, x: Row) => { const k = String(x.og_id); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); };
  (ctx.certificados || []).forEach(x => push(c, x));
  c.forEach(l => l.sort((x, y) => (+x.id) - (+y.id)));
  (ctx.pagos || []).forEach(x => push(pagoArmado(x) ? a : p, x));
  return {
    certsOf: (ogId: unknown) => (c.get(String(ogId)) || []).slice(),
    pagosOf: (ogId: unknown) => (p.get(String(ogId)) || []).slice(),
    armadasOf: (ogId: unknown) => (a.get(String(ogId)) || []).slice(),
  };
}
type Idx = ReturnType<typeof indices>;

export function pagoArmado(p: Row) { return !!p && p.estado_op === 'Armada'; }
export function pagoMontoOG(pago: Row) {
  if (pago.moneda_og === pago.moneda_pago) return +pago.importe_pago || 0;
  const tc = +pago.tc || 0; if (!tc) return +pago.importe_pago || 0;
  if (pago.moneda_og === 'USD' && pago.moneda_pago === 'ARS') return (+pago.importe_pago || 0) / tc;
  if (pago.moneda_og === 'ARS' && pago.moneda_pago === 'USD') return (+pago.importe_pago || 0) * tc;
  return +pago.importe_pago || 0;
}
export function _pgBonifOG(o: Row) { const b = 1 - (+o.bonif_pct || 0) / 100; return b > 0 ? b : 1; }

// ---- Nivel OG (idénticas a la app) ----
function certMonto(c: Row, og: Row) {
  if (og.items && og.items.length) { const av = c.avances || {}; return og.items.reduce((a: number, it: Row, idx: number) => a + itemTotal(it) * ((+av[idx] || 0) / 100), 0) * (1 - (+og.bonif_pct || 0) / 100); }
  return (+c.pct || 0) / 100 * ogTotal(og);
}
function ogAcumMonto(X: Idx, og: Row) { return X.certsOf(og.id).reduce((a, c) => a + certMonto(c, og), 0); }
function ogAcumPct(X: Idx, og: Row) { const t = ogTotal(og); return t ? ogAcumMonto(X, og) / t * 100 : 0; }
function ogCerradoPct(og: Row) { const t = ogTotal(og); return t ? ogCerradoMonto(og) / t * 100 : 0; }
function itemAcumPct(X: Idx, og: Row, idx: number) { return X.certsOf(og.id).reduce((a, c) => a + (+(((c.avances || {})[idx])) || 0), 0); }
function ogLiberado(X: Idx, og: Row) { return X.certsOf(og.id).filter(c => c.aprobacion === 'SI' && c.estado === 'Liberado').reduce((a, c) => a + certMonto(c, og), 0); }
function pagoPctEfectivo(pago: Row, og: Row) { const t = ogTotal(og); if (!t) return 0; const montoOG = pagoMontoOG(pago) - (+pago.ajuste_redondeo || 0); return montoOG / t * 100; }
function ogPagadoPct(X: Idx, og: Row) { return Math.min(100, X.pagosOf(og.id).reduce((a, p) => a + pagoPctEfectivo(p, og), 0)); }
function ogPagadoMonto(X: Idx, og: Row) { return ogPagadoPct(X, og) / 100 * ogTotal(og); }
function ogAnticipoMonto(og: Row) { if (og.condicion !== 'CON ANTICIPO') return 0; return ogTotal(og) * ((+og.anticipo_pct || 0) / 100); }
function ogMaxPagable(X: Idx, og: Row) {
  const cert = ogLiberado(X, og);
  if (og.condicion !== 'CON ANTICIPO') return cert;
  const ant = ogAnticipoMonto(og); const antPct = (+og.anticipo_pct || 0) / 100;
  if (og.anticipo_metodo === 'B') return Math.max(ant, cert);
  return ant + cert * (1 - antPct);
}
function ogPendPagoMonto(X: Idx, og: Row) { return Math.max(0, ogMaxPagable(X, og) - ogPagadoMonto(X, og)); }
function ogArmadoMonto(X: Idx, og: Row) { return X.armadasOf(og.id).reduce((a, p) => a + pagoMontoOG(p) - (+p.ajuste_redondeo || 0), 0); }
function ogEstado(X: Idx, og: Row) {
  if (og.anulada) return 'Anulada';
  const a = ogAcumPct(X, og), c = ogCerradoPct(og);
  if (a + c >= 99.999) return c > 0.001 ? 'Cerrada c/saldo' : 'Certificada';
  return (a > 0 || c > 0) ? 'En certificación' : 'Abierta';
}
function pesosDePago(p: Row) { const imp = +p.importe_pago || 0; return p.moneda_pago === 'USD' ? imp * (+p.tc || 0) : imp; }
function ogPesosPagados(X: Idx, o: Row) { return X.pagosOf(o.id).reduce((a, p) => a + pesosDePago(p), 0); }

// ---- Nivel renglón (idénticas a la app) ----
function _asiPctPago(o: Row, pago: Row) {
  if (!pago) return 100;
  const t = ogTotal(o);
  if (t > 0 && pago.importe_pago != null && pago.importe_pago !== '') return pagoMontoOG(pago) / t * 100;
  return (pago.pct != null && pago.pct !== '' ? +pago.pct : 100);
}
function _asiPctGasto(o: Row, pago: Row) {
  const pct = _asiPctPago(o, pago);
  const aj = pago ? (+pago.ajuste_redondeo || 0) : 0;
  return aj ? pct - (aj / ogTotal(o) * 100) : pct;
}
function asientoRepartoRenglones(X: Idx, o: Row, pago: Row): number[] | null {
  if (!pago || !(o.items && o.items.length)) return null;
  if (pago.reparto && typeof pago.reparto === 'object') {
    const suma = Object.keys(pago.reparto).reduce((a, k) => a + (+pago.reparto[k] || 0), 0);
    if (suma > 0) { const k = (suma - (+pago.ajuste_redondeo || 0)) / suma, f = _pgBonifOG(o); return o.items.map((_it: Row, i: number) => (+pago.reparto[i] || 0) * k / f); }
  }
  const ord = (_a: Row, _b: Row, fa: unknown, fb: unknown) => String(fa || '').localeCompare(String(fb || ''));
  const pagos = X.pagosOf(o.id).slice().sort((a, b) => ord(a, b, a.fecha, b.fecha) || ((+a.op_numero || 0) - (+b.op_numero || 0)) || ((+a.id || 0) - (+b.id || 0)));
  if (!pagos.some(p => String(p.id) === String(pago.id))) return null;
  const tot: number[] = o.items.map((it: Row) => itemTotal(it));
  const tramos = X.certsOf(o.id).filter(c => c.aprobacion === 'SI' && c.estado === 'Liberado')
    .sort((a, b) => ord(a, b, a.fecha, b.fecha) || String(a.numero || '').localeCompare(String(b.numero || ''), 'es', { numeric: true }) || ((+a.id || 0) - (+b.id || 0)))
    .map(c => tot.map((t, i) => t * (+((c.avances || {})[i]) || 0) / 100));
  const sinAsig = tot.slice();
  let k = 0;
  for (const p of pagos) {
    let A = tot.reduce((a, t) => a + t, 0) * _asiPctGasto(o, p) / 100;
    const x = tot.map(() => 0);
    while (A > 1e-9 && k < tramos.length) {
      const tr = tramos[k];
      const disp = tr.map((v, i) => Math.max(0, Math.min(v, sinAsig[i] - x[i])));
      const sumD = disp.reduce((a, v) => a + v, 0);
      if (sumD <= 1e-9) { k++; continue; }
      const t = Math.min(A, sumD);
      disp.forEach((v, i) => { const q = t * v / sumD; x[i] += q; tr[i] -= q; });
      A -= t;
      if (t >= sumD - 1e-9) k++;
    }
    if (A > 1e-9) {
      const U = sinAsig.map((u, i) => Math.max(0, u - x[i])); const sumU = U.reduce((a, u) => a + u, 0);
      const base = sumU > 0 ? U : tot; const sumB = base.reduce((a, b) => a + b, 0) || 1;
      base.forEach((b, i) => { x[i] += A * b / sumB; });
    }
    x.forEach((v, i) => { sinAsig[i] = Math.max(0, sinAsig[i] - v); });
    if (String(p.id) === String(pago.id)) return x;
  }
  return null;
}
function pgLiberadoRenglon(X: Idx, o: Row) {
  const f = _pgBonifOG(o), certs = X.certsOf(o.id).filter(c => c.aprobacion === 'SI' && c.estado === 'Liberado');
  return (o.items || []).map((it: Row, i: number) => itemTotal(it) * certs.reduce((a, c) => a + (+((c.avances || {})[i]) || 0), 0) / 100 * f);
}
// Igual que pgPagadoRenglon(o, true) de la app, pero devuelve también el vector de CADA pago
// (para repartir los pesos reales de cada pago entre los renglones).
function pagosPorRenglon(X: Idx, o: Row): { total: number[]; porPago: { pago: Row; v: number[] }[] } {
  const f = _pgBonifOG(o), x: number[] = (o.items || []).map(() => 0); const porPago: { pago: Row; v: number[] }[] = [];
  X.pagosOf(o.id).forEach(p => {
    const r = asientoRepartoRenglones(X, o, p); if (!r) return;
    const v = r.map(z => (+z || 0) * f), real = pagoMontoOG(p) - (+p.ajuste_redondeo || 0);
    let sobra = p.reparto ? 0 : v.reduce((a, z) => a + z, 0) - real;
    for (let i = v.length - 1; i >= 0 && sobra > 0.005; i--) { const q = Math.min(v[i], sobra); v[i] -= q; sobra -= q; }
    v.forEach((z, i) => { x[i] += z; });
    porPago.push({ pago: p, v });
  });
  return { total: x, porPago };
}
export function pgPagadoRenglon(X: Idx, o: Row, sinArmadas: boolean) {
  const x = pagosPorRenglon(X, o).total;
  if (!sinArmadas) X.armadasOf(o.id).forEach(p => { if (p.reparto && typeof p.reparto === 'object') Object.keys(p.reparto).forEach(k => { const i = +k; if (x[i] != null) x[i] += (+p.reparto[k] || 0); }); });
  return x;
}

// ---- Qué renglones son de la obra (mismo criterio que gpOGPartes) ----
function obraKeys(p: Row) { return new Set(_obraNums(p.codigo).concat(_obraNums(p.nombre))); }
export function renglonesDeLaObra(o: Row, p: Row): boolean[] | null {
  if (!(o.items && o.items.length)) return null;   // OG sin renglones: entera
  const keys = obraKeys(p);
  const cab = _obraNums(o.clasif_og).some(n => keys.has(n));
  return o.items.map((it: Row) => { const ns = _obraNums(it.centro_costos); return ns.length ? ns.some(n => keys.has(n)) : (String(it.centro_costos || '').trim() ? false : cab); });
}

// ---- Foto financiera de UNA OG para esta obra (en moneda de la OG) ----
export function finOG(X: Idx, o: Row, p: Row) {
  const mio = renglonesDeLaObra(o, p);
  const entera = !mio || mio.every(Boolean);
  if (entera) {
    const total = ogTotal(o), cerrado = ogCerradoMonto(o), cert = ogAcumMonto(X, o);
    return { compartida: false, total, cerrado, certificado: cert, liberado: ogLiberado(X, o),
      pendiente_certificar: Math.max(0, total - cert - cerrado), pagado: ogPagadoMonto(X, o),
      pendiente_pago: ogPendPagoMonto(X, o), op_armadas: ogArmadoMonto(X, o), pesos_pagados: ogPesosPagados(X, o) };
  }
  const f = _pgBonifOG(o), lib = pgLiberadoRenglon(X, o);
  const pp = pagosPorRenglon(X, o), pag = pp.total, pagConArm = pgPagadoRenglon(X, o, false);
  const ant = o.condicion === 'CON ANTICIPO', ap = (+o.anticipo_pct || 0) / 100;
  let total = 0, cerrado = 0, cert = 0, liberado = 0, pendCert = 0, pagado = 0, pendPago = 0, armadas = 0;
  o.items.forEach((it: Row, i: number) => {
    if (!mio![i]) return;
    const t = itemTotal(it) * f, ce = t * itemAcumPct(X, o, i) / 100, cr = t * itemCerradoPct(it) / 100;
    total += t; cerrado += cr; cert += ce; liberado += lib[i]; pendCert += Math.max(0, t - ce - cr);
    pagado += pag[i]; armadas += Math.max(0, pagConArm[i] - pag[i]);
    // Máximo pagable del renglón: mismo criterio A/B que pgTopeRenglon / ogMaxPagable.
    let max = lib[i];
    if (ant) max = o.anticipo_metodo === 'B' ? Math.max(t * ap, lib[i]) : t * ap + lib[i] * (1 - ap);
    pendPago += Math.max(0, Math.min(t, max) - pag[i]);
  });
  // Pesos reales: cada pago a su propio TC, en la proporción de ese pago que cae en los renglones de la obra.
  let pesos = 0;
  pp.porPago.forEach(({ pago, v }) => {
    const sum = v.reduce((a, z) => a + z, 0); if (!(sum > 0)) return;
    const mine = v.reduce((a, z, i) => a + (mio![i] ? z : 0), 0);
    pesos += pesosDePago(pago) * mine / sum;
  });
  return { compartida: true, total, cerrado, certificado: cert, liberado, pendiente_certificar: pendCert,
    pagado, pendiente_pago: pendPago, op_armadas: armadas, pesos_pagados: pesos };
}

// ---- OC de Tango: facturado / pendiente de facturar ----
export function finOC(o: Row) {
  const tot = +o.total_ars || 0, est = String(o.estado_oc || '').toUpperCase();
  if (est.indexOf('ANUL') >= 0) return { facturado: 0, pendiente: 0, sin_dato: 0, anulada: true };
  if (est.indexOf('AUTORIZ') >= 0) return { facturado: 0, pendiente: tot, sin_dato: 0, anulada: false };
  const ped = +o.cantidad_pedida || 0;
  if (o.cantidad_pend_facturar == null || !(ped > 0)) return { facturado: 0, pendiente: 0, sin_dato: tot, anulada: false };
  const unit = tot / ped;
  const facturado = Math.min(tot, unit * (+o.cantidad_facturada || 0));
  const pendiente = Math.min(tot - facturado, unit * (+o.cantidad_pend_facturar || 0));
  return { facturado, pendiente: Math.max(0, pendiente), sin_dato: 0, anulada: false };
}

// ---- Resumen para el conector ----
const r0 = (v: number) => Math.round(v || 0);
const r2 = (v: number) => Math.round((v || 0) * 100) / 100;

export function financieroProyecto(ctx: CtxFin) {
  const p = ctx.proyecto; const X = indices(ctx);
  const tcPres = +p.tc_presupuesto || 0;
  const ogs = gpOGsDelProyecto(p, ctx.ogs);   // sin anuladas, sin duplicados (mismo criterio que el comprado)
  const T = { total: 0, cerrado: 0, certificado: 0, liberado: 0, pendiente_certificar: 0, pagado: 0, pendiente_pago: 0, op_armadas: 0, pesos_pagados: 0 };
  const lista = ogs.map(o => {
    const v = finOG(X, o, p);
    const usd = ogMonedaCode(o) === 'USD';
    const tc = usd ? ((o.tc_pesos != null && o.tc_pesos !== '') ? +o.tc_pesos : tcPres) : 1;   // mismo criterio que gpOGArs
    const ars = (x: number) => x * (tc || 0);
    (['total', 'cerrado', 'certificado', 'liberado', 'pendiente_certificar', 'pagado', 'pendiente_pago', 'op_armadas'] as const)
      .forEach(k => { (T as any)[k] += ars((v as any)[k]); });
    T.pesos_pagados += v.pesos_pagados;
    return {
      og: o.numero ?? o.id, fecha: o.fecha ?? null, proveedor: o.proveedor || o.proveedor_cod || null,
      estado: ogEstado(X, o), condicion: o.condicion ?? null, moneda: usd ? 'USD' : 'ARS',
      tc_usado: usd ? (tc || null) : null, compartida_con_otras_obras: v.compartida,
      total: r2(v.total), cerrado_sin_costo: r2(v.cerrado), certificado: r2(v.certificado),
      liberado: r2(v.liberado), certificado_sin_liberar: r2(Math.max(0, v.certificado - v.liberado)),
      pendiente_de_certificar: r2(v.pendiente_certificar), pagado: r2(v.pagado),
      pendiente_de_pago: r2(v.pendiente_pago), op_armadas_sin_pagar: r2(v.op_armadas),
      pagado_en_pesos_reales: r0(v.pesos_pagados),
    };
  });
  let fact = 0, pend = 0, sinDato = 0, nSin = 0, nAnul = 0;
  (ctx.oc || []).forEach(o => { const f = finOC(o); fact += f.facturado; pend += f.pendiente; sinDato += f.sin_dato; if (f.sin_dato) nSin++; if (f.anulada) nAnul++; });
  return {
    proyecto: { id: p.id, codigo: p.codigo ?? null, nombre: p.nombre ?? null },
    criterio: 'Foto FINANCIERA, separada de la económica (compras_resumen_proyecto). ' +
      'OGs de la app: certificado, liberado, pagado y pendientes, con la misma lógica de la app de Compras; ' +
      'en OGs compartidas con otras obras cuentan solo los renglones de esta obra. Cada OG en su moneda pactada; ' +
      'totales en pesos al TC de la OG (mismo criterio que el comprado). "Pagado en pesos reales" = cada pago a su propio TC. ' +
      'Pendiente de pago = lo pagable según lo liberado (y el anticipo pactado) menos lo pagado; las OP armadas todavía no cuentan como pagadas. ' +
      'OC de Tango: facturado / pendiente de facturar según el último Informe OC importado (sus pagos no están en la app).',
    ogs_totales_ars: {
      cantidad: lista.length,
      total: r0(T.total), cerrado_sin_costo: r0(T.cerrado), certificado: r0(T.certificado), liberado: r0(T.liberado),
      certificado_sin_liberar: r0(Math.max(0, T.certificado - T.liberado)), pendiente_de_certificar: r0(T.pendiente_certificar),
      pagado: r0(T.pagado), pendiente_de_pago: r0(T.pendiente_pago), op_armadas_sin_pagar: r0(T.op_armadas),
      pagado_en_pesos_reales: r0(T.pesos_pagados),
    },
    oc_tango_ars: {
      renglones: (ctx.oc || []).length, facturado: r0(fact), pendiente_de_facturar: r0(pend),
      sin_dato_de_facturacion: r0(sinDato), renglones_sin_dato: nSin, renglones_anulados: nAnul,
    },
    ogs: lista,
  };
}

// Solo para pruebas: índice armado a partir del contexto.
export const _test = { indices, finOG, pgPagadoRenglon, pgLiberadoRenglon, ogAcumMonto, ogLiberado, ogPagadoMonto, ogPendPagoMonto, ogArmadoMonto, ogPesosPagados, ogEstado };
