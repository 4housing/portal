// ============================================================================
// ifc-ingesta (lógica) — recibe los resultados del procesador IFC (GitHub Actions)
// ----------------------------------------------------------------------------
// Lo llama SOLO el workflow "Procesar IFC" de 4housing/ifc-procesador (rama main).
// Sin secretos compartidos: cada pedido trae el token OIDC que GitHub emite para
// esa corrida; acá se verifica la firma (claves públicas de GitHub) y que sea ese
// repo, ese workflow y la rama main. Cualquier otro pedido → 401.
//
// Escribe con la service role SOLO en diseno_ifc_modelos (estado/resultado) y
// diseno_ifc_elementos (filas del modelo). Ver portal/sql/diseno/170_ifc_modelos.sql.
//
//   POST /ifc-ingesta/inicio    {modelo_id, run_url}           → estado 'procesando'
//   POST /ifc-ingesta/elementos {modelo_id, filas:[…≤1000]}     → upsert de elementos
//   POST /ifc-ingesta/fin       {modelo_id, ok, resumen?, error?} → 'ok' (limpia versiones
//                                                                  anteriores, trigger) o 'error'
//
// Deploy: verify_jwt = false (el token no es de Supabase; lo valida este código).
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6';

export const EMISOR = 'https://token.actions.githubusercontent.com';
export const AUDIENCIA = 'https://wcpkpwxhqdcdljfwzcmy.supabase.co/functions/v1/ifc-ingesta';
export const REPO = '4housing/ifc-procesador';
export const WORKFLOW_REF = '4housing/ifc-procesador/.github/workflows/procesar.yml@refs/heads/main';
const MAX_FILAS = 1000;
const COLS = ['global_id', 'clase', 'nombre', 'familia', 'tipo', 'nivel', 'material', 'parametros',
  'min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z'] as const;

const jwks = createRemoteJWKSet(new URL(`${EMISOR}/.well-known/jwks`));

/** Verifica el token OIDC de GitHub. Devuelve los claims o lanza error. */
export async function verificarGitHub(token: string, claves: any = jwks) {
  const { payload } = await jwtVerify(token, claves, { issuer: EMISOR, audience: AUDIENCIA });
  const p = payload as Record<string, any>;
  if (p.repository !== REPO) throw new Error('repositorio no autorizado');
  if (p.ref !== 'refs/heads/main') throw new Error('solo rama main');
  if (p.job_workflow_ref !== WORKFLOW_REF && p.workflow_ref !== WORKFLOW_REF) throw new Error('workflow no autorizado');
  return p;
}

/** Deja solo las columnas de diseno_ifc_elementos y tipos razonables. */
export function limpiarFila(f: any, modeloId: number) {
  if (!f || typeof f !== 'object') throw new Error('fila inválida');
  const gid = String(f.global_id || '');
  if (!/^[0-9A-Za-z_$]{22}$/.test(gid)) throw new Error(`GlobalId inválido: ${gid.slice(0, 30)}`);
  const out: Record<string, unknown> = { modelo_id: modeloId };
  for (const c of COLS) {
    const v = f[c];
    if (v === undefined || v === null) { out[c] = null; continue; }
    if (c.startsWith('min_') || c.startsWith('max_')) out[c] = Number.isFinite(+v) ? +v : null;
    else if (c === 'parametros') out[c] = typeof v === 'object' ? v : null;
    else out[c] = String(v).slice(0, 500);
  }
  if (!out.clase) throw new Error('falta clase');
  return out;
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export async function manejar(req: Request, deps = {
  verificar: verificarGitHub,
  db: () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }),
}) {
  if (req.method !== 'POST') return json({ error: 'solo POST' }, 405);
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: 'falta token' }, 401);
  try { await deps.verificar(m[1].trim()); } catch (e) { return json({ error: 'token no válido: ' + (e as Error).message }, 401); }

  const accion = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
  const modeloId = Number(body?.modelo_id);
  if (!Number.isInteger(modeloId) || modeloId <= 0) return json({ error: 'modelo_id inválido' }, 400);

  const db = deps.db();
  const { data: mod, error: e0 } = await db.from('diseno_ifc_modelos').select('id, estado').eq('id', modeloId).maybeSingle();
  if (e0) return json({ error: e0.message }, 500);
  if (!mod) return json({ error: 'modelo inexistente' }, 404);

  if (accion === 'inicio') {
    if (!['pendiente', 'procesando', 'error', 'ok'].includes(mod.estado)) return json({ error: 'estado no válido' }, 409);
    // Reproceso de la MISMA versión: se reemplazan sus propios elementos (las otras versiones no se tocan).
    const { error: e1 } = await db.from('diseno_ifc_elementos').delete().eq('modelo_id', modeloId);
    if (e1) return json({ error: e1.message }, 500);
    const run = String(body.run_url || '').startsWith('https://github.com/' + REPO + '/') ? body.run_url : null;
    const { error: e2 } = await db.from('diseno_ifc_modelos').update({ estado: 'procesando', error: null, run_url: run }).eq('id', modeloId);
    if (e2) return json({ error: e2.message }, 500);
    return json({ ok: true });
  }

  if (mod.estado !== 'procesando') return json({ error: `el modelo está en '${mod.estado}', no en 'procesando'` }, 409);

  if (accion === 'elementos') {
    const filas = Array.isArray(body.filas) ? body.filas : null;
    if (!filas || !filas.length || filas.length > MAX_FILAS) return json({ error: `filas: entre 1 y ${MAX_FILAS}` }, 400);
    let limpias;
    try { limpias = filas.map((f: any) => limpiarFila(f, modeloId)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    const { error } = await db.from('diseno_ifc_elementos').upsert(limpias, { onConflict: 'modelo_id,global_id' });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, filas: limpias.length });
  }

  if (accion === 'fin') {
    const r = body.resumen || {};
    const upd: Record<string, unknown> = { procesado_en: new Date().toISOString() };
    if (body.ok === true) {
      const { count, error: ec } = await db.from('diseno_ifc_elementos').select('global_id', { count: 'exact', head: true }).eq('modelo_id', modeloId);
      if (ec) return json({ error: ec.message }, 500);
      Object.assign(upd, { estado: 'ok', error: null, cant_elementos: count ?? null,
        schema_ifc: r.schema_ifc ? String(r.schema_ifc).slice(0, 20) : null,
        duracion_s: Number.isFinite(+r?.segundos?.total) ? Math.round(+r.segundos.total) : null });
    } else {
      Object.assign(upd, { estado: 'error', error: String(body.error || 'error sin detalle').slice(0, 2000) });
    }
    const { error } = await db.from('diseno_ifc_modelos').update(upd).eq('id', modeloId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, estado: upd.estado, cant_elementos: upd.cant_elementos ?? null });
  }

  return json({ error: 'acción desconocida (inicio | elementos | fin)' }, 404);
}

