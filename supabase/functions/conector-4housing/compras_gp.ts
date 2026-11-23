// ============================================================================
// Compras · Gestión de Proyectos — cálculo "comprado vs presupuesto"
// ----------------------------------------------------------------------------
// COPIA de la lógica de la app 4housing-compras (index.html, bloque
// "GESTIÓN DE PROYECTOS"), tomada del commit 33f8945 (2026-11-18).
// Decisión 2026-11-23: se copia casi textual para que el conector dé los mismos
// números que el tablero de la app. Si cambia la fórmula en la app, hay que
// actualizar esto también. Funciones de origen (mismos nombres):
//   gpTotEf, gpFirma, gpNorm, gpSinPrefijo, gpEsNA, gpPrefijoArt, gpTcDia,
//   gpImputar, gpEstadoSeccion, gpAgregado, gpTrasNetoCompras,
//   _obraNums, _ogObraNums, gpOGsDelProyecto, gpOGImputar, gpOGPartes, gpOGArs,
//   itemTotal, itemCerradoPct, ogTotal, ogCerradoMonto, ogMonedaCode, COSTEO_NEW_OPC.
// Diferencia buscada: en vez del estado global GP / mem / DIC, todo entra por `ctx`.
// Diferencia buscada: la app lee compras_ogs sin paginar (tope de 1000 filas de
// PostgREST); acá se leen todas. Si el proyecto tiene OGs viejas, puede diferir.
// ============================================================================

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export interface CtxGP {
  proyecto: Row;
  presupuesto: Row[];
  oc: Row[];
  mapeo: Row[];
  reparto: Row[];
  ogSeccion: Record<string, string>;
  ogs: Row[];            // compras_ogs (todas; se filtran por N° de obra acá)
  usdOficial: Row[];     // compras_usd_diario_oficial {fecha, venta}
  traslados: Row[];      // compras_gp_traslados_mo del código del proyecto
}

export const COSTEO_NEW_OPC = ["Estructura Modular", "Acero / Hierro", "Aislacion / Revestimiento", "Piso", "Aberturas", "Instalacion Electrica", "Pintura", "Sanitario", "Cocina", "MOD", "Prorrateables", "Equipamiento", "Mobiliario", "Obra Civil", "Logistica & Montaje", "Climatizacion", "Consumibles", "Logistica Interna", "Otros"];

// ---- OG: renglones, total, cierres, moneda ----
export function itemTotal(it: Row) { const bruto = (+it.cant || 0) * (+it.precio_unit || 0); return bruto * (1 - (+it.bonif_pct || 0) / 100); }
export function ogTotal(og: Row) { const sub = (og.items && og.items.length) ? og.items.reduce((a: number, it: Row) => a + itemTotal(it), 0) : (+og.monto_total || 0); return sub * (1 - (+og.bonif_pct || 0) / 100); }
export function itemCerradoPct(it: Row) { return (it && it.cierres || []).reduce((a: number, c: Row) => a + (+c.pct || 0), 0); }
export function ogCerradoMonto(og: Row) {
  if (og.items && og.items.length) return og.items.reduce((a: number, it: Row) => a + itemTotal(it) * (itemCerradoPct(it) / 100), 0) * (1 - (+og.bonif_pct || 0) / 100);
  return (og.cierres || []).reduce((a: number, c: Row) => a + (+c.monto || 0), 0);
}
export function ogMonedaCode(og: Row) { return og.moneda === 'Extranjera' ? 'USD' : 'ARS'; }

// ---- Renglón de OC (Informe OC de Tango) ----
// Total que cuenta como COMPRADO: anulada = 0; autorizada = Total; resto = precio unit. ×
// (pend. de facturar + facturada), con tope en el Total (descuenta saldos cerrados).
export function gpTotEf(o: Row) {
  const tot = +o.total_ars || 0, est = String(o.estado_oc || '').toUpperCase();
  if (est.indexOf('ANUL') >= 0) return 0;
  if (est.indexOf('AUTORIZ') >= 0) return tot;
  const ped = +o.cantidad_pedida || 0;
  if (o.cantidad_pend_facturar == null || !(ped > 0)) return tot;
  return Math.min(tot, tot / ped * ((+o.cantidad_pend_facturar || 0) + (+o.cantidad_facturada || 0)));
}
export function gpFirma(o: Row) { return String(o.oc_numero || '') + '§' + String(o.cod_articulo || o.descripcion || ''); }

export function gpNorm(s: unknown) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(); }
export function gpSinPrefijo(s: unknown) { return String(s == null ? '' : s).replace(/^\s*[A-Z]?\d*\s*-\s*/i, '').replace(/^\s*(GC|GTO)\s+/i, '').trim(); }
export function gpEsNA(v: unknown) { const k = gpNorm(v); return !k || k === '#NA' || k === '#N/A' || k === 'NA' || k === 'N/A' || k === '#VALUE!' || k === '#REF!' || k === '-'; }
export function gpPrefijoArt(cod: unknown) { const m = String(cod || '').toUpperCase().match(/^([A-Z]{2,6})/); return m ? m[1] : ''; }

// TC oficial (venta) del día: el dato igual o anterior más cercano; sin dato, el TC del presupuesto.
export function crearTcDia(usdOficial: Row[]) {
  const l = usdOficial.filter(r => r.venta != null && +r.venta > 0).slice()
    .sort((a, b) => String(a.fecha) < String(b.fecha) ? -1 : String(a.fecha) > String(b.fecha) ? 1 : 0);
  return function gpTcDia(fecha: unknown, tcPres: number): { tc: number | null; fuente: string } {
    const f = String(fecha || '').slice(0, 10); let lo = 0, hi = l.length - 1, k = -1;
    if (f) { while (lo <= hi) { const m = (lo + hi) >> 1; if (String(l[m].fecha).slice(0, 10) <= f) { k = m; lo = m + 1; } else hi = m - 1; } }
    if (k >= 0) { const d = String(l[k].fecha).slice(0, 10); return { tc: +l[k].venta, fuente: 'Oficial venta ' + (d === f ? 'del día' : ('del ' + d + ' (último con dato)')) }; }
    return tcPres > 0 ? { tc: tcPres, fuente: 'TC presupuesto (sin cotización oficial)' } : { tc: null, fuente: 'SIN TC' };
  };
}

export function gpEstadoSeccion(comprado: number, presup: number, tol: number) {
  if (!(comprado > 0)) return 'Sin iniciar';
  if (!(presup > 0)) return 'Sin presupuesto';
  if (comprado > presup * (1 + (tol || 0))) return 'Sobrecosto';
  return 'En presupuesto';
}

// ---- Imputación a sección del presupuesto ----
function gpImputar(o: Row, mapIdx: Record<string, string>, presupuesto: Row[]) {
  const cands: { tipo: string; clave: any }[] = [{ tipo: 'subrubro', clave: o.subrubro }, { tipo: 'rubro', clave: o.rubro },
  { tipo: 'costeo', clave: o.costeo_tag }, { tipo: 'grupo', clave: o.grupo },
  { tipo: 'prefijo', clave: gpPrefijoArt(o.cod_articulo) }];
  const esCosteoNew = COSTEO_NEW_OPC.includes(o.costeo_tag);
  if (esCosteoNew) cands.unshift(cands.splice(2, 1)[0]);
  for (const c of cands) { if (gpEsNA(c.clave)) continue; const k = gpNorm(c.clave); const hit = mapIdx[c.tipo + '|' + k]; if (hit) return { seccion: hit, imputado_por: c.tipo }; }
  const secs = (presupuesto || []).filter(s => s.ambito !== 'desglosada').map(s => ({ seccion: s.seccion, n: gpNorm(s.seccion) }));
  for (const c of cands) {
    if (c.tipo === 'prefijo' || gpEsNA(c.clave)) continue;
    const cand = gpNorm(gpSinPrefijo(c.clave));
    const exacto = c.tipo === 'costeo' && esCosteoNew;
    if (cand.length < 4 && !exacto) continue;
    for (const s of secs) {
      if (!s.n) continue;
      if (s.n === cand || (cand.indexOf(s.n) >= 0 && s.n.length >= 5) || (s.n.indexOf(cand) >= 0 && cand.length >= 5)) {
        return { seccion: s.seccion, imputado_por: c.tipo };
      }
    }
  }
  return { seccion: 'Sin clasificar', imputado_por: 'sin_clasificar' };
}

// ---- OGs del proyecto (match por N° de obra) ----
export function _obraNums(s: unknown): string[] { const m = String(s || '').match(/\d{3,}/g); return m ? [...m] : []; }
function _ogObraNums(o: Row) {
  let nums = _obraNums(o.clasif_og);
  (o.items || []).forEach((it: Row) => { nums = nums.concat(_obraNums(it.centro_costos)); });
  return nums;
}
function obraKeys(p: Row) { return new Set(_obraNums(p.codigo).concat(_obraNums(p.nombre))); }

export function gpOGsDelProyecto(p: Row, ogs: Row[], conAnuladas = false) {
  if (!p) return [];
  const keys = obraKeys(p);
  if (!keys.size) return [];
  const match = (ogs || []).filter(o => (conAnuladas || !o.anulada) && _ogObraNums(o).some(n => keys.has(n)));
  // Blindaje contra doble conteo: mismo N° de OG → se queda la de id más alto.
  const byNum: Record<string, Row> = {};
  match.forEach(o => { const k = (o.numero != null && o.numero !== '') ? ('n' + o.numero) : ('id' + o.id); const prev = byNum[k]; if (!prev || (+o.id || 0) > (+prev.id || 0)) byNum[k] = o; });
  return Object.values(byNum);
}
function gpOGImputar(o: Row, mapIdx: Record<string, string>, presupuesto: Row[]) {
  return gpImputar({ subrubro: '', rubro: o.costeo_new || '', costeo_tag: o.costeo || o.costeo_new || '', grupo: '',
    cod_articulo: ((o.items && o.items[0] && o.items[0].cod_art) || '') }, mapIdx, presupuesto);
}
// Solo cuentan los renglones de ESTA obra; renglón sin clasificación → manda la cabecera.
function gpOGPartes(o: Row, p: Row) {
  const keys = obraKeys(p);
  const cab = _obraNums(o.clasif_og).some(n => keys.has(n));
  let bruto = 0, cerr = 0;
  if (o.items && o.items.length) {
    o.items.forEach((it: Row) => {
      const ns = _obraNums(it.centro_costos);
      const mio = ns.length ? ns.some(n => keys.has(n)) : (String(it.centro_costos || '').trim() ? false : cab);
      if (!mio) return;
      const t = itemTotal(it); bruto += t; cerr += t * (itemCerradoPct(it) / 100);
    });
    const f = (1 - (+o.bonif_pct || 0) / 100); bruto *= f; cerr *= f;
  } else { bruto = ogTotal(o); cerr = ogCerradoMonto(o); }
  return { bruto, cerr };
}
// Total de la OG en ARS, neto de lo cerrado sin costo (bruto=true: sin descontar).
function gpOGArs(o: Row, p: Row, bruto = false) {
  const pp = gpOGPartes(o, p);
  const t = bruto ? pp.bruto : Math.max(pp.bruto - pp.cerr, 0);
  if (ogMonedaCode(o) === 'USD') { const tc = (o.tc_pesos != null && o.tc_pesos !== '') ? +o.tc_pesos : (+(p.tc_presupuesto) || 0); return t * (tc || 0); }
  return t;
}

// Neto trasladado HACIA Compras (solo aplicados).
export function gpTrasNetoCompras(traslados: Row[]) {
  return (traslados || []).filter(t => t.estado === 'aplicado').reduce((a, t) => a + (t.direccion === 'mod_a_compras' ? (+t.monto_ars || 0) : (t.direccion === 'compras_a_mod' ? -(+t.monto_ars || 0) : 0)), 0);
}

// ---- Agregado del tablero (gpAgregado) ----
export function gpAgregado(ctx: CtxGP) {
  const p = ctx.proyecto || {}; const tc = +p.tc_presupuesto || 0; const tol = +p.tolerancia_desvio_pct || 0;
  const gpTcDia = crearTcDia(ctx.usdOficial || []);
  const rep: Record<string, { seccion: string; monto: number }[]> = {};
  (ctx.reparto || []).forEach(r => { (rep[r.firma] = rep[r.firma] || []).push({ seccion: r.seccion, monto: +r.monto || 0 }); });
  const firmaTot: Record<string, number> = {}, firmaUsd: Record<string, number> = {};
  (ctx.oc || []).forEach(o => { const f = gpFirma(o); const a = gpTotEf(o); firmaTot[f] = (firmaTot[f] || 0) + a; const t = gpTcDia(o.fecha, tc).tc; firmaUsd[f] = (firmaUsd[f] || 0) + (t && t > 0 ? a / t : 0); });
  const compUsBySec: Record<string, number> = {};
  const conRep = new Set(Object.keys(rep).filter(f => firmaTot[f] != null));
  const compBySec: Record<string, number> = {}; let sinClasArs = 0, sinClasN = 0, pendRepArs = 0, repOver = 0;
  // 1) renglones SIN reparto
  (ctx.oc || []).forEach(o => {
    if (conRep.has(gpFirma(o))) return;
    const a = gpTotEf(o);
    if (o.seccion === 'Sin clasificar' || !o.seccion) { sinClasArs += a; sinClasN++; return; }
    compBySec[o.seccion] = (compBySec[o.seccion] || 0) + a;
    const tOc = gpTcDia(o.fecha, tc).tc; if (tOc && tOc > 0) compUsBySec[o.seccion] = (compUsBySec[o.seccion] || 0) + a / tOc;
  });
  // 2) renglones CON reparto
  conRep.forEach(f => {
    const total = firmaTot[f] || 0, allocs = rep[f] || [];
    const sum = allocs.reduce((x, al) => x + (+al.monto || 0), 0);
    let factor = 1; if (sum > total && sum > 0) { factor = total / sum; repOver++; }
    allocs.forEach(al => { const m = (+al.monto || 0) * factor; if (m) { compBySec[al.seccion] = (compBySec[al.seccion] || 0) + m; if (total > 0) compUsBySec[al.seccion] = (compUsBySec[al.seccion] || 0) + m * (firmaUsd[f] || 0) / total; } });
    const rem = total - Math.min(sum, total);
    if (rem > 1) { pendRepArs += rem; }
  });
  const ocBySec: Record<string, number> = Object.assign({}, compBySec), ogBySec: Record<string, number> = {};
  // 3) OGs de la app: canal complementario al de Tango. Suman en el comprado.
  const _ogMap: Record<string, string> = {}; (ctx.mapeo || []).forEach(m => { _ogMap[m.tipo + '|' + gpNorm(m.clave)] = m.seccion; });
  const _secComp = new Set((ctx.presupuesto || []).filter(s => s.ambito !== 'desglosada').map(s => s.seccion));
  const _secAmb: Record<string, string> = {}; (ctx.presupuesto || []).forEach(s => { if (s.ambito !== 'desglosada') _secAmb[s.seccion] = s.ambito || 'compras'; });
  const _ogOvr = ctx.ogSeccion || {};
  let ogComp = 0, ogSinClasArs = 0, ogSinClasN = 0;
  const ogsProy = gpOGsDelProyecto(p, ctx.ogs);
  ogsProy.forEach(o => {
    if (o.anulada) return;
    const ars = gpOGArs(o, p); if (!ars) return;
    const ovr = _ogOvr[o.id];
    const sec = (ovr && _secComp.has(ovr)) ? ovr : gpOGImputar(o, _ogMap, ctx.presupuesto).seccion;
    if (sec && sec !== 'Sin clasificar' && _secComp.has(sec)) {
      compBySec[sec] = (compBySec[sec] || 0) + ars; ogBySec[sec] = (ogBySec[sec] || 0) + ars; if (_secAmb[sec] === 'compras') ogComp += ars;
      const own = (o.tc_pesos != null && o.tc_pesos !== '' && +o.tc_pesos > 0) ? +o.tc_pesos : null, tOg = own || (ogMonedaCode(o) === 'USD' ? tc : gpTcDia(o.fecha, tc).tc);
      if (tOg && tOg > 0) compUsBySec[sec] = (compUsBySec[sec] || 0) + ars / tOg;
    } else { ogSinClasArs += ars; ogSinClasN++; }
  });
  const filas = (ctx.presupuesto || []).map(s => {
    const comp = compBySec[s.seccion] || 0;
    const presAr = +s.presupuesto_ars || 0, presUs = +s.presupuesto_usd || 0;
    const compUs = compUsBySec[s.seccion] || 0;
    const pend = Math.max(presAr - comp, 0);
    const desv = comp - presAr;
    const avance = presAr > 0 ? comp / presAr : (comp > 0 ? 1 : 0);
    return { id: s.id, origen: s.origen || 'costeo', ambito: s.ambito || 'compras', desglose_de: s.desglose_de || null, seccion: s.seccion, presAr, presUs, comp, compUs, pend, desv, avance, cerrada: !!s.cerrada, estado: gpEstadoSeccion(comp, presAr, tol), compOC: ocBySec[s.seccion] || 0, compOG: ogBySec[s.seccion] || 0 };
  });
  let extracosto = 0, ahorroConf = 0, ahorroPot = 0, extracostoN = 0, ahorroConfN = 0, ahorroPotN = 0;
  filas.filter(f => f.ambito === 'compras').forEach(f => {
    if (f.comp > f.presAr) { extracosto += (f.comp - f.presAr); extracostoN++; }
    else { const dif = f.presAr - f.comp; if (dif > 0) { if (f.cerrada) { ahorroConf += dif; ahorroConfN++; } else { ahorroPot += dif; ahorroPotN++; } } }
  });
  const tot = filas.filter(f => f.ambito === 'compras').reduce((a, f) => ({ presAr: a.presAr + f.presAr, presUs: a.presUs + f.presUs, comp: a.comp + f.comp, compUs: a.compUs + f.compUs, pend: a.pend + f.pend, desv: a.desv + f.desv }), { presAr: 0, presUs: 0, comp: 0, compUs: 0, pend: 0, desv: 0 });
  const totFuera = filas.filter(f => f.ambito === 'mod' || f.ambito === 'externo').reduce((a, f) => ({ mod: a.mod + (f.ambito === 'mod' ? f.presAr : 0), ext: a.ext + (f.ambito === 'externo' ? f.presAr : 0), compMod: a.compMod + (f.ambito === 'mod' ? f.comp : 0), compExt: a.compExt + (f.ambito === 'externo' ? f.comp : 0) }), { mod: 0, ext: 0, compMod: 0, compExt: 0 });
  // Orden: cada sub-rubro justo debajo de su sección madre.
  const _kids: Record<string, typeof filas> = {}; filas.forEach(f => { if (f.desglose_de) { const k = gpNorm(f.desglose_de); (_kids[k] = _kids[k] || []).push(f); } });
  const filasOrd: typeof filas = [];
  filas.forEach(f => { if (f.desglose_de) return; filasOrd.push(f); const ks = _kids[gpNorm(f.seccion)]; if (ks) { ks.forEach(x => filasOrd.push(x)); delete _kids[gpNorm(f.seccion)]; } });
  Object.keys(_kids).forEach(k => _kids[k].forEach(x => filasOrd.push(x)));
  return { filas: filasOrd, ocBySec, ogBySec, tot, totFuera, sinClasArs, sinClasN, pendRepArs, repOver, tc, tol, ogComp, ogSinClasArs, ogSinClasN, extracosto, ahorroConf, ahorroPot, extracostoN, ahorroConfN, ahorroPotN, ogsDelProyecto: ogsProy.length };
}

// ---- Resumen para el conector: los mismos KPIs del tablero de la app ----
const r0 = (v: number) => Math.round(v || 0);
const pct = (v: number) => (v == null || isNaN(v)) ? null : Math.round(v * 1000) / 10;

export function resumenProyecto(ctx: CtxGP) {
  const ag = gpAgregado(ctx);
  const trasNeto = gpTrasNetoCompras(ctx.traslados);
  const ocComp = Math.max((ag.tot.comp || 0) - (ag.ogComp || 0), 0);
  return {
    proyecto: { id: ctx.proyecto.id, codigo: ctx.proyecto.codigo ?? null, nombre: ctx.proyecto.nombre ?? null,
      tc_presupuesto: ag.tc || null, tolerancia_desvio_pct: ag.tol || 0 },
    criterio: 'Foto ECONÓMICA (comprado vs presupuesto), igual que el tablero de Gestión de Proyectos de la app de Compras. ' +
      'Comprado = OC de Tango (Informe OC importado) + OGs de la app: son canales complementarios y ambos cuentan. ' +
      'Totales solo del ámbito Compras (MOD y externo van aparte). Importes en ARS; USD al TC oficial venta del día de cada OC/OG. ' +
      'No incluye la foto financiera (certificaciones, pagos, pendiente de certificar).',
    totales_ambito_compras: {
      presupuesto_ars: r0(ag.tot.presAr), presupuesto_usd: r0(ag.tot.presUs),
      comprado_ars: r0(ag.tot.comp), comprado_usd: r0(ag.tot.compUs),
      comprado_via_oc_tango_ars: r0(ocComp), comprado_via_ogs_app_ars: r0(ag.ogComp),
      avance_compra_pct: pct(ag.tot.presAr > 0 ? ag.tot.comp / ag.tot.presAr : 0),
      pendiente_de_comprar_ars: r0(ag.tot.pend),
      saldo_ars: r0(ag.tot.desv),
      extracosto_ars: r0(ag.extracosto), extracosto_rubros: ag.extracostoN,
      ahorro_confirmado_ars: r0(ag.ahorroConf), ahorro_confirmado_rubros: ag.ahorroConfN,
      ahorro_potencial_ars: r0(ag.ahorroPot), ahorro_potencial_rubros: ag.ahorroPotN,
      traslados_neto_hacia_compras_ars: r0(trasNeto),
      presupuesto_vigente_con_traslados_ars: r0(ag.tot.presAr + trasNeto),
    },
    fuera_de_compras: { presupuesto_mod_ars: r0(ag.totFuera.mod), comprado_mod_ars: r0(ag.totFuera.compMod),
      presupuesto_externo_ars: r0(ag.totFuera.ext), comprado_externo_ars: r0(ag.totFuera.compExt) },
    alertas: {
      oc_sin_clasificar_ars: r0(ag.sinClasArs), oc_sin_clasificar_renglones: ag.sinClasN,
      og_sin_clasificar_ars: r0(ag.ogSinClasArs), og_sin_clasificar_cantidad: ag.ogSinClasN,
      pendiente_de_repartir_ars: r0(ag.pendRepArs), repartos_que_exceden_el_total: ag.repOver,
    },
    rubros: ag.filas.map(f => ({
      seccion: f.seccion, ambito: f.ambito, sub_rubro_de: f.desglose_de, origen: f.origen,
      presupuesto_ars: r0(f.presAr), presupuesto_usd: r0(f.presUs),
      comprado_ars: r0(f.comp), comprado_oc_ars: r0(f.compOC), comprado_og_ars: r0(f.compOG), comprado_usd: r0(f.compUs),
      pendiente_ars: r0(f.pend), desvio_ars: r0(f.desv), avance_pct: pct(f.avance),
      estado: f.estado, compra_cerrada: f.cerrada,
    })),
    fuentes: { renglones_oc_tango: (ctx.oc || []).length, ogs_del_proyecto: ag.ogsDelProyecto, ogs_leidas_total: (ctx.ogs || []).length },
  };
}
