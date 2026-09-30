# portal — Contexto del proyecto

**Portal unificado 4housing**: shell de acceso a todas las apps, control de usuarios y
navegación entre módulos. Login Microsoft (Azure) vía Supabase Auth.

## Stack

- **Archivos clave:** `index.html` (landing + login + cards de módulos), `admin.html`
  (pantalla de Usuarios, **solo dirección**), `nav.js` (botón flotante de navegación entre
  apps, permission-aware). `sql/` versiona las migraciones del portal y de cada sector.
- **Hosting:** GitHub Pages, org `4housing`, repo `4housing/portal`. URL: https://4housing.github.io/portal/
  (⚠ el repo `labo-comercial/portal` quedó VIEJO/divergente; el LIVE es `4housing/portal`).
- **Backend:** Supabase unificado → proyecto `wcpkpwxhqdcdljfwzcmy` (wcpk).

## Control de acceso (esto lo define el portal para todas las apps)

- `perfiles` (id = auth.users.id, email, activo, es_direccion) + `perfiles_sector`
  (perfil_id, sector, cargo, permisos jsonb). Enum `sector_portal`:
  fhcomercial, labocomercial, diseno, planificacion, compras, eerr, logistica.
- Helpers: `es_direccion()`, `tiene_sector(sector)` (exige `activo=true`), `cargo_en_sector()`.
- **Dirección** (`es_direccion=true`) ve/edita TODO y es lo único que entra a `admin.html`
  (hoy: Pablo y Micaela). El resto ve solo sus sectores; `nav.js` poda el menú por sector.
- `nav.js` MODULOS: agregar una app nueva = una línea con su `path` y `sector`.

## Reglas de trabajo — NO NEGOCIABLES

> **Criterio, no candado.** Estas reglas son el default. Se pueden saltar si el dueño
> de la decisión (Pablo) lo resuelve explícitamente — pero Claude debe **advertir ANTES**,
> con claridad, que la acción incumple tal regla y qué riesgo tiene, y esperar el OK.
> Claude nunca rompe una regla por su cuenta ni en silencio.

1. **No romper lo que ya funciona.** Preferí agregar antes que modificar; `grep` de los
   usos antes de tocar código compartido; probá lo que tocaste, no solo lo que agregaste.
2. **SQL nunca se ejecuta solo.** Se entrega como `.sql` y lo corre una persona a mano en Supabase.
3. **Orden de deploy:** primero el SQL (si agrega tablas/columnas/policies), después el HTML/JS.
4. **RLS siempre `authenticated`, nunca `anon`** + compuerta de sector (`tiene_sector('...')`).
5. **Secretos nunca en el código** (es público). anon/publishable es pública; tokens/service keys no.
6. **Validá el JS con `node --check`** antes de terminar (incluye `nav.js`).
7. **Cambios incrementales y aditivos:** una feature por PR, chico y reversible.
8. **Decisiones estructurales se cierran antes de codear.**
9. **Git:** `git pull` antes; ramas por feature + PR o coordinar; commits chicos, en español;
   tras `stash pop`/merge chequeá marcadores de conflicto (`<<<<<<<`) antes de commitear.
10. **Prefijos de tabla por sector:** fhcomercial_, labocomercial_, diseno_, planificacion_,
    compras_, eerr_, logistica_. `core_` reservado para maestras compartidas (no crear todavía).
11. **Datos de negocio nunca al repo público** (dumps `.sql` gitignoreados; el repo es público).
12. **Diagnosticar con evidencia** (`grep`/`diff`), no adivinar. Reportar con fidelidad.

## Cómo entregar
- HTML/JS: archivo completo, validado con `node --check`. SQL: archivo `.sql` aparte, corrido a mano.
