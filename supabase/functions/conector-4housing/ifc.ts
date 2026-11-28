// ============================================================================
// Conector 4housing Apps · Modelos IFC de Diseño (ifc-procesador)
// ----------------------------------------------------------------------------
// Herramientas sobre diseno_ifc_modelos / diseno_ifc_elementos (sql/diseno/170):
//   ifc_modelos         modelos procesados y su estado
//   ifc_buscar          elementos con filtros (o conteos agrupados)
//   ifc_interferencias  cruces / contactos entre elementos, con tolerancia en mm
//   ifc_congelar        marcar / desmarcar la versión congelada (solo coordinación)
//
// Todo corre COMO LA PERSONA (su token): la lectura pasa por conector_consulta_sql
// (transacción de solo lectura, RLS del sector Diseño) y congelar por un UPDATE que
// la base solo permite a coordinación (trigger de 170). Los textos que llegan del
// usuario van como literales SQL escapados; igual, conector_consulta_sql no puede
// escribir y solo ve lo que la persona puede ver.
//
// Interferencias: se comparan las CAJAS envolventes (min/max en mm), no la forma
// exacta. Es una aproximación: marca de más (piezas que se tocan a propósito).
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import { z } from 'npm:zod@4.1.13';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';

/** Literal SQL seguro ('' para comillas; sin caracteres nulos). */
export const lit = (s: unknown) => "'" + String(s).split(String.fromCharCode(0)).join('').replace(/'/g, "''") + "'";
/** Para ILIKE: escapa los comodines del texto del usuario. */
const like = (s: string) => lit('%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%');

// Contenedores sin geometría propia (su caja es la de sus partes): se excluyen de las interferencias.
export const CONTENEDORES = ['IfcCurtainWall', 'IfcElementAssembly', 'IfcRoof'];
const COL_AGRUPAR = ['clase', 'familia', 'tipo', 'nivel', 'material'] as const;

export interface FiltroEl {
  clase?: string; familia?: string; tipo?: string; nivel?: string; material?: string; texto?: string;
  parametro?: { grupo?: string; nombre: string; valor?: string };
}

/** Condiciones WHERE (sobre el alias dado) para un filtro de elementos. */
export function condiciones(a: string, f: FiltroEl = {}): string[] {
  const w: string[] = [];
  if (f.clase) w.push(`${a}.clase ilike ${like(f.clase)}`);
  for (const k of ['familia', 'tipo', 'nivel', 'material'] as const) if (f[k]) w.push(`${a}.${k} ilike ${like(f[k]!)}`);
  if (f.texto) w.push(`(${a}.nombre ilike ${like(f.texto)} or ${a}.familia ilike ${like(f.texto)} or ${a}.tipo ilike ${like(f.texto)})`);
  if (f.parametro?.nombre) {
    const p = f.parametro;
    const val = p.valor != null && p.valor !== '' ? ` and g.value->>${lit(p.nombre)} ilike ${like(p.valor)}` : '';
    const grp = p.grupo ? ` and g.key ilike ${like(p.grupo)}` : '';
    w.push(`exists (select 1 from jsonb_each(coalesce(${a}.parametros, '{}'::jsonb)) g where jsonb_typeof(g.value) = 'object' and g.value ? ${lit(p.nombre)}${grp}${val})`);
  }
  return w;
}

export function sqlBuscar(modeloId: number, f: FiltroEl, agruparPor?: string, limite = 100) {
  const w = [`e.modelo_id = ${modeloId}`, ...condiciones('e', f)].join(' and ');
  if (agruparPor) {
    if (!(COL_AGRUPAR as readonly string[]).includes(agruparPor)) throw new Error('agrupar_por inválido');
    return `select coalesce(e.${agruparPor}, '(sin dato)') as ${agruparPor}, count(*) as cantidad from public.diseno_ifc_elementos e where ${w} group by 1 order by 2 desc`;
  }
  return `select e.global_id, e.clase, e.nombre, e.familia, e.tipo, e.nivel, e.material, e.parametros,
    e.min_x, e.min_y, e.min_z, e.max_x, e.max_y, e.max_z,
    round((e.max_x - e.min_x)::numeric) as largo_x_mm, round((e.max_y - e.min_y)::numeric) as largo_y_mm, round((e.max_z - e.min_z)::numeric) as alto_mm,
    count(*) over () as total
    from public.diseno_ifc_elementos e where ${w} order by e.clase, e.familia, e.tipo, e.global_id limit ${Math.max(1, Math.min(limite, 2000))}`;
}

/**
 * Pares de elementos cuyas cajas se cruzan (modo 'interferencia': penetración > tolerancia en los
 * 3 ejes) o quedan a menos de 'tolerancia' sin cruzarse más que eso (modo 'contacto').
 * resumen=true: cantidad de pares por clase/familia; si no, el detalle de los pares.
 */
export function sqlInterferencias(o: {
  modeloA: number; modeloB?: number; a?: FiltroEl; b?: FiltroEl; toleranciaMm: number;
  modo: 'interferencia' | 'contacto'; incluirContenedores?: boolean; resumen: boolean; limite?: number;
}) {
  const t = Math.max(0, Number(o.toleranciaMm) || 0);
  const mismo = !o.modeloB || o.modeloB === o.modeloA;
  const contA = o.incluirContenedores ? [] : [`a.clase not in (${CONTENEDORES.map(lit).join(',')})`];
  const contB = o.incluirContenedores ? [] : [`b.clase not in (${CONTENEDORES.map(lit).join(',')})`];
  const wa = [`a.modelo_id = ${o.modeloA}`, 'a.min_x is not null', ...contA, ...condiciones('a', o.a)];
  const wb = [`b.modelo_id = ${mismo ? o.modeloA : o.modeloB}`, 'b.min_x is not null', ...contB, ...condiciones('b', o.b)];
  // penetración por eje (positivo = se cruzan; negativo = separación)
  const pen = (ax: string) => `least(a.max_${ax}, b.max_${ax}) - greatest(a.min_${ax}, b.min_${ax})`;
  const ejes = ['x', 'y', 'z'];
  const cond = o.modo === 'interferencia'
    ? ejes.map((ax) => `${pen(ax)} > ${t}`).join(' and ')
    // contacto: separación <= t en todos los ejes, y en alguno no se cruzan más que t
    : ejes.map((ax) => `${pen(ax)} >= ${-t}`).join(' and ') + ` and (${ejes.map((ax) => `${pen(ax)} <= ${t}`).join(' or ')})`;
  // en el mismo modelo, cada par una sola vez (si a y b usan el mismo filtro, evita a-b y b-a)
  const orden = mismo ? ` and (a.global_id < b.global_id or not (${[...condiciones('b', o.a), 'true'].join(' and ')}) or not (${[...condiciones('a', o.b), 'true'].join(' and ')}))` : '';
  const base = `from (select * from public.diseno_ifc_elementos a where ${wa.join(' and ')}) a
    join (select * from public.diseno_ifc_elementos b where ${wb.join(' and ')}) b
      on a.global_id <> b.global_id${orden} and ${cond}`;
  if (o.resumen) {
    return `select a.clase as clase_a, a.familia as familia_a, b.clase as clase_b, b.familia as familia_b, count(*) as pares,
      round(max(least(${pen('x')}, ${pen('y')}, ${pen('z')}))::numeric) as max_cruce_mm
      ${base} group by 1, 2, 3, 4 order by 5 desc`;
  }
  return `select a.global_id as id_a, a.clase as clase_a, a.familia as familia_a, a.tipo as tipo_a, a.nivel as nivel_a,
      b.global_id as id_b, b.clase as clase_b, b.familia as familia_b, b.tipo as tipo_b, b.nivel as nivel_b,
      round(least(${pen('x')}, ${pen('y')}, ${pen('z')})::numeric) as cruce_mm,
      round(((least(a.max_x, b.max_x) + greatest(a.min_x, b.min_x)) / 2)::numeric) as x_mm,
      round(((least(a.max_y, b.max_y) + greatest(a.min_y, b.min_y)) / 2)::numeric) as y_mm,
      round(((least(a.max_z, b.max_z) + greatest(a.min_z, b.min_z)) / 2)::numeric) as z_mm,
      count(*) over () as total
    ${base} order by cruce_mm desc limit ${Math.max(1, Math.min(o.limite ?? 100, 1000))}`;
}

export interface CtxIFC { sb: SupabaseClient; texto: (o: unknown) => any; error: (m: string) => any; }

export function registrarIFC(server: any, c: CtxIFC) {
  const { sb, texto, error } = c;
  async function sql(q: string, limite = 2000) {
    const { data, error: e } = await sb.rpc('conector_consulta_sql', { q, limite }, { get: true });
    if (e) throw new Error(e.message);
    return (data || []) as any[];
  }
  async function modelo(id: number) {
    const r = await sql(`select id, archivo, ruta, estado, vigente, congelada, cant_elementos from public.diseno_ifc_modelos where id = ${id}`, 1);
    return r[0] || null;
  }
  const filtro = {
    clase: z.string().optional().describe('Clase IFC o parte (ej. "IfcBeam", "Wall", "Plate")'),
    familia: z.string().optional().describe('Familia de Revit (parte del nombre)'),
    tipo: z.string().optional().describe('Tipo de Revit (parte del nombre)'),
    nivel: z.string().optional().describe('Nivel (parte del nombre)'),
    material: z.string().optional(),
    texto: z.string().optional().describe('Busca en nombre, familia o tipo'),
    parametro: z.object({ grupo: z.string().optional().describe('Grupo de propiedades, ej. "Pset_BeamCommon" o "Datos de identidad"'),
      nombre: z.string().describe('Nombre del parámetro, ej. "Marca", "LoadBearing"'),
      valor: z.string().optional().describe('Valor o parte (vacío = que exista)') }).optional(),
  };
  const filtroObj = z.object(filtro).optional();
  const ro = { readOnlyHint: true, openWorldHint: false };
  const sinAcceso = 'No hay modelos visibles. Puede que no tengas el sector Diseño o que todavía no se haya procesado ningún IFC.';

  server.registerTool('ifc_modelos', {
    title: 'Diseño · modelos IFC procesados',
    description: 'Lista los modelos IFC procesados (carpetas 10-BIM y Estudio de proyecto de cada proyecto): id, archivo, ruta, ' +
      'estado (pendiente / procesando / ok / error), versión vigente, congelada, cantidad de elementos y fecha. Usá el id en ' +
      'ifc_buscar, ifc_interferencias e ifc_congelar. Por defecto solo la versión vigente de cada archivo y las congeladas.',
    inputSchema: {
      buscar: z.string().optional().describe('Parte del número IF, del nombre del archivo o de la ruta (ej. "4432", "SIDE")'),
      todas_las_versiones: z.boolean().optional().describe('true = también versiones anteriores (historial)'),
    },
    annotations: ro,
  }, async ({ buscar, todas_las_versiones }: { buscar?: string; todas_las_versiones?: boolean }) => {
    try {
      const w = [todas_las_versiones ? 'true' : '(m.vigente or m.congelada)'];
      if (buscar) w.push(`(m.nro_if ilike ${like(buscar)} or m.archivo ilike ${like(buscar)} or m.ruta ilike ${like(buscar)} or p.nombre ilike ${like(buscar)})`);
      const r = await sql(`select m.id, m.nro_if, p.nombre as proyecto, m.carpeta, m.archivo, m.ruta, m.estado, m.vigente, m.congelada,
          m.congelada_por, m.cant_elementos, m.schema_ifc, m.sp_modificado_en, m.procesado_en, m.origen, m.error, m.run_url
        from public.diseno_ifc_modelos m left join public.diseno_proyectos p on p.id = m.proyecto_id
        where ${w.join(' and ')} order by m.ruta, m.creado_en desc`, 500);
      return r.length ? texto({ modelos: r }) : texto(sinAcceso);
    } catch (e) { return error('No se pudieron leer los modelos: ' + (e as Error).message); }
  });

  server.registerTool('ifc_buscar', {
    title: 'Diseño · buscar elementos de un modelo IFC',
    description: 'Busca elementos de un modelo IFC procesado con filtros (clase, familia y tipo de Revit, nivel, material, texto, ' +
      'parámetro). Devuelve GlobalId, datos, parámetros y caja en mm (coordenadas del proyecto). Con agrupar_por devuelve ' +
      'cantidades (ej. cuántos elementos por familia). Para "cuántos hay" usá agrupar_por en vez de traer todo.',
    inputSchema: {
      modelo_id: z.number().int().positive().describe('id del modelo (de ifc_modelos)'),
      ...filtro,
      agrupar_por: z.enum(COL_AGRUPAR).optional().describe('Devuelve conteos agrupados por esta columna'),
      limite: z.number().int().min(1).max(2000).optional().describe('Máximo de elementos (por defecto 100)'),
    },
    annotations: ro,
  }, async (a: any) => {
    try {
      const m = await modelo(a.modelo_id);
      if (!m) return error(`No existe el modelo ${a.modelo_id} (o no tenés acceso). Usá ifc_modelos.`);
      const { modelo_id, agrupar_por, limite, ...f } = a;
      const r = await sql(sqlBuscar(modelo_id, f, agrupar_por, limite ?? 100));
      if (agrupar_por) return texto({ modelo: m, agrupado_por: agrupar_por, grupos: r });
      const total = r.length ? Number(r[0].total) : 0;
      return texto({ modelo: m, total_que_cumplen: total, devueltos: r.length,
        aviso: total > r.length ? `Hay ${total}; se muestran ${r.length}. Afiná los filtros o usá agrupar_por.` : undefined,
        elementos: r.map(({ total: _t, ...x }) => x) });
    } catch (e) { return error('No se pudo buscar: ' + (e as Error).message); }
  });

  server.registerTool('ifc_interferencias', {
    title: 'Diseño · interferencias y contactos (IFC)',
    description: 'Detecta pares de elementos que se cruzan (modo "interferencia": se penetran más que la tolerancia en mm) o que ' +
      'se tocan / quedan a menos de la tolerancia (modo "contacto"). Filtros por grupo A y grupo B (clase, familia, tipo, nivel…), ' +
      'en un modelo o entre dos modelos (ej. arquitectura vs instalaciones). APROXIMADO: compara las cajas envolventes, no la forma ' +
      'exacta, así que marca de más (en modular muchas piezas se tocan a propósito); usalo para encontrar candidatos y revisarlos en ' +
      'el modelo. Por defecto devuelve el resumen por clase/familia; con detalle=true, los pares con el punto aproximado del cruce. ' +
      'Excluye contenedores sin geometría propia (muro cortina, cubierta, conjunto) salvo incluir_contenedores=true.',
    inputSchema: {
      modelo_id: z.number().int().positive(),
      modelo_b_id: z.number().int().positive().optional().describe('Otro modelo para comparar contra (vacío = el mismo)'),
      grupo_a: filtroObj.describe('Filtro de los elementos A (vacío = todos)'),
      grupo_b: filtroObj.describe('Filtro de los elementos B (vacío = todos)'),
      tolerancia_mm: z.number().min(0).max(1000).optional().describe('Tolerancia en mm (por defecto 10 para interferencia, 5 para contacto)'),
      modo: z.enum(['interferencia', 'contacto']).optional(),
      detalle: z.boolean().optional().describe('true = lista de pares; por defecto resumen'),
      incluir_contenedores: z.boolean().optional(),
      limite: z.number().int().min(1).max(1000).optional(),
    },
    annotations: ro,
  }, async (a: any) => {
    try {
      const m = await modelo(a.modelo_id);
      if (!m) return error(`No existe el modelo ${a.modelo_id} (o no tenés acceso). Usá ifc_modelos.`);
      if (a.modelo_b_id && !(await modelo(a.modelo_b_id))) return error(`No existe el modelo ${a.modelo_b_id}.`);
      const modo = a.modo || 'interferencia';
      const tol = a.tolerancia_mm ?? (modo === 'interferencia' ? 10 : 5);
      const r = await sql(sqlInterferencias({ modeloA: a.modelo_id, modeloB: a.modelo_b_id, a: a.grupo_a, b: a.grupo_b,
        toleranciaMm: tol, modo, incluirContenedores: a.incluir_contenedores, resumen: !a.detalle, limite: a.limite }));
      const base = { modelo: m, modo, tolerancia_mm: tol,
        criterio: 'Aproximado por cajas envolventes (no forma exacta): son candidatos a revisar en el modelo.' };
      if (!a.detalle) return texto({ ...base, total_pares: r.reduce((s, x) => s + Number(x.pares), 0), por_grupo: r });
      const total = r.length ? Number(r[0].total) : 0;
      return texto({ ...base, total_pares: total, devueltos: r.length, pares: r.map(({ total: _t, ...x }) => x) });
    } catch (e) { return error('No se pudo calcular: ' + (e as Error).message); }
  });

  server.registerTool('ifc_congelar', {
    title: 'Diseño · congelar versión de un modelo IFC',
    description: 'Marca (o desmarca) una versión de un modelo como CONGELADA: conserva sus elementos para comparar los cambios ' +
      'posteriores al congelamiento. Solo coordinación (la base lo valida). Primero llamala SIN confirmado (vista previa), ' +
      'mostrásela al usuario y pedile confirmación; con su OK repetí con confirmado=true. Al descongelar una versión que ya no es ' +
      'la vigente, sus elementos se borran.',
    inputSchema: {
      modelo_id: z.number().int().positive(),
      congelar: z.boolean().optional().describe('true = congelar (por defecto), false = descongelar'),
      confirmado: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ modelo_id, congelar, confirmado }: any) => {
    try {
      const m = await modelo(modelo_id);
      if (!m) return error(`No existe el modelo ${modelo_id} (o no tenés acceso).`);
      const valor = congelar !== false;
      if (m.congelada === valor) return texto(`El modelo ${modelo_id} ya está ${valor ? 'congelado' : 'sin congelar'}.`);
      if (valor && m.estado !== 'ok') return error(`Solo se congela una versión procesada (estado ok); esta está en "${m.estado}".`);
      if (!confirmado) return texto({ vista_previa: true, accion: valor ? 'congelar' : 'descongelar', modelo: m,
        aviso: !valor && !m.vigente ? 'No es la versión vigente: al descongelarla se borran sus elementos.' : undefined,
        siguiente_paso: 'Si el usuario confirma, repetí con confirmado=true.' });
      const { data, error: e } = await sb.from('diseno_ifc_modelos').update({ congelada: valor }).eq('id', modelo_id).select('id, congelada, congelada_por, congelada_en');
      if (e) return error('La base no lo permitió: ' + e.message);
      if (!data?.length) return error('La base no modificó el modelo: tu usuario no tiene permiso (solo coordinación de Diseño).');
      return texto({ ok: true, modelo: data[0] });
    } catch (e) { return error((e as Error).message); }
  });
}
