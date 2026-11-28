# Conector 4housing Apps (servidor MCP)

Edge Function del proyecto Supabase unificado (`wcpkpwxhqdcdljfwzcmy`) que deja consultar las apps
del portal desde Claude **con los permisos de cada usuario**.

- **Login:** Supabase Auth como servidor OAuth 2.1. La aprobación la hace `portal/oauth/consent/`.
- **Permisos:** cada consulta va con el token del usuario (nunca service key): aplica la RLS existente
  (`tiene_sector`, `puede_editar_sector`, `compras_flag`). Quien no tiene el sector no ve nada.
- **Alcance (v5):** lo de v3 + SharePoint (v4) + modelos IFC (v5, `ifc.ts`).
- **Alcance (v3):** todas las apps del portal, con los permisos de cada usuario: listar tablas, SQL de
  solo lectura, y altas/modificaciones/bajas con vista previa + confirmación. Más las herramientas de
  Compras (foto económica y financiera).

| Herramienta | Qué devuelve |
| --- | --- |
| `compras_listar_proyectos` | Proyectos de Gestión de Proyectos (id, código, nombre). |
| `compras_resumen_proyecto` | Foto **económica**: presupuesto vs comprado (OC de Tango + OGs), avance, saldo, extracosto, ahorro, sin clasificar y detalle por rubro. No incluye la foto financiera. |
| `compras_financiero_proyecto` | Foto **financiera**: por OG, certificado, liberado, pendiente de certificar, pagado, pendiente de pago y OP armadas (OGs compartidas: solo los renglones de la obra), totales en pesos; OC de Tango: facturado y pendiente de facturar. |
| `listar_tablas` | Tablas/vistas de las apps que el usuario tiene (por sector), con columnas. Función SQL `conector_tablas()`. |
| `consulta_sql` | Un `SELECT` libre, **como el usuario** (RLS) y en transacción **de solo lectura** (GET); 15 s y hasta 2000 filas. Función SQL `conector_consulta_sql()` (`sql/101`). |
| `insertar` / `actualizar` / `eliminar` | Escritura con los permisos del usuario. Sin `confirmado=true` solo devuelve la vista previa. Filtros obligatorios para modificar/borrar; máximo 50 filas por vez. |
| `sharepoint_conectar` | Link para conectar (una vez) la cuenta Microsoft de la persona. Debe ser la misma persona que la cuenta del portal. |
| `sharepoint_listar` / `_crear_carpeta` / `_copiar` / `_guardar_archivo` / `_mover` | SharePoint de Gerencia de Producción, **solo dentro de `Documentos compartidos/01 DISEÑO Y DESARROLLO`**, como la persona (Graph delegado). Sin borrar, sin pisar archivos, vista previa + `confirmado=true`, solo editores de Diseño. Registro en `diseno_sharepoint_log`. |
| `ifc_modelos` | Modelos IFC procesados (10-BIM y Estudio de proyecto): estado, versión vigente, congelada, cantidad de elementos. |
| `ifc_buscar` | Elementos de un modelo con filtros (clase, familia/tipo de Revit, nivel, material, texto, parámetro) o conteos agrupados. |
| `ifc_interferencias` | Cruces o contactos entre grupos de elementos (en un modelo o entre dos), con tolerancia en mm. **Aproximado por cajas envolventes.** |
| `ifc_procesar` | Procesa un .ifc puntual (10-BIM o Estudio de proyecto) con la cuenta Microsoft de la persona: registra la versión y lanza "Procesar IFC" en GitHub (secreto `GITHUB_IFC_TOKEN`, solo Actions de 4housing/ifc-procesador). Solo editores de Diseño. |
| `ifc_congelar` | Marca/desmarca la versión congelada (vista previa + `confirmado=true`; solo coordinación, lo valida la base). |

## Cálculo

`compras_gp.ts` (económica) y `compras_fin.ts` (financiera) son **copias** del cálculo del tablero de Gestión de Proyectos de la app
`4housing-compras` (ver encabezado del archivo: commit de origen y nombres de las funciones).
Si cambia la fórmula en la app, hay que actualizar estas copias. Se validaron contra el código
original de la app: económica en 200 casos sintéticos; financiera en 2.400 OGs (incluidas 1.058
compartidas entre obras, verificando que las partes sumen la OG completa). Resultados idénticos.

Diferencia conocida: la app lee `compras_ogs` sin paginar (PostgREST corta en 1000 filas); el
conector las lee todas. En proyectos con OGs viejas los números pueden diferir de la pantalla.

## Deploy

Sin JWT de plataforma (el código valida el token y responde el 401 con `WWW-Authenticate`, como pide MCP):

```bash
supabase functions deploy conector-4housing --no-verify-jwt --project-ref wcpkpwxhqdcdljfwzcmy
```

Secretos (Edge Functions → Secrets), solo para SharePoint: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (app de Entra
"4housing Conector Claude", permisos delegados Files.ReadWrite.All, Sites.ReadWrite.All, offline_access, User.Read; redirect
`…/functions/v1/conector-4housing/ms/callback`). El refresh token de cada persona se guarda cifrado (AES-GCM, clave derivada
del client secret) en `conector_ms_tokens` (sin acceso por la API). Rotar el secret obliga a reconectar. La publishable key es pública.

## Registro en Claude

Conector personalizado de la organización, URL:

```
https://wcpkpwxhqdcdljfwzcmy.supabase.co/functions/v1/conector-4housing/mcp
```

Claude descubre el servidor OAuth por los metadatos
(`/functions/v1/conector-4housing/.well-known/oauth-protected-resource`) y se registra solo
(Dynamic OAuth Apps activado). Cada persona se conecta con su propio login.

## Prueba de aceptación

1. Usuario `lector` de Compras: ve proyectos y resúmenes.
2. Usuario sin sector Compras: no ve proyectos.
3. Un proyecto conocido: los totales coinciden con el tablero de la app.

Nota (beta de Supabase): los tokens OAuth no tienen scopes; tienen los mismos permisos que el
usuario. La autorización depende 100% de la RLS.
