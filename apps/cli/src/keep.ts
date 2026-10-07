// What `startService` runs each service under; see `keep-running.ts`.
import { main } from './keep-running.js';

void main(process.argv.slice(2)).then((code) => process.exit(code));
