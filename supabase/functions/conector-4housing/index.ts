// ============================================================================
// Conector 4housing Apps — servidor MCP (Supabase Edge Function)
// ----------------------------------------------------------------------------
// Para que cada persona del equipo consulte las apps del portal desde Claude
// CON SUS PROPIOS PERMISOS:
//   · Login: Supabase Auth como servidor OAuth 2.1 (aprobación en
//     portal/oauth/consent). El cliente (Claude) manda el access token del usuario.
//   · Cada consulta a la base viaja con ESE token (nunca service key), así que
//     aplica la RLS existente: tiene_sector / puede_editar_sector / compras_flag.
//   · Herramientas generales (v3): listar tablas por sector, SQL de solo lectura
//     (corre como el usuario, transacción READ ONLY) y altas/modificaciones/bajas
//     con vista previa + confirmación explícita. Más las de Compras (económica y
//     financiera de Gestión de Proyectos).
//   · SharePoint (v4): escritura en Gerencia de Producción · 01 DISEÑO Y DESARROLLO
//     como la persona (Microsoft Graph delegado), ver sharepoint.ts.
//   · Modelos IFC (v5): buscar elementos, interferencias/contactos y congelar versión,
//     sobre lo que carga ifc-procesador, ver ifc.ts.
//
// Deploy: verify_jwt = false (la validación del token la hace este código, para
// poder responder el 401 con WWW-Authenticate que exige el estándar MCP).
// Sin secretos: la publishable key es pública (la misma que portal/index.html).
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js';
import { Hono } from 'npm:hono@4.9.7';
import { z } from 'npm:zod@4.1.13';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { gpNorm, resumenProyecto, type CtxGP } from './compras_gp.ts';
import { financieroProyecto, type CtxFin } from './compras_fin.ts';
import { registrarSharePoint, verificarParaLogin, procesarCallback, urlAutorizar } from './sharepoint.ts';
import { registrarIFC } from './ifc.ts';
import { registrarIFCProcesar } from './ifc_procesar.ts';

const FUNCION = 'conector-4housing';
const SUPABASE_URL = 'https://wcpkpwxhqdcdljfwzcmy.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_08decRYdCRUdtO5zogvJVg_VEBCN9pf';
const BASE_PUBLICA = `${SUPABASE_URL}/functions/v1/${FUNCION}`;
const RECURSO = `${BASE_PUBLICA}/mcp`;
const METADATA_URL = `${BASE_PUBLICA}/.well-known/oauth-protected-resource`;
const VERSION = '0.5.1';
const MS_CALLBACK = `${BASE_PUBLICA}/ms/callback`;
const MAX_FILAS_ESCRITURA = 50;

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function noAutorizado(detalle: string) {
  return new Response(JSON.stringify({ error: 'unauthorized', error_description: detalle }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${METADATA_URL}"`,
    },
  });
}

/** Cliente de Supabase que actúa COMO el usuario (RLS aplica). null si el token no vale. */
async function clienteDelUsuario(req: Request): Promise<{ sb: SupabaseClient; email: string; id: string } | null> {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const sb = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // getUser valida el token contra Supabase Auth (firma, vencimiento, sesión vigente).
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return { sb, email: data.user.email || '', id: data.user.id };
}

// ---------------------------------------------------------------------------
// Lectura con paginación (PostgREST corta en 1000 filas por pedido)
// ---------------------------------------------------------------------------
async function leerTodo(
  sb: SupabaseClient, tabla: string, select: string, orden: string,
  filtro?: (q: any) => any,
): Promise<Row[]> {
  const pagina = 1000; let desde = 0; const todo: Row[] = [];
  for (let i = 0; i < 100; i++) {
    let q = sb.from(tabla).select(select).order(orden, { ascending: true }).range(desde, desde + pagina - 1);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabla}: ${error.message}`);
    const filas = (data || []) as Row[];
    todo.push(...filas);
    if (filas.length < pagina) break;
    desde += pagina;
  }
  return todo;
}
/** Igual que leerTodo, pero si la tabla falla (no existe / sin permiso) devuelve []. Como la app. */
async function leerOpcional(...args: Parameters<typeof leerTodo>): Promise<Row[]> {
  try { return await leerTodo(...args); } catch { return []; }
}

function texto(obj: unknown) {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] };
}
function error(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

const SIN_ACCESO = 'No se encontraron proyectos. Puede que no tengas el sector Compras habilitado en el portal ' +
  '(o tu cuenta no esté activa): el conector solo muestra lo que tu usuario puede ver en la app.';

// ---------------------------------------------------------------------------
// Herramientas (todas de solo lectura)
// ---------------------------------------------------------------------------
function crearServidor(sb: SupabaseClient, usuario: { id: string; email: string }) {
  const server = new McpServer({ name: '4housing-apps', version: VERSION });

  async function proyectos(): Promise<Row[]> {
    const { data, error: e } = await sb.from('compras_gp_proyectos').select('*').order('creado_en', { ascending: false });
    if (e) throw new Error(e.message);
    return (data || []) as Row[];
  }

  // Busca el proyecto por id, código o nombre. Devuelve el proyecto, o una respuesta MCP lista
  // (sin acceso / no encontrado / ambiguo).
  async function resolverProyecto(proyecto: string): Promise<{ p: Row } | { respuesta: any }> {
    const lista = await proyectos();
    if (!lista.length) return { respuesta: texto(SIN_ACCESO) };
    const k = gpNorm(proyecto);
    let cands = lista.filter(p => String(p.id) === proyecto.trim());
    if (!cands.length) cands = lista.filter(p => gpNorm(p.codigo) === k || gpNorm(p.nombre) === k);
    if (!cands.length) cands = lista.filter(p => gpNorm(p.codigo).includes(k) || gpNorm(p.nombre).includes(k));
    if (!cands.length) return { respuesta: error(`No encontré ningún proyecto que coincida con "${proyecto}". Usá compras_listar_proyectos.`) };
    if (cands.length > 1) {
      return { respuesta: texto({ aviso: 'Hay más de un proyecto que coincide: pedí el resumen con el id.',
        proyectos: cands.map(p => ({ id: p.id, codigo: p.codigo ?? null, nombre: p.nombre ?? null })) }) };
    }
    return { p: cands[0] };
  }

  server.registerTool('compras_listar_proyectos', {
    title: 'Compras · listar proyectos',
    description: 'Lista los proyectos (obras) de Gestión de Proyectos de la app de Compras de 4housing: id, código y nombre. ' +
      'Usalo para encontrar el proyecto antes de pedir su resumen. Opcional: "buscar" filtra por código o nombre.',
    inputSchema: { buscar: z.string().optional().describe('Texto a buscar en el código o el nombre del proyecto') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ buscar }) => {
    try {
      let lista = await proyectos();
      if (!lista.length) return texto(SIN_ACCESO);
      if (buscar && buscar.trim()) {
        const k = gpNorm(buscar);
        lista = lista.filter(p => gpNorm(p.codigo).includes(k) || gpNorm(p.nombre).includes(k));
      }
      return texto(lista.map(p => ({ id: p.id, codigo: p.codigo ?? null, nombre: p.nombre ?? null, creado_en: p.creado_en ?? null })));
    } catch (e) { return error('No se pudieron leer los proyectos: ' + (e as Error).message); }
  });

  server.registerTool('compras_resumen_proyecto', {
    title: 'Compras · resumen económico de un proyecto',
    description: 'Foto ECONÓMICA de un proyecto (comprado vs presupuesto), con los mismos números que el tablero de ' +
      'Gestión de Proyectos de la app de Compras: presupuesto, comprado (OC de Tango + OGs de la app, que son canales ' +
      'complementarios y ambos cuentan como compra), avance, saldo, extracosto, ahorro confirmado y potencial, sin ' +
      'clasificar, y el detalle por rubro. Importes en pesos (ARS), con su equivalente en USD. NO incluye la foto ' +
      'financiera (certificaciones, pagos, pendiente de certificar): no la presentes como si lo fuera.',
    inputSchema: { proyecto: z.string().min(1).describe('Id, código o parte del nombre del proyecto (ej. "Vicuña")') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ proyecto }) => {
    try {
      const r = await resolverProyecto(proyecto);
      if ('respuesta' in r) return r.respuesta;
      const p = r.p;
      const id = p.id;
      const porProyecto = (q: any) => q.eq('proyecto_id', id);
      const [presupuesto, oc, mapeo, reparto, ogsec, imports, traslados, usdOficial, ogs] = await Promise.all([
        leerTodo(sb, 'compras_gp_presupuesto', '*', 'orden', porProyecto),
        leerTodo(sb, 'compras_gp_oc', '*', 'id', porProyecto),
        leerTodo(sb, 'compras_gp_mapeo', '*', 'seccion', porProyecto),
        leerTodo(sb, 'compras_gp_reparto', '*', 'id', porProyecto),
        leerOpcional(sb, 'compras_gp_og_seccion', 'og_id,seccion', 'og_id', porProyecto),
        leerOpcional(sb, 'compras_gp_importaciones', 'importado_en,archivo_nombre,filas', 'importado_en', porProyecto),
        p.codigo ? leerOpcional(sb, 'compras_gp_traslados_mo', '*', 'creado_en', (q: any) => q.eq('codigo', p.codigo)) : Promise.resolve([]),
        leerTodo(sb, 'compras_usd_diario_oficial', 'fecha,venta', 'fecha'),
        leerTodo(sb, 'compras_ogs', 'id,numero,fecha,anulada,clasif_og,items,bonif_pct,monto_total,cierres,moneda,tc_pesos,costeo,costeo_new', 'id'),
      ]);
      if (!presupuesto.length) {
        return texto({ proyecto: { id, codigo: p.codigo ?? null, nombre: p.nombre ?? null },
          aviso: 'Este proyecto todavía no tiene presupuesto cargado (falta que dirección cargue el costeo).' });
      }
      const ogSeccion: Record<string, string> = {};
      ogsec.forEach(r => { ogSeccion[r.og_id] = r.seccion; });
      const ctx: CtxGP = { proyecto: p, presupuesto, oc, mapeo, reparto, ogSeccion, ogs, usdOficial, traslados };
      const res = resumenProyecto(ctx);
      const ult = imports.length ? imports[imports.length - 1] : null;
      return texto({ ...res, ultima_importacion_tango: ult ? { fecha: ult.importado_en, archivo: ult.archivo_nombre, renglones: ult.filas } : null });
    } catch (e) { return error('No se pudo calcular el resumen: ' + (e as Error).message); }
  });

  server.registerTool('compras_financiero_proyecto', {
    title: 'Compras · foto financiera de un proyecto',
    description: 'Foto FINANCIERA de un proyecto, separada de la económica: por cada Orden de Gasto (OG) de la app, ' +
      'total, certificado, liberado, certificado sin liberar, pendiente de certificar, pagado, pendiente de pago y OP armadas ' +
      'sin pagar, con totales del proyecto en pesos; y para las OC de Tango, facturado y pendiente de facturar. Misma lógica que ' +
      'la app de Compras; en OGs compartidas con otras obras cuentan solo los renglones de esta obra. Para "cuánto llevamos ' +
      'comprado vs presupuesto" usá compras_resumen_proyecto; esta herramienta responde certificaciones, pagos y pendientes.',
    inputSchema: { proyecto: z.string().min(1).describe('Id, código o parte del nombre del proyecto (ej. "Vicuña")') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ proyecto }) => {
    try {
      const r = await resolverProyecto(proyecto);
      if ('respuesta' in r) return r.respuesta;
      const p = r.p;
      const [ogs, certificados, pagos, oc, imports] = await Promise.all([
        leerTodo(sb, 'compras_ogs', 'id,numero,fecha,proveedor,proveedor_cod,anulada,clasif_og,items,bonif_pct,monto_total,cierres,moneda,tc_pesos,condicion,anticipo_pct,anticipo_metodo,pago_usd', 'id'),
        leerTodo(sb, 'compras_og_certificados', 'id,og_id,numero,fecha,pct,avances,aprobacion,estado', 'id'),
        leerTodo(sb, 'compras_pagos', '*', 'id'),
        leerTodo(sb, 'compras_gp_oc', 'id,oc_numero,estado_oc,total_ars,cantidad_pedida,cantidad_facturada,cantidad_pend_facturar', 'id', (q: any) => q.eq('proyecto_id', p.id)),
        leerOpcional(sb, 'compras_gp_importaciones', 'importado_en,archivo_nombre', 'importado_en', (q: any) => q.eq('proyecto_id', p.id)),
      ]);
      const ctx: CtxFin = { proyecto: p, ogs, certificados, pagos, oc };
      const res = financieroProyecto(ctx);
      const ult = imports.length ? imports[imports.length - 1] : null;
      return texto({ ...res, ultima_importacion_tango: ult ? { fecha: ult.importado_en, archivo: ult.archivo_nombre } : null });
    } catch (e) { return error('No se pudo calcular la foto financiera: ' + (e as Error).message); }
  });

  // ======================= Herramientas generales =========================
  server.registerTool('listar_tablas', {
    title: 'Apps del portal · tablas que podés ver',
    description: 'Lista las tablas y vistas de las apps del portal 4housing que el usuario puede consultar, según sus ' +
      'sectores (panel de Usuarios): fhcomercial (Comercial 4housing), labocomercial (LABO), diseno, planificacion, compras, ' +
      'eerr, adminfin, rrhh, logistica; más tablas generales del portal. Sin parámetros devuelve nombres por sector; con ' +
      '"sector" o "tabla" devuelve también las columnas y sus tipos. Usalo antes de escribir una consulta_sql.',
    inputSchema: {
      sector: z.string().optional().describe('Filtrar por sector (ej. "compras", "planificacion")'),
      tabla: z.string().optional().describe('Nombre exacto o parte del nombre de una tabla, para ver sus columnas'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ sector, tabla }) => {
    try {
      const { data, error: e } = await sb.rpc('conector_tablas', {}, { get: true });
      if (e) throw new Error(e.message);
      let filas = (data || []) as Row[];
      if (sector) filas = filas.filter(f => (f.sector || 'portal') === sector.trim().toLowerCase());
      if (tabla) filas = filas.filter(f => String(f.tabla).includes(tabla.trim().toLowerCase()));
      if (!filas.length) return texto('No hay tablas visibles con ese filtro para tu usuario.');
      if (sector || tabla) return texto(filas.map(f => ({ tabla: f.tabla, tipo: f.tipo, sector: f.sector || 'portal', columnas: f.columnas })));
      const porSector: Record<string, string[]> = {};
      filas.forEach(f => { const k = f.sector || 'portal'; (porSector[k] = porSector[k] || []).push(f.tabla); });
      return texto({ aviso: 'Pedí listar_tablas con "sector" o "tabla" para ver las columnas.', tablas_por_sector: porSector });
    } catch (e) { return error('No se pudieron listar las tablas: ' + (e as Error).message); }
  });

  server.registerTool('consulta_sql', {
    title: 'Apps del portal · consulta SQL (solo lectura)',
    description: 'Ejecuta UNA consulta SELECT (o WITH … SELECT) de PostgreSQL sobre la base de las apps del portal y devuelve ' +
      'las filas en JSON. Corre COMO EL USUARIO: solo ve lo que sus permisos le dejan ver (si una tabla devuelve 0 filas puede ' +
      'ser falta de permiso). Es de solo lectura: no puede modificar nada. Tablas en el esquema public, con prefijo por app ' +
      '(compras_, planificacion_, diseno_, fhcomercial_, labocomercial_, eerr_, …). Usá listar_tablas para ver columnas. ' +
      'Límite: 15 segundos y hasta 2000 filas; para totales usá agregaciones (sum, count, group by) en vez de traer todo.',
    inputSchema: {
      sql: z.string().min(1).describe('Una sola consulta SELECT o WITH, sin ";" intermedios'),
      limite: z.number().int().min(1).max(2000).optional().describe('Máximo de filas a devolver (por defecto 500)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ sql, limite }) => {
    try {
      const { data, error: e } = await sb.rpc('conector_consulta_sql', { q: sql, limite: limite ?? 500 }, { get: true });
      if (e) return error('La consulta falló: ' + e.message + (e.hint ? ' (' + e.hint + ')' : ''));
      const filas = (data || []) as Row[];
      return texto({ filas: filas.length, tope: limite ?? 500, datos: filas });
    } catch (e) { return error('No se pudo ejecutar la consulta: ' + (e as Error).message); }
  });

  // ---- Escritura: siempre vista previa primero; escribe solo con confirmado=true ----
  const Filtro = z.object({
    columna: z.string().regex(/^[a-z_][a-z0-9_]*$/),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']),
    valor: z.any(),
  });
  const nombreTabla = z.string().regex(/^[a-z][a-z0-9_]*$/).describe('Tabla del esquema public (ej. "compras_proveedores")');
  const AVISO_CONFIRMAR = 'Primero llamala SIN confirmado (devuelve la vista previa de lo que cambiaría); mostrásela al ' +
    'usuario y pedile confirmación explícita; recién con su OK, repetí la llamada con confirmado=true. La base solo deja ' +
    'escribir a quien puede editar esa app (los lectores no). Para operaciones con reglas de negocio (numeración, ' +
    'historial, certificar, pagar) preferí la app: esta herramienta escribe filas tal cual.';
  function aplicarFiltros(q: any, filtros: z.infer<typeof Filtro>[]) {
    for (const f of filtros) {
      let v: any = f.valor;
      if (f.op === 'in') v = '(' + (Array.isArray(v) ? v : [v]).map((x: unknown) => JSON.stringify(x)).join(',') + ')';
      q = f.op === 'in' ? q.filter(f.columna, 'in', v) : q.filter(f.columna, f.op, v);
    }
    return q;
  }
  async function vistaPrevia(tabla: string, filtros: z.infer<typeof Filtro>[]) {
    const { data, count, error: e } = await aplicarFiltros(sb.from(tabla).select('*', { count: 'exact' }), filtros).limit(20);
    if (e) throw new Error(e.message);
    return { filas_que_coinciden: count ?? (data || []).length, muestra: data || [] };
  }

  server.registerTool('insertar', {
    title: 'Apps del portal · cargar registros',
    description: 'Inserta hasta ' + MAX_FILAS_ESCRITURA + ' filas en una tabla de las apps del portal, con los permisos del usuario. ' + AVISO_CONFIRMAR,
    inputSchema: {
      tabla: nombreTabla,
      registros: z.array(z.record(z.string(), z.any())).min(1).max(MAX_FILAS_ESCRITURA).describe('Filas a insertar (columna: valor)'),
      confirmado: z.boolean().optional().describe('true solo después de que el usuario aprobó la vista previa'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ tabla, registros, confirmado }) => {
    try {
      if (!confirmado) return texto({ vista_previa: true, accion: 'insertar', tabla, cantidad: registros.length, registros,
        siguiente_paso: 'Mostrale esto al usuario y, si confirma, repetí con confirmado=true.' });
      const { data, error: e } = await sb.from(tabla).insert(registros).select();
      if (e) return error('La base no permitió la carga: ' + e.message);
      return texto({ ok: true, insertadas: (data || []).length, filas: data });
    } catch (e) { return error('No se pudo insertar: ' + (e as Error).message); }
  });

  server.registerTool('actualizar', {
    title: 'Apps del portal · modificar registros',
    description: 'Modifica columnas de las filas que cumplen los filtros (obligatorios; máximo ' + MAX_FILAS_ESCRITURA +
      ' filas por vez), con los permisos del usuario. ' + AVISO_CONFIRMAR,
    inputSchema: {
      tabla: nombreTabla,
      filtros: z.array(Filtro).min(1).describe('Condiciones (se combinan con AND), ej. [{columna:"id",op:"eq",valor:123}]'),
      cambios: z.record(z.string(), z.any()).describe('Columnas a modificar y su nuevo valor'),
      confirmado: z.boolean().optional().describe('true solo después de que el usuario aprobó la vista previa'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ tabla, filtros, cambios, confirmado }) => {
    try {
      if (!Object.keys(cambios).length) return error('No indicaste qué columnas cambiar.');
      const vp = await vistaPrevia(tabla, filtros);
      if (!vp.filas_que_coinciden) return texto('Ninguna fila visible para tu usuario cumple esos filtros: no hay nada para modificar.');
      if (vp.filas_que_coinciden > MAX_FILAS_ESCRITURA) return error(`Los filtros abarcan ${vp.filas_que_coinciden} filas; el máximo por vez es ${MAX_FILAS_ESCRITURA}. Afiná los filtros.`);
      if (!confirmado) return texto({ vista_previa: true, accion: 'actualizar', tabla, filtros, cambios, ...vp,
        siguiente_paso: 'Mostrale esto al usuario y, si confirma, repetí con confirmado=true.' });
      const { data, error: e } = await aplicarFiltros(sb.from(tabla).update(cambios), filtros).select();
      if (e) return error('La base no permitió la modificación: ' + e.message);
      const n = (data || []).length;
      if (!n) return error('La base no modificó ninguna fila: tu usuario no tiene permiso de edición sobre esas filas.');
      return texto({ ok: true, modificadas: n, filas: data });
    } catch (e) { return error('No se pudo modificar: ' + (e as Error).message); }
  });

  server.registerTool('eliminar', {
    title: 'Apps del portal · borrar registros',
    description: 'Borra las filas que cumplen los filtros (obligatorios; máximo ' + MAX_FILAS_ESCRITURA + ' filas por vez), ' +
      'con los permisos del usuario. Es irreversible. ' + AVISO_CONFIRMAR,
    inputSchema: {
      tabla: nombreTabla,
      filtros: z.array(Filtro).min(1).describe('Condiciones (se combinan con AND), ej. [{columna:"id",op:"eq",valor:123}]'),
      confirmado: z.boolean().optional().describe('true solo después de que el usuario aprobó la vista previa'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ tabla, filtros, confirmado }) => {
    try {
      const vp = await vistaPrevia(tabla, filtros);
      if (!vp.filas_que_coinciden) return texto('Ninguna fila visible para tu usuario cumple esos filtros: no hay nada para borrar.');
      if (vp.filas_que_coinciden > MAX_FILAS_ESCRITURA) return error(`Los filtros abarcan ${vp.filas_que_coinciden} filas; el máximo por vez es ${MAX_FILAS_ESCRITURA}. Afiná los filtros.`);
      if (!confirmado) return texto({ vista_previa: true, accion: 'eliminar', irreversible: true, tabla, filtros, ...vp,
        siguiente_paso: 'Mostrale esto al usuario y, si confirma, repetí con confirmado=true.' });
      const { data, error: e } = await aplicarFiltros(sb.from(tabla).delete(), filtros).select();
      if (e) return error('La base no permitió el borrado: ' + e.message);
      const n = (data || []).length;
      if (!n) return error('La base no borró ninguna fila: tu usuario no tiene permiso para borrar esas filas.');
      return texto({ ok: true, borradas: n, filas: data });
    } catch (e) { return error('No se pudo borrar: ' + (e as Error).message); }
  });

  // ======================= SharePoint (Diseño) =========================
  registrarSharePoint(server, { sb, userId: usuario.id, email: usuario.email, basePublica: BASE_PUBLICA, texto, error });

  // ======================= Modelos IFC (Diseño) =========================
  registrarIFC(server, { sb, texto, error });
  registrarIFCProcesar(server, { sb, userId: usuario.id, texto, error });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = new Hono().basePath(`/${FUNCION}`);

// Metadatos del recurso protegido (RFC 9728): le dicen al cliente MCP qué servidor OAuth usar.
app.get('/.well-known/oauth-protected-resource', (c) => c.json({
  resource: RECURSO,
  authorization_servers: [`${SUPABASE_URL}/auth/v1`],
  bearer_methods_supported: ['header'],
  resource_name: '4housing Apps',
}));

app.all('/mcp', async (c) => {
  const u = await clienteDelUsuario(c.req.raw);
  if (!u) return noAutorizado('Falta un token válido. Conectá el conector con tu cuenta de 4housing.');
  const server = crearServidor(u.sb, { id: u.id, email: u.email });
  // Sin estado: cada pedido HTTP es independiente (cada uno trae su token).
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

// Conexión de la cuenta Microsoft (link que da la herramienta sharepoint_conectar).
function paginaSimple(titulo: string, mensaje: string, ok: boolean) {
  const esc = (x: string) => x.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[ch]);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f4f1;color:#20262e;margin:0;padding:16px}
.c{max-width:460px;margin:12vh auto 0;background:#fff;border:1px solid #dfe2e6;border-radius:10px;padding:28px;text-align:center}
h1{font-size:1.15rem;margin:0 0 10px;color:${ok ? '#1a7a45' : '#9a5a12'}}p{color:#5b646e;font-size:.95rem;line-height:1.5}</style></head>
<body><div class="c"><h1>${esc(titulo)}</h1><p>${esc(mensaje)}</p></div></body></html>`;
}
app.get('/ms/login', async (c) => {
  const t = c.req.query('t') || '';
  if (!(await verificarParaLogin(t))) return c.html(paginaSimple('Link vencido', 'El link de conexión venció o no es válido. Pedile a Claude uno nuevo.', false), 400);
  return c.redirect(urlAutorizar(MS_CALLBACK, t), 302);
});
app.get('/ms/callback', async (c) => {
  try {
    const r = await procesarCallback(new URL(c.req.url), MS_CALLBACK);
    return c.html(paginaSimple(r.ok ? 'Cuenta conectada' : 'No se pudo conectar', r.mensaje, r.ok), r.ok ? 200 : 400);
  } catch (e) {
    return c.html(paginaSimple('No se pudo conectar', (e as Error).message, false), 500);
  }
});

app.all('*', (c) => c.json({ servicio: '4housing Apps (MCP)', version: VERSION, mcp: RECURSO }, 404));

Deno.serve(app.fetch);
