// ============================================================================
// Conector 4housing Apps — servidor MCP (Supabase Edge Function)
// ----------------------------------------------------------------------------
// Para que cada persona del equipo consulte las apps del portal desde Claude
// CON SUS PROPIOS PERMISOS:
//   · Login: Supabase Auth como servidor OAuth 2.1 (aprobación en
//     portal/oauth/consent). El cliente (Claude) manda el access token del usuario.
//   · Cada consulta a la base viaja con ESE token (nunca service key), así que
//     aplica la RLS existente: tiene_sector / puede_editar_sector / compras_flag.
//   · v1: solo CONSULTA, solo Compras (Gestión de Proyectos, foto económica).
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

const FUNCION = 'conector-4housing';
const SUPABASE_URL = 'https://wcpkpwxhqdcdljfwzcmy.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_08decRYdCRUdtO5zogvJVg_VEBCN9pf';
const BASE_PUBLICA = `${SUPABASE_URL}/functions/v1/${FUNCION}`;
const RECURSO = `${BASE_PUBLICA}/mcp`;
const METADATA_URL = `${BASE_PUBLICA}/.well-known/oauth-protected-resource`;
const VERSION = '0.1.0';

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
async function clienteDelUsuario(req: Request): Promise<{ sb: SupabaseClient; email: string } | null> {
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
  return { sb, email: data.user.email || '' };
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
function crearServidor(sb: SupabaseClient) {
  const server = new McpServer({ name: '4housing-apps', version: VERSION });

  async function proyectos(): Promise<Row[]> {
    const { data, error: e } = await sb.from('compras_gp_proyectos').select('*').order('creado_en', { ascending: false });
    if (e) throw new Error(e.message);
    return (data || []) as Row[];
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
      const lista = await proyectos();
      if (!lista.length) return texto(SIN_ACCESO);
      const k = gpNorm(proyecto);
      let cands = lista.filter(p => String(p.id) === proyecto.trim());
      if (!cands.length) cands = lista.filter(p => gpNorm(p.codigo) === k || gpNorm(p.nombre) === k);
      if (!cands.length) cands = lista.filter(p => gpNorm(p.codigo).includes(k) || gpNorm(p.nombre).includes(k));
      if (!cands.length) return error(`No encontré ningún proyecto que coincida con "${proyecto}". Usá compras_listar_proyectos.`);
      if (cands.length > 1) {
        return texto({ aviso: 'Hay más de un proyecto que coincide: pedí el resumen con el id.',
          proyectos: cands.map(p => ({ id: p.id, codigo: p.codigo ?? null, nombre: p.nombre ?? null })) });
      }
      const p = cands[0];
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
  const server = crearServidor(u.sb);
  // Sin estado: cada pedido HTTP es independiente (cada uno trae su token).
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.all('*', (c) => c.json({ servicio: '4housing Apps (MCP)', version: VERSION, mcp: RECURSO }, 404));

Deno.serve(app.fetch);
