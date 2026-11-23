# Conector 4housing Apps (servidor MCP)

Edge Function del proyecto Supabase unificado (`wcpkpwxhqdcdljfwzcmy`) que deja consultar las apps
del portal desde Claude **con los permisos de cada usuario**.

- **Login:** Supabase Auth como servidor OAuth 2.1. La aprobación la hace `portal/oauth/consent/`.
- **Permisos:** cada consulta va con el token del usuario (nunca service key): aplica la RLS existente
  (`tiene_sector`, `puede_editar_sector`, `compras_flag`). Quien no tiene el sector no ve nada.
- **Alcance (v2):** solo consulta, solo Compras (foto económica + financiera).

| Herramienta | Qué devuelve |
| --- | --- |
| `compras_listar_proyectos` | Proyectos de Gestión de Proyectos (id, código, nombre). |
| `compras_resumen_proyecto` | Foto **económica**: presupuesto vs comprado (OC de Tango + OGs), avance, saldo, extracosto, ahorro, sin clasificar y detalle por rubro. No incluye la foto financiera. |
| `compras_financiero_proyecto` | Foto **financiera**: por OG, certificado, liberado, pendiente de certificar, pagado, pendiente de pago y OP armadas (OGs compartidas: solo los renglones de la obra), totales en pesos; OC de Tango: facturado y pendiente de facturar. |

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

No usa secretos ni variables de entorno: la publishable key es pública (la misma de `portal/index.html`).

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
