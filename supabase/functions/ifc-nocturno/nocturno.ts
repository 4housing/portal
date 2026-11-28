// ============================================================================
// ifc-nocturno — revisión nocturna de modelos IFC (Diseño)
// ----------------------------------------------------------------------------
// La llama pg_cron todas las noches a las 2:00 (sql/diseno/171) con la clave del
// Vault (header x-ifc-nocturno; se valida con ifc_nocturno_token_valido()).
// Responde enseguida (202) y trabaja en segundo plano:
//   1. Entra a SharePoint con permiso de APLICACIÓN de solo lectura limitado al
//      sitio Gerencia de Producción (Sites.Selected), con la app de Entra del
//      conector (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET).
//   2. En "01 DISEÑO Y DESARROLLO" busca las carpetas de proyecto (nombre con
//      "IF nnnn", hasta 2 niveles) y dentro de ellas 10-BIM y
//      00-Estudios particulares/01-Estudio de proyecto (con subcarpetas, sin
//      "superado"/"old"/"backup").
//   3. Cada .ifc modificado en las últimas `horas` (26) cuya versión (eTag) no
//      esté registrada → la registra (origen 'nocturno', las anteriores quedan no
//      vigentes) y lanza "Procesar IFC" en GitHub (GITHUB_IFC_TOKEN). Tope: `max`
//      archivos por noche (20). Solo se procesa la ÚLTIMA versión del día: las
//      exportaciones intermedias no.
//   4. Deja lo hecho en diseno_ifc_nocturno_log.
// Body opcional: {"solo_mirar": true} (no registra ni lanza), {"horas": n}, {"max": n}.
// clasificarRuta / lanzarWorkflow: COPIA de conector-4housing/ifc_procesar.ts
// (si cambian las reglas de carpetas, cambiar en los dos).
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import 'jsr:@supabase/functions-js@2/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const SITIO = '4housing22.sharepoint.com:/sites/GerenciadeProduccion2';
const BIBLIOTECA = 'Documentos compartidos';
const BASE = '01 DISEÑO Y DESARROLLO';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const REPO = '4housing/ifc-procesador';
const EXCLUIR = /\b(superado|old|backup)\b/i;
const ES_PROYECTO = /IF\s*-?\s*\d{3,}/i;

// ---- Reglas de carpetas (copia de conector-4housing/ifc_procesar.ts) ----
export function clasificarRuta(ruta: string): { carpeta: 'bim' | 'estudio'; nroIf: string | null } | { motivo: string } {
  const partes = ruta.split('/');
  const archivo = partes[partes.length - 1] || '';
  if (!/\.ifc$/i.test(archivo)) return { motivo: 'no es .ifc' };
  const carpetas = partes.slice(0, -1);
  const iBim = carpetas.findIndex((c) => /^10-BIM$/i.test(c.trim()));
  const iEst = carpetas.findIndex((c, i) => /^00-Estudios particulares$/i.test(c.trim()) && /^01-Estudio de proyecto$/i.test((carpetas[i + 1] || '').trim()));
  if (iBim < 0 && iEst < 0) return { motivo: 'fuera de 10-BIM / Estudio de proyecto' };
  const desde = iBim >= 0 ? iBim : iEst + 1;
  if (carpetas.slice(desde + 1).some((c) => EXCLUIR.test(c))) return { motivo: 'carpeta superado/old/backup' };
  const m = ruta.match(/IF\s*-?\s*(\d{3,})/i);
  return { carpeta: iBim >= 0 ? 'bim' : 'estudio', nroIf: m ? 'IF' + m[1] : null };
}
export async function lanzarWorkflow(token: string, inputs: Record<string, string>, fetcher: typeof fetch = fetch): Promise<string | null> {
  const r = await fetcher(`https://api.github.com/repos/${REPO}/actions/workflows/procesar.yml/dispatches`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (r.status === 204) return null;
  return `GitHub respondió ${r.status}: ${(await r.text()).slice(0, 300)}`;
}

/** Ruta relativa a la carpeta base, a partir de parentReference.path + nombre. */
export function rutaRelativa(item: any): string | null {
  const pr = decodeURIComponent(String(item?.parentReference?.path || '')).normalize('NFC');
  const m = pr.match(/root:(.*)$/); if (!m) return null;
  const completo = (m[1] + '/' + item.name).replace(/^\/+/, '');
  return completo.startsWith(BASE + '/') ? completo.slice(BASE.length + 1) : null;
}

// ---- Graph con permiso de aplicación ----
export interface Deps {
  fetch: typeof fetch;
  env: (k: string) => string;
  db: () => any;
  ahora: () => number;
  enSegundoPlano: (p: Promise<unknown>) => void;
}

async function tokenApp(d: Deps) {
  const r = await d.fetch(`https://login.microsoftonline.com/${d.env('MS_TENANT_ID')}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: d.env('MS_CLIENT_ID'), client_secret: d.env('MS_CLIENT_SECRET'),
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Microsoft no dio acceso a la aplicación: ' + (j.error_description || j.error || r.status));
  return j.access_token as string;
}

function graph(d: Deps, token: string) {
  let llamadas = 0;
  const get = async (ruta: string) => {
    llamadas++;
    const r = await d.fetch(ruta.startsWith('http') ? ruta : GRAPH + ruta, { headers: { authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data: j };
  };
  const hijos = async (driveId: string, itemId: string) => {
    const out: any[] = [];
    let url = `/drives/${driveId}/items/${itemId}/children?$top=200&$select=id,name,folder,file,size,eTag,lastModifiedDateTime,lastModifiedBy,parentReference`;
    for (let i = 0; url && i < 50; i++) {
      const r = await get(url);
      if (!r.ok) throw new Error(`Graph ${r.status}: ${r.data?.error?.message || ''}`);
      out.push(...(r.data.value || []));
      url = r.data['@odata.nextLink'] || '';
    }
    return out;
  };
  return { get, hijos, llamadas: () => llamadas };
}

const enc = (ruta: string) => ruta.split('/').map(encodeURIComponent).join('/');

export async function revisar(d: Deps, logId: number, o: { soloMirar: boolean; horas: number; max: number }) {
  const db = d.db();
  const det: any[] = [];
  const res = { carpetas: 0, ifc_vistos: 0, modificados: 0, lanzados: 0 };
  let errorGeneral: string | null = null;
  try {
    const gh = d.env('GITHUB_IFC_TOKEN');
    if (!gh && !o.soloMirar) throw new Error('Falta el secreto GITHUB_IFC_TOKEN.');
    const g = graph(d, await tokenApp(d));
    const s = await g.get(`/sites/${SITIO}?$select=id`);
    if (!s.ok) throw new Error(`No se pudo abrir el sitio (${s.status}): ${s.data?.error?.message || ''}. ¿Se dio el permiso Sites.Selected de lectura sobre el sitio?`);
    const dr = await g.get(`/sites/${s.data.id}/drives?$select=id,name,webUrl`);
    const drive = (dr.data?.value || []).find((x: any) => x.name === BIBLIOTECA || decodeURIComponent(String(x.webUrl || '')).endsWith('/' + BIBLIOTECA));
    if (!drive) throw new Error(`No encontré la biblioteca "${BIBLIOTECA}".`);
    const base = await g.get(`/drives/${drive.id}/root:/${enc(BASE)}?$select=id,name`);
    if (!base.ok) throw new Error(`No encontré "${BASE}" (${base.status}).`);

    // Carpetas de proyecto: nombre con "IF nnnn", en el nivel 1 o 2 debajo de la base.
    const proyectos: any[] = [];
    for (const n1 of (await g.hijos(drive.id, base.data.id)).filter((x) => x.folder)) {
      if (ES_PROYECTO.test(n1.name)) { proyectos.push(n1); continue; }
      for (const n2 of (await g.hijos(drive.id, n1.id)).filter((x) => x.folder)) if (ES_PROYECTO.test(n2.name)) proyectos.push(n2);
    }
    // Dentro de cada proyecto (hasta 2 niveles): 10-BIM y 00-Estudios particulares/01-Estudio de proyecto.
    const raices: any[] = [];
    for (const p of proyectos) {
      const buscar = async (carpeta: any, nivel: number) => {
        for (const h of (await g.hijos(drive.id, carpeta.id)).filter((x) => x.folder)) {
          if (/^10-BIM$/i.test(h.name.trim())) raices.push(h);
          else if (/^00-Estudios particulares$/i.test(h.name.trim())) {
            const est = (await g.hijos(drive.id, h.id)).find((x) => x.folder && /^01-Estudio de proyecto$/i.test(x.name.trim()));
            if (est) raices.push(est);
          } else if (nivel < 2 && !EXCLUIR.test(h.name)) await buscar(h, nivel + 1);
        }
      };
      await buscar(p, 1);
    }
    res.carpetas = raices.length;

    // Recorrer cada raíz (con subcarpetas, salvo superado/old/backup) y juntar los .ifc.
    const ifcs: any[] = [];
    const recorrer = async (carpeta: any, prof: number) => {
      for (const h of await g.hijos(drive.id, carpeta.id)) {
        if (h.folder) { if (!EXCLUIR.test(h.name) && prof < 6) await recorrer(h, prof + 1); }
        else if (/\.ifc$/i.test(h.name)) ifcs.push(h);
      }
    };
    for (const r of raices) await recorrer(r, 0);
    res.ifc_vistos = ifcs.length;

    const desde = d.ahora() - o.horas * 3600 * 1000;
    const recientes = ifcs.filter((f) => Date.parse(f.lastModifiedDateTime) >= desde)
      .sort((a, b) => Date.parse(a.lastModifiedDateTime) - Date.parse(b.lastModifiedDateTime));
    res.modificados = recientes.length;

    const { data: proys } = await db.from('diseno_proyectos').select('id, nro_if');
    for (const f of recientes) {
      const rel = rutaRelativa(f);
      const cl = rel ? clasificarRuta(rel) : { motivo: 'ruta fuera de la carpeta base' };
      if (!rel || 'motivo' in cl) { det.push({ archivo: f.name, ruta: rel, salteado: (cl as any).motivo }); continue; }
      const version = String(f.eTag || f.lastModifiedDateTime);
      const { data: ya } = await db.from('diseno_ifc_modelos').select('id, estado').eq('sp_item_id', f.id).eq('sp_version', version).maybeSingle();
      if (ya) { det.push({ archivo: f.name, ruta: rel, salteado: `esa versión ya está registrada (modelo ${ya.id}, ${ya.estado})` }); continue; }
      if (res.lanzados >= o.max) { det.push({ archivo: f.name, ruta: rel, salteado: `tope de ${o.max} por noche` }); continue; }
      if (o.soloMirar) { det.push({ archivo: f.name, ruta: rel, se_procesaria: true, modificado: f.lastModifiedDateTime }); continue; }

      const it = await g.get(`/drives/${drive.id}/items/${f.id}`);
      const url = it.data?.['@microsoft.graph.downloadUrl'];
      if (!url) { det.push({ archivo: f.name, ruta: rel, error: 'SharePoint no dio el link de descarga' }); continue; }
      const proyectoId = cl.nroIf ? ((proys || []).find((p: any) => String(p.nro_if || '').replace(/\s|-/g, '').toUpperCase() === cl.nroIf)?.id ?? null) : null;
      await db.from('diseno_ifc_modelos').update({ vigente: false }).eq('sp_item_id', f.id);
      const { data: nuevo, error: e } = await db.from('diseno_ifc_modelos').insert({
        proyecto_id: proyectoId, nro_if: cl.nroIf, carpeta: cl.carpeta, ruta: rel, archivo: f.name,
        sp_item_id: f.id, sp_version: version, sp_modificado_en: f.lastModifiedDateTime ?? null,
        sp_modificado_por: f.lastModifiedBy?.user?.displayName ?? null, tamano_bytes: f.size ?? null,
        vigente: true, origen: 'nocturno', estado: 'pendiente',
      }).select('id').single();
      if (e || !nuevo) { det.push({ archivo: f.name, ruta: rel, error: 'no se pudo registrar: ' + (e?.message || '') }); continue; }
      const fallo = await lanzarWorkflow(gh, { url, modelo_id: String(nuevo.id), archivo: f.name }, d.fetch);
      if (fallo) {
        await db.from('diseno_ifc_modelos').update({ estado: 'error', error: 'No se pudo lanzar el proceso: ' + fallo }).eq('id', nuevo.id);
        det.push({ archivo: f.name, ruta: rel, modelo_id: nuevo.id, error: fallo });
        continue;
      }
      res.lanzados++;
      det.push({ archivo: f.name, ruta: rel, modelo_id: nuevo.id, lanzado: true });
    }
    det.push({ llamadas_graph: g.llamadas(), proyectos: proyectos.length });
  } catch (e) {
    errorGeneral = (e as Error).message;
  }
  await db.from('diseno_ifc_nocturno_log').update({ ...res, detalle: det, error: errorGeneral,
    terminado_en: new Date(d.ahora()).toISOString() }).eq('id', logId);
  return { ...res, error: errorGeneral, detalle: det };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export async function manejar(req: Request, deps?: Partial<Deps>) {
  const d: Deps = {
    fetch: deps?.fetch ?? fetch,
    env: deps?.env ?? ((k: string) => Deno.env.get(k) || ''),
    db: deps?.db ?? (() => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })),
    ahora: deps?.ahora ?? (() => Date.now()),
    enSegundoPlano: deps?.enSegundoPlano ?? ((p) => (globalThis as any).EdgeRuntime?.waitUntil ? (globalThis as any).EdgeRuntime.waitUntil(p) : p),
  };
  if (req.method !== 'POST') return json({ error: 'solo POST' }, 405);
  const db = d.db();
  const { data: valido } = await db.rpc('ifc_nocturno_token_valido', { t: req.headers.get('x-ifc-nocturno') || '' });
  if (valido !== true) return json({ error: 'no autorizado' }, 401);
  const b = await req.json().catch(() => ({}));
  const o = { soloMirar: b?.solo_mirar === true, horas: Math.min(Math.max(Number(b?.horas) || 26, 1), 24 * 14),
    max: Math.min(Math.max(Number(b?.max) || 20, 1), 50) };
  const { data: log, error } = await db.from('diseno_ifc_nocturno_log').insert({ detalle: { solo_mirar: o.soloMirar, horas: o.horas } }).select('id').single();
  if (error || !log) return json({ error: 'no se pudo crear el registro: ' + (error?.message || '') }, 500);
  d.enSegundoPlano(revisar(d, log.id, o));
  return json({ ok: true, log_id: log.id, aviso: 'Revisando en segundo plano; el resultado queda en diseno_ifc_nocturno_log.' }, 202);
}
