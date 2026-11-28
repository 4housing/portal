// ifc-nocturno: punto de entrada. La lógica (y su explicación) está en nocturno.ts.
import { manejar } from './nocturno.ts';

Deno.serve((req) => manejar(req));
