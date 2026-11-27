// ifc-ingesta: punto de entrada. La lógica (y su explicación) está en ingesta.ts.
import { manejar } from './ingesta.ts';

Deno.serve((req) => manejar(req));
