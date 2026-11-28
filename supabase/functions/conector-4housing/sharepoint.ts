// ============================================================================
// Conector 4housing Apps · SharePoint (Gerencia de Producción, "01 DISEÑO Y DESARROLLO")
// ----------------------------------------------------------------------------
// Escritura en SharePoint COMO LA PERSONA (permisos delegados de Microsoft Graph),
// igual que la app de Comercial, pero desde el servidor:
//   · Cada persona conecta su cuenta Microsoft UNA vez (link que da sharepoint_conectar).
//     Debe ser la MISMA persona que la cuenta del portal (mismo mail).
//   · El refresh token se guarda CIFRADO (AES-GCM; clave derivada de MS_CLIENT_SECRET)
//     en public.conector_ms_tokens, tabla sin acceso por la API (solo service role).
//   · Límites (pedido de Diseño, 2026-11-26): solo dentro de
//     "Documentos compartidos/01 DISEÑO Y DESARROLLO"; SIN borrar; sin pisar archivos;
//     vista previa + confirmado=true; solo quien edita Diseño. Todo queda en
//     public.diseno_sharepoint_log.
// Secretos (Edge Functions → Secrets): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET.
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import { z } from 'npm:zod@4.1.13';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';

const SITIO = '4housing22.sharepoint.com:/sites/GerenciadeProduccion2';
const BIBLIOTECA = 'Documentos compartidos';
export const BASE = '01 DISEÑO Y DESARROLLO';
const SCOPES = 'offline_access https://graph.microsoft.com/Files.ReadWrite.All https://graph.microsoft.com/Sites.ReadWrite.All https://graph.microsoft.com/User.Read';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_SUBIDA = 4 * 1024 * 1024;   // subida simple de Graph

const env = (k: string) => Deno.env.get(k) || '';
export function msConfigurado() { return !!(env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET')); }

// ---------------------------------------------------------------------------
// Cripto: claves derivadas de MS_CLIENT_SECRET (HKDF) — cifrado y firma del "state"
// ---------------------------------------------------------------------------
const te = new TextEncoder(), td = new TextDecoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

async function claves() {
  const base = await crypto.subtle.importKey('raw', te.encode(env('MS_CLIENT_SECRET')), 'HKDF', false, ['deriveKey']);
  const der = (info: string, alg: any, usos: KeyUsage[]) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode('conector-4housing'), info: te.encode(info) }, base, alg, false, usos);
  return {
    aes: await der('ms-tokens-aes', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    hmac: await der('ms-state-hmac', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
  };
}
async function cifrar(txt: string) {
  const { aes } = await claves(); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, te.encode(txt)));
  return b64u(iv) + '.' + b64u(ct);
}
async function descifrar(s: string) {
  const { aes } = await claves(); const [iv, ct] = s.split('.');
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deb64u(iv) }, aes, deb64u(ct)));
}
export async function firmarEstado(uid: string, email: string) {
  const { hmac } = await claves();
  const cuerpo = b64u(te.encode(JSON.stringify({ uid, email, exp: Date.now() + 15 * 60 * 1000, n: b64u(crypto.getRandomValues(new Uint8Array(9))) })));
  const firma = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, te.encode(cuerpo))));
  return cuerpo + '.' + firma;
}
/** Para /ms/login: el link sigue vigente y firmado por este servidor. */
export async function verificarParaLogin(t: string) { return !!(await verificarEstado(t)); }
async function verificarEstado(t: string): Promise<{ uid: string; email: string } | null> {
  try {
    const { hmac } = await claves(); const [cuerpo, firma] = t.split('.');
    if (!cuerpo || !firma) return null;
    if (!await crypto.subtle.verify('HMAC', hmac, deb64u(firma), te.encode(cuerpo))) return null;
    const d = JSON.parse(td.decode(deb64u(cuerpo)));
    return d.exp > Date.now() ? { uid: d.uid, email: d.email } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// OAuth con Microsoft (código de autorización, cliente confidencial)
// ---------------------------------------------------------------------------
const admin = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const tokenUrl = () => `https://login.microsoftonline.com/${env('MS_TENANT_ID')}/oauth2/v2.0/token`;

export function urlAutorizar(redirectUri: string, state: string) {
  const q = new URLSearchParams({ client_id: env('MS_CLIENT_ID'), response_type: 'code', redirect_uri: redirectUri,
    response_mode: 'query', scope: SCOPES, state, prompt: 'select_account' });
  return `https://login.microsoftonline.com/${env('MS_TENANT_ID')}/oauth2/v2.0/authorize?${q}`;
}
async function pedirToken(params: Record<string, string>) {
  const r = await fetch(tokenUrl(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('MS_CLIENT_ID'), client_secret: env('MS_CLIENT_SECRET'), scope: SCOPES, ...params }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || ('token ' + r.status));
  return j as { access_token: string; refresh_token?: string };
}

/** Callback de Microsoft: valida el state, canjea el código y guarda el permiso cifrado. Devuelve HTML. */
export async function procesarCallback(url: URL, redirectUri: string): Promise<{ ok: boolean; mensaje: string }> {
  if (url.searchParams.get('error')) return { ok: false, mensaje: 'Microsoft no autorizó la conexión: ' + (url.searchParams.get('error_description') || url.searchParams.get('error')) };
  const st = await verificarEstado(url.searchParams.get('state') || '');
  if (!st) return { ok: false, mensaje: 'El link de conexión venció o no es válido. Pedile a Claude uno nuevo (sharepoint_conectar).' };
  const code = url.searchParams.get('code'); if (!code) return { ok: false, mensaje: 'Falta el código de autorización.' };
  const tk = await pedirToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const me = await (await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { authorization: 'Bearer ' + tk.access_token } })).json();
  const msEmail = String(me.mail || me.userPrincipalName || '').toLowerCase();
  if (!msEmail || msEmail !== String(st.email || '').toLowerCase())
    return { ok: false, mensaje: `La cuenta Microsoft (${msEmail || 'desconocida'}) no es la misma que tu cuenta del portal (${st.email}). Conectá tu propia cuenta.` };
  if (!tk.refresh_token) return { ok: false, mensaje: 'Microsoft no devolvió permiso de acceso prolongado (offline_access).' };
  const { error } = await admin().from('conector_ms_tokens').upsert({ user_id: st.uid, ms_email: msEmail,
    refresh_token_enc: await cifrar(tk.refresh_token), actualizado_en: new Date().toISOString() });
  if (error) return { ok: false, mensaje: 'No se pudo guardar la conexión: ' + error.message };
  return { ok: true, mensaje: `Listo: tu cuenta ${msEmail} quedó conectada. Ya podés volver a Claude.` };
}

async function accessTokenDe(uid: string): Promise<string | null> {
  const db = admin();
  const { data } = await db.from('conector_ms_tokens').select('refresh_token_enc').eq('user_id', uid).maybeSingle();
  if (!data) return null;
  const rt = await descifrar(data.refresh_token_enc);
  const tk = await pedirToken({ grant_type: 'refresh_token', refresh_token: rt });
  if (tk.refresh_token && tk.refresh_token !== rt)   // Microsoft rota el refresh token: guardar el nuevo
    await db.from('conector_ms_tokens').update({ refresh_token_enc: await cifrar(tk.refresh_token), actualizado_en: new Date().toISOString() }).eq('user_id', uid);
  return tk.access_token;
}

// ---------------------------------------------------------------------------
// Rutas: todo relativo a "01 DISEÑO Y DESARROLLO"; nada puede salir de ahí
// ---------------------------------------------------------------------------
const PROHIBIDOS = /["*:<>?\\|]/;
export function rutaSegura(entrada: string | undefined): string {
  let s = String(entrada || '').normalize('NFC').replace(/\\/g, '/').trim();
  s = s.replace(/^\/+|\/+$/g, '');
  if (s.toLowerCase().startsWith(BIBLIOTECA.toLowerCase() + '/')) s = s.slice(BIBLIOTECA.length + 1);
  else if (s.toLowerCase() === BIBLIOTECA.toLowerCase()) s = '';
  if (s.normalize('NFC').toUpperCase() === BASE.toUpperCase()) s = '';
  else if (s.toUpperCase().startsWith(BASE.toUpperCase() + '/')) s = s.slice(BASE.length + 1);
  const partes = s ? s.split('/') : [];
  for (const p of partes) {
    if (!p.trim() || p === '.' || p === '..' || PROHIBIDOS.test(p)) throw new Error(`Ruta inválida: "${entrada}"`);
  }
  return [BASE, ...partes].join('/');
}
export function nombreSeguro(n: string) {
  const s = String(n || '').normalize('NFC').trim();
  if (!s || s === '.' || s === '..' || s.includes('/') || PROHIBIDOS.test(s)) throw new Error(`Nombre inválido: "${n}"`);
  return s;
}
const enc = (ruta: string) => ruta.split('/').map(encodeURIComponent).join('/');
/** Verifica con la respuesta de Graph que el ítem esté de verdad dentro de la carpeta base. */
function dentroDeBase(item: any): boolean {
  const pr = decodeURIComponent(String(item?.parentReference?.path || '')).normalize('NFC');
  const m = pr.match(/root:(.*)$/); if (!m) return false;
  const completo = (m[1] + '/' + item.name).replace(/^\/+/, '');
  return completo === BASE || completo.startsWith(BASE + '/');
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
export class Graph {
  driveId = '';
  constructor(private token: string) {}
  async req(metodo: string, ruta: string, cuerpo?: unknown, extra?: Record<string, string>) {
    const r = await fetch(ruta.startsWith('http') ? ruta : GRAPH + ruta, { method: metodo,
      headers: { authorization: 'Bearer ' + this.token, ...(cuerpo !== undefined && !(cuerpo instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...(extra || {}) },
      body: cuerpo === undefined ? undefined : (cuerpo instanceof Uint8Array ? (cuerpo as unknown as BodyInit) : JSON.stringify(cuerpo)) });
    const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
    return { ok: r.ok, status: r.status, data: j, headers: r.headers };
  }
  async iniciar() {
    const s = await this.req('GET', `/sites/${SITIO}?$select=id`);
    if (!s.ok) throw new Error('No se pudo abrir el sitio de Gerencia de Producción (' + (s.data?.error?.message || s.status) + ')');
    const d = await this.req('GET', `/sites/${s.data.id}/drives?$select=id,name,webUrl`);
    if (!d.ok) throw new Error('No se pudieron leer las bibliotecas del sitio.');
    const drive = (d.data.value || []).find((x: any) => x.name === BIBLIOTECA || decodeURIComponent(String(x.webUrl || '')).endsWith('/' + BIBLIOTECA));
    if (!drive) throw new Error(`No encontré la biblioteca "${BIBLIOTECA}".`);
    this.driveId = drive.id;
  }
  async item(ruta: string) {
    const r = await this.req('GET', `/drives/${this.driveId}/root:/${enc(ruta)}?$select=id,name,folder,file,size,parentReference,webUrl,lastModifiedDateTime,lastModifiedBy`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.data?.error?.message || ('Graph ' + r.status));
    if (!dentroDeBase(r.data)) throw new Error('Fuera de "01 DISEÑO Y DESARROLLO": operación no permitida.');
    return r.data;
  }
  /** Igual que item(), con el link de descarga temporal (@microsoft.graph.downloadUrl, ~1 h) y la versión (eTag). */
  async itemConDescarga(ruta: string) {
    const r = await this.req('GET', `/drives/${this.driveId}/root:/${enc(ruta)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.data?.error?.message || ('Graph ' + r.status));
    if (!dentroDeBase(r.data)) throw new Error('Fuera de "01 DISEÑO Y DESARROLLO": operación no permitida.');
    return r.data;
  }
}

/** Graph con la cuenta Microsoft conectada de la persona (null si no la conectó). Lanza error si venció. */
export async function graphDe(userId: string): Promise<Graph | null> {
  if (!msConfigurado()) throw new Error('La conexión con SharePoint todavía no está configurada en el servidor.');
  const tok = await accessTokenDe(userId);
  if (!tok) return null;
  const g = new Graph(tok); await g.iniciar(); return g;
}

// ---------------------------------------------------------------------------
// Herramientas MCP
// ---------------------------------------------------------------------------
export interface CtxSP { sb: SupabaseClient; userId: string; email: string; basePublica: string; texto: (o: unknown) => any; error: (m: string) => any; }

export function registrarSharePoint(server: any, c: CtxSP) {
  const { sb, texto, error } = c;
  const AVISO = 'Solo dentro de "Documentos compartidos/01 DISEÑO Y DESARROLLO" del sitio Gerencia de Producción (rutas relativas a esa carpeta, ' +
    'ej. "IF4450-PROYECTO/10-BIM"). No borra ni pisa archivos existentes. Primero llamala SIN confirmado (vista previa), mostrásela ' +
    'al usuario y pedile confirmación explícita; recién con su OK repetí con confirmado=true. Actúa con la cuenta Microsoft de la persona.';

  async function puede(editar: boolean) {
    const { data } = await sb.rpc(editar ? 'puede_editar_sector' : 'tiene_sector', { s: 'diseno' });
    return data === true;
  }
  async function graph(editar: boolean): Promise<Graph | { respuesta: any }> {
    if (!msConfigurado()) return { respuesta: error('La conexión con SharePoint todavía no está configurada en el servidor (faltan secretos MS_*).') };
    if (!await puede(editar)) return { respuesta: error(editar ? 'Solo quien edita Diseño puede escribir en SharePoint desde Claude.' : 'Tu usuario no tiene el sector Diseño.') };
    let tok: string | null = null;
    try { tok = await accessTokenDe(c.userId); } catch (e) { return { respuesta: error('Tu conexión con Microsoft venció o fue revocada. Usá sharepoint_conectar para volver a conectarla. (' + (e as Error).message + ')') }; }
    if (!tok) return { respuesta: error('Todavía no conectaste tu cuenta Microsoft. Usá sharepoint_conectar y abrí el link.') };
    const g = new Graph(tok); await g.iniciar(); return g;
  }
  async function registrar(accion: string, origen: string | null, destino: string | null, resultado: string, detalle?: unknown) {
    await sb.from('diseno_sharepoint_log').insert({ email: c.email, accion, origen, destino, resultado, detalle: detalle ?? null });
  }
  const confirmado = z.boolean().optional().describe('true solo después de que el usuario aprobó la vista previa');
  const ro = { readOnlyHint: true, openWorldHint: true }, w = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool('sharepoint_conectar', {
    title: 'SharePoint · conectar mi cuenta Microsoft',
    description: 'Da el link para conectar (una sola vez) la cuenta Microsoft de la persona, necesario para escribir en SharePoint ' +
      '(Gerencia de Producción · 01 DISEÑO Y DESARROLLO). Si ya está conectada, lo informa. Pasale el link al usuario para que lo abra.',
    inputSchema: { reconectar: z.boolean().optional().describe('true para generar un link nuevo aunque ya esté conectada') },
    annotations: ro,
  }, async ({ reconectar }: { reconectar?: boolean }) => {
    if (!msConfigurado()) return error('La conexión con SharePoint todavía no está configurada en el servidor.');
    if (!reconectar) {
      const { data } = await admin().from('conector_ms_tokens').select('ms_email, conectado_en').eq('user_id', c.userId).maybeSingle();
      if (data) return texto({ conectado: true, cuenta: data.ms_email, desde: data.conectado_en });
    }
    const link = `${c.basePublica}/ms/login?t=${encodeURIComponent(await firmarEstado(c.userId, c.email))}`;
    return texto({ conectado: false, link, vence_en_minutos: 15,
      instrucciones: 'Abrí el link, iniciá sesión con tu cuenta de 4housing y aceptá. Después volvé a pedir lo que necesitabas.' });
  });

  server.registerTool('sharepoint_listar', {
    title: 'SharePoint · listar carpeta',
    description: 'Lista el contenido de una carpeta dentro de "01 DISEÑO Y DESARROLLO" (nombre, tipo, tamaño, modificado). Sin ruta: la carpeta base.',
    inputSchema: { ruta: z.string().optional().describe('Carpeta relativa a 01 DISEÑO Y DESARROLLO') },
    annotations: ro,
  }, async ({ ruta }: { ruta?: string }) => {
    try {
      const g = await graph(false); if ('respuesta' in g) return g.respuesta;
      const p = rutaSegura(ruta); const it = await g.item(p);
      if (!it) return error(`No existe "${p}".`); if (!it.folder) return error(`"${p}" no es una carpeta.`);
      const r = await g.req('GET', `/drives/${g.driveId}/items/${it.id}/children?$top=200&$select=name,folder,file,size,lastModifiedDateTime,lastModifiedBy,webUrl`);
      if (!r.ok) return error(r.data?.error?.message || 'No se pudo listar.');
      return texto({ carpeta: p, link: it.webUrl, elementos: (r.data.value || []).map((x: any) => ({ nombre: x.name, tipo: x.folder ? 'carpeta' : 'archivo',
        tamano_kb: x.file ? Math.round((x.size || 0) / 1024) : undefined, elementos: x.folder?.childCount, modificado: x.lastModifiedDateTime,
        modificado_por: x.lastModifiedBy?.user?.displayName })) });
    } catch (e) { return error((e as Error).message); }
  });

  server.registerTool('sharepoint_crear_carpeta', {
    title: 'SharePoint · crear carpeta', description: 'Crea una carpeta nueva. ' + AVISO,
    inputSchema: { carpeta_padre: z.string().optional().describe('Dónde crearla (relativa a 01 DISEÑO Y DESARROLLO)'), nombre: z.string().min(1), confirmado },
    annotations: w,
  }, async ({ carpeta_padre, nombre, confirmado }: any) => {
    try {
      const g = await graph(true); if ('respuesta' in g) return g.respuesta;
      const padre = rutaSegura(carpeta_padre), n = nombreSeguro(nombre);
      const it = await g.item(padre); if (!it?.folder) return error(`La carpeta "${padre}" no existe.`);
      if (await g.item(padre + '/' + n)) return error(`Ya existe "${padre}/${n}". No se pisa.`);
      if (!confirmado) return texto({ vista_previa: true, accion: 'crear carpeta', en: padre, nombre: n, siguiente_paso: 'Si el usuario confirma, repetí con confirmado=true.' });
      const r = await g.req('POST', `/drives/${g.driveId}/items/${it.id}/children`, { name: n, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
      await registrar('crear_carpeta', null, padre + '/' + n, r.ok ? 'ok' : 'error: ' + (r.data?.error?.message || r.status));
      return r.ok ? texto({ ok: true, carpeta: padre + '/' + n, link: r.data.webUrl }) : error('SharePoint no permitió crearla: ' + (r.data?.error?.message || r.status));
    } catch (e) { return error((e as Error).message); }
  });

  server.registerTool('sharepoint_copiar', {
    title: 'SharePoint · copiar carpeta o archivo',
    description: 'Copia una carpeta completa (con todo su contenido) o un archivo a otra carpeta, opcionalmente con otro nombre. Sirve para ' +
      'armar la carpeta de un proyecto nuevo copiando la base 0000-00-00-IF-PROYECTO. Las carpetas grandes se copian en segundo plano. ' + AVISO,
    inputSchema: { origen: z.string().min(1), carpeta_destino: z.string().optional().describe('Carpeta destino (relativa); vacía = la base'),
      nombre_nuevo: z.string().optional(), confirmado },
    annotations: w,
  }, async ({ origen, carpeta_destino, nombre_nuevo, confirmado }: any) => {
    try {
      const g = await graph(true); if ('respuesta' in g) return g.respuesta;
      const o = rutaSegura(origen), d = rutaSegura(carpeta_destino);
      const io = await g.item(o); if (!io) return error(`No existe "${o}".`);
      const id = await g.item(d); if (!id?.folder) return error(`La carpeta destino "${d}" no existe.`);
      const n = nombreSeguro(nombre_nuevo || io.name);
      if (await g.item(d + '/' + n)) return error(`Ya existe "${d}/${n}". No se pisa.`);
      if (!confirmado) return texto({ vista_previa: true, accion: 'copiar', origen: o, tipo: io.folder ? `carpeta (${io.folder.childCount} elementos en el primer nivel)` : 'archivo',
        destino: d + '/' + n, siguiente_paso: 'Si el usuario confirma, repetí con confirmado=true.' });
      const r = await g.req('POST', `/drives/${g.driveId}/items/${io.id}/copy?@microsoft.graph.conflictBehavior=fail`,
        { parentReference: { driveId: g.driveId, id: id.id }, name: n });
      if (r.status !== 202 && !r.ok) { await registrar('copiar', o, d + '/' + n, 'error: ' + (r.data?.error?.message || r.status)); return error('SharePoint no permitió copiar: ' + (r.data?.error?.message || r.status)); }
      let estado = 'en curso'; const mon = r.headers.get('location');
      for (let i = 0; mon && i < 8; i++) {           // espera hasta ~16 s; si sigue, queda en segundo plano
        await new Promise(res => setTimeout(res, 2000));
        const m = await fetch(mon); const mj = await m.json().catch(() => ({}));
        if (mj.status === 'completed') { estado = 'completada'; break; }
        if (mj.status === 'failed') { estado = 'falló: ' + (mj.error?.message || ''); break; }
      }
      await registrar('copiar', o, d + '/' + n, estado.startsWith('falló') ? 'error: ' + estado : 'ok', { estado });
      return texto({ ok: !estado.startsWith('falló'), copia: d + '/' + n, estado,
        aviso: estado === 'en curso' ? 'La copia sigue en segundo plano en SharePoint; en unos minutos va a estar completa (verificá con sharepoint_listar).' : undefined });
    } catch (e) { return error((e as Error).message); }
  });

  server.registerTool('sharepoint_guardar_archivo', {
    title: 'SharePoint · guardar archivo',
    description: 'Guarda un archivo NUEVO en una carpeta (no reemplaza si ya existe). Contenido en texto (contenido_texto) o binario en base64 ' +
      '(contenido_base64, ej. un PDF). Máximo 4 MB. ' + AVISO,
    inputSchema: { carpeta: z.string().optional(), nombre: z.string().min(1).describe('Nombre con extensión, ej. "Ficha D-12.pdf"'),
      contenido_texto: z.string().optional(), contenido_base64: z.string().optional(), confirmado },
    annotations: w,
  }, async ({ carpeta, nombre, contenido_texto, contenido_base64, confirmado }: any) => {
    try {
      if ((contenido_texto == null) === (contenido_base64 == null)) return error('Mandá contenido_texto O contenido_base64 (uno solo).');
      const bytes = contenido_texto != null ? te.encode(contenido_texto) : Uint8Array.from(atob(contenido_base64), (ch: string) => ch.charCodeAt(0));
      if (bytes.length > MAX_SUBIDA) return error(`El archivo pesa ${Math.round(bytes.length / 1024)} KB; el máximo por esta vía es 4 MB. Para archivos grandes, subilo directo a SharePoint.`);
      const g = await graph(true); if ('respuesta' in g) return g.respuesta;
      const d = rutaSegura(carpeta), n = nombreSeguro(nombre);
      const id = await g.item(d); if (!id?.folder) return error(`La carpeta "${d}" no existe.`);
      if (await g.item(d + '/' + n)) return error(`Ya existe "${d}/${n}". No se pisa: elegí otro nombre.`);
      if (!confirmado) return texto({ vista_previa: true, accion: 'guardar archivo', destino: d + '/' + n, tamano_kb: Math.round(bytes.length / 1024),
        siguiente_paso: 'Si el usuario confirma, repetí con confirmado=true.' });
      const r = await g.req('PUT', `/drives/${g.driveId}/items/${id.id}:/${encodeURIComponent(n)}:/content?@microsoft.graph.conflictBehavior=fail`, bytes,
        { 'content-type': 'application/octet-stream' });
      await registrar('guardar_archivo', null, d + '/' + n, r.ok ? 'ok' : 'error: ' + (r.data?.error?.message || r.status), { bytes: bytes.length });
      return r.ok ? texto({ ok: true, archivo: d + '/' + n, link: r.data.webUrl }) : error('SharePoint no permitió guardarlo: ' + (r.data?.error?.message || r.status));
    } catch (e) { return error((e as Error).message); }
  });

  server.registerTool('sharepoint_mover', {
    title: 'SharePoint · mover o renombrar',
    description: 'Mueve un archivo o carpeta a otra carpeta y/o le cambia el nombre (ej. pasar una ficha de "00-A APROBAR" a la carpeta ' +
      'principal del mazo). No pisa si en el destino ya hay algo con ese nombre. ' + AVISO,
    inputSchema: { origen: z.string().min(1), carpeta_destino: z.string().optional().describe('Nueva carpeta (vacía = la misma)'),
      nombre_nuevo: z.string().optional(), confirmado },
    annotations: w,
  }, async ({ origen, carpeta_destino, nombre_nuevo, confirmado }: any) => {
    try {
      if (!carpeta_destino && !nombre_nuevo) return error('Indicá carpeta_destino y/o nombre_nuevo.');
      const g = await graph(true); if ('respuesta' in g) return g.respuesta;
      const o = rutaSegura(origen); const io = await g.item(o); if (!io) return error(`No existe "${o}".`);
      if (o === BASE) return error('No se puede mover la carpeta base.');
      const padreActual = o.split('/').slice(0, -1).join('/');
      const d = carpeta_destino ? rutaSegura(carpeta_destino) : padreActual;
      const id = await g.item(d); if (!id?.folder) return error(`La carpeta destino "${d}" no existe.`);
      if (io.folder && (d + '/').startsWith(o + '/')) return error('No se puede mover una carpeta dentro de sí misma.');
      const n = nombreSeguro(nombre_nuevo || io.name);
      if (d === padreActual && n === io.name) return error('El destino es igual al origen: no hay nada que cambiar.');
      if (await g.item(d + '/' + n)) return error(`Ya existe "${d}/${n}". No se pisa.`);
      if (!confirmado) return texto({ vista_previa: true, accion: d === padreActual ? 'renombrar' : 'mover', origen: o, destino: d + '/' + n,
        siguiente_paso: 'Si el usuario confirma, repetí con confirmado=true.' });
      const r = await g.req('PATCH', `/drives/${g.driveId}/items/${io.id}`, { parentReference: { id: id.id }, name: n, '@microsoft.graph.conflictBehavior': 'fail' });
      await registrar('mover', o, d + '/' + n, r.ok ? 'ok' : 'error: ' + (r.data?.error?.message || r.status));
      return r.ok ? texto({ ok: true, ahora_en: d + '/' + n, link: r.data.webUrl }) : error('SharePoint no permitió moverlo: ' + (r.data?.error?.message || r.status));
    } catch (e) { return error((e as Error).message); }
  });
}

// Para pruebas
export const _test = { cifrar, descifrar, verificarEstado, dentroDeBase };
