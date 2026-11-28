// ============================================================================
// Conector 4housing Apps · ifc_procesar — procesar un IFC puntual, a demanda
// ----------------------------------------------------------------------------
// 1. Verifica que la persona edite Diseño y que el archivo sea un .ifc de
//    */10-BIM/** o */00-Estudios particulares/01-Estudio de proyecto/** (sin
//    carpetas "superado", "old" o "backup").
// 2. Lo busca en SharePoint CON LA CUENTA MICROSOFT DE LA PERSONA (sharepoint.ts)
//    y obtiene su versión (eTag) y un link de descarga temporal (~1 h).
// 3. Registra esa versión en diseno_ifc_modelos (service role: la tabla no se
//    escribe por la API) y marca las versiones anteriores como no vigentes.
// 4. Lanza el workflow "Procesar IFC" de 4housing/ifc-procesador (secreto
//    GITHUB_IFC_TOKEN: token de grano fino, solo Actions de ese repo).
// El procesador carga los elementos vía ifc-ingesta y deja el modelo en 'ok'.
// ============================================================================

// deno-lint-ignore-file no-explicit-any
import { z } from 'npm:zod@4.1.13';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { graphDe, rutaSegura, BASE } from './sharepoint.ts';

const REPO = '4housing/ifc-procesador';
const WORKFLOW = 'procesar.yml';
const EXCLUIR = /\b(superado|old|backup)\b/i;   // por palabra: "Golden" no se excluye

/** Clasifica la ruta (relativa a la carpeta base o con ella). null = no permitida. */
export function clasificarRuta(ruta: string): { carpeta: 'bim' | 'estudio'; nroIf: string | null } | { motivo: string } {
  const partes = ruta.split('/');
  const archivo = partes[partes.length - 1] || '';
  if (!/\.ifc$/i.test(archivo)) return { motivo: 'Solo se procesan archivos .ifc.' };
  const carpetas = partes.slice(0, -1);
  const iBim = carpetas.findIndex((c) => /^10-BIM$/i.test(c.trim()));
  const iEst = carpetas.findIndex((c, i) => /^00-Estudios particulares$/i.test(c.trim()) && /^01-Estudio de proyecto$/i.test((carpetas[i + 1] || '').trim()));
  if (iBim < 0 && iEst < 0) return { motivo: 'El archivo tiene que estar en una carpeta 10-BIM o en 00-Estudios particulares/01-Estudio de proyecto (o sus subcarpetas).' };
  const desde = iBim >= 0 ? iBim : iEst + 1;
  if (carpetas.slice(desde + 1).some((c) => EXCLUIR.test(c))) return { motivo: 'Las carpetas con "superado", "old" o "backup" en el nombre no se procesan.' };
  const m = ruta.match(/IF\s*-?\s*(\d{3,})/i);
  return { carpeta: iBim >= 0 ? 'bim' : 'estudio', nroIf: m ? 'IF' + m[1] : null };
}

/** Lanza el workflow. Devuelve null si salió bien, o el error. */
export async function lanzarWorkflow(token: string, inputs: Record<string, string>, fetcher: typeof fetch = fetch): Promise<string | null> {
  const r = await fetcher(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (r.status === 204) return null;
  return `GitHub respondió ${r.status}: ${(await r.text()).slice(0, 300)}`;
}

export interface CtxProc { sb: SupabaseClient; userId: string; texto: (o: unknown) => any; error: (m: string) => any; }

export function registrarIFCProcesar(server: any, c: CtxProc) {
  const { sb, texto, error } = c;
  const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  server.registerTool('ifc_procesar', {
    title: 'Diseño · procesar un IFC',
    description: 'Procesa un modelo IFC puntual de SharePoint (Gerencia de Producción · 01 DISEÑO Y DESARROLLO), para poder buscar ' +
      'elementos e interferencias con ifc_buscar / ifc_interferencias. Solo archivos .ifc de una carpeta 10-BIM o de ' +
      '00-Estudios particulares/01-Estudio de proyecto (y subcarpetas, salvo "superado"/"old"/"backup"). Usa la cuenta Microsoft ' +
      'de la persona (si no la conectó, usá sharepoint_conectar). Tarda unos 5-10 minutos; el estado se ve con ifc_modelos. ' +
      'Primero llamala SIN confirmado (vista previa) y pedile confirmación al usuario; con su OK repetí con confirmado=true. ' +
      'Solo quien edita Diseño.',
    inputSchema: {
      ruta: z.string().min(1).describe('Ruta del .ifc relativa a 01 DISEÑO Y DESARROLLO (ej. "03- PROYECTOS/…/10-BIM/COORD/0 - SIDE.ifc"). Se puede ubicar con sharepoint_listar.'),
      reprocesar: z.boolean().optional().describe('true = volver a procesar aunque esa misma versión ya esté procesada'),
      confirmado: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ ruta, reprocesar, confirmado }: { ruta: string; reprocesar?: boolean; confirmado?: boolean }) => {
    try {
      const { data: puede } = await sb.rpc('puede_editar_sector', { s: 'diseno' });
      if (puede !== true) return error('Solo quien edita Diseño puede procesar modelos IFC.');
      const token = Deno.env.get('GITHUB_IFC_TOKEN');
      if (!token) return error('Falta configurar el acceso a GitHub en el servidor (secreto GITHUB_IFC_TOKEN).');

      const completa = rutaSegura(ruta);                    // valida y deja la ruta dentro de la carpeta base
      const rel = completa.slice(BASE.length + 1);
      const cl = clasificarRuta(rel);
      if ('motivo' in cl) return error(cl.motivo);

      const g = await graphDe(c.userId);
      if (!g) return error('Todavía no conectaste tu cuenta Microsoft. Usá sharepoint_conectar y abrí el link.');
      const it = await g.itemConDescarga(completa);
      if (!it) return error(`No existe "${completa}".`);
      if (!it.file) return error(`"${completa}" no es un archivo.`);
      const url = it['@microsoft.graph.downloadUrl'];
      if (!url) return error('SharePoint no dio el link de descarga del archivo.');
      const version = String(it.eTag || it.cTag || it.lastModifiedDateTime);

      const db = admin();
      const { data: previa } = await db.from('diseno_ifc_modelos').select('id, estado, procesado_en, creado_en')
        .eq('sp_item_id', it.id).eq('sp_version', version).maybeSingle();
      if (previa?.estado === 'ok' && !reprocesar) {
        return texto({ ya_procesada: true, modelo_id: previa.id, procesado_en: previa.procesado_en,
          aviso: 'Esta versión del archivo ya está procesada. Para volver a procesarla, repetí con reprocesar=true.' });
      }
      if (previa && ['pendiente', 'procesando'].includes(previa.estado) && Date.now() - Date.parse(previa.creado_en) < 60 * 60 * 1000) {
        return texto({ en_curso: true, modelo_id: previa.id, estado: previa.estado, aviso: 'Esta versión ya se está procesando. Consultá ifc_modelos en unos minutos.' });
      }
      if (!confirmado) {
        return texto({ vista_previa: true, accion: previa ? 'reprocesar' : 'procesar', archivo: it.name, ruta: rel, carpeta: cl.carpeta,
          proyecto_if: cl.nroIf, tamano_mb: Math.round((it.size || 0) / 1e5) / 10, modificado: it.lastModifiedDateTime,
          modificado_por: it.lastModifiedBy?.user?.displayName ?? null, demora_estimada: '5 a 10 minutos',
          siguiente_paso: 'Si el usuario confirma, repetí con confirmado=true.' });
      }

      let modeloId: number;
      if (previa) {
        const { error: e } = await db.from('diseno_ifc_modelos').update({ estado: 'pendiente', error: null, origen: 'claude',
          solicitado_por: c.userId, solicitado_en: new Date().toISOString() }).eq('id', previa.id);
        if (e) return error('No se pudo registrar: ' + e.message);
        modeloId = previa.id;
      } else {
        let proyectoId: string | null = null;
        if (cl.nroIf) {
          const { data: ps } = await db.from('diseno_proyectos').select('id, nro_if');
          proyectoId = (ps || []).find((p: any) => String(p.nro_if || '').replace(/\s|-/g, '').toUpperCase() === cl.nroIf)?.id ?? null;
        }
        await db.from('diseno_ifc_modelos').update({ vigente: false }).eq('sp_item_id', it.id);
        const { data: nuevo, error: e } = await db.from('diseno_ifc_modelos').insert({
          proyecto_id: proyectoId, nro_if: cl.nroIf, carpeta: cl.carpeta, ruta: rel, archivo: it.name,
          sp_item_id: it.id, sp_version: version, sp_modificado_en: it.lastModifiedDateTime ?? null,
          sp_modificado_por: it.lastModifiedBy?.user?.displayName ?? null, tamano_bytes: it.size ?? null,
          vigente: true, origen: 'claude', estado: 'pendiente', solicitado_por: c.userId, solicitado_en: new Date().toISOString(),
        }).select('id').single();
        if (e || !nuevo) return error('No se pudo registrar: ' + (e?.message || 'sin id'));
        modeloId = nuevo.id;
      }

      const fallo = await lanzarWorkflow(token, { url, modelo_id: String(modeloId), archivo: it.name });
      if (fallo) {
        await db.from('diseno_ifc_modelos').update({ estado: 'error', error: 'No se pudo lanzar el proceso: ' + fallo }).eq('id', modeloId);
        return error('No se pudo lanzar el proceso en GitHub: ' + fallo);
      }
      return texto({ ok: true, modelo_id: modeloId, estado: 'pendiente', archivo: it.name,
        aviso: 'Procesando: en 5 a 10 minutos queda listo. Consultá el estado con ifc_modelos; después usá ifc_buscar / ifc_interferencias con este modelo_id.' });
    } catch (e) { return error((e as Error).message); }
  });
}
