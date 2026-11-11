// Emplacement de l'interface construite (`npm run build`), servie par @wiziki/server
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = path.join(WEB_DIR, 'dist');
export const INDEX_FILE = path.join(DIST_DIR, 'index.html');
export const ASSETS_DIR = path.join(DIST_DIR, 'assets');

export function verifierBuild() {
    if (!fs.existsSync(INDEX_FILE)) {
        throw new Error(`Interface non construite (${INDEX_FILE} introuvable). Lancez : npm run build`);
    }
}
