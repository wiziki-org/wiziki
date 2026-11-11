// Lecture et écriture des archives ZIP d'export (format ouvert, voir docs/format-export.md).
// Le cœur manipule une simple Map « chemin → octets » ; ce module fait la conversion avec un vrai fichier ZIP.
import { zipSync, unzipSync } from 'fflate';

export const LIMITES_ARCHIVE = {
    fichiers: 50_000,               // nombre d'entrées
    totalDecompresse: 2 * 1024 ** 3, // 2 Go une fois décompressée (protection « bombe ZIP »)
};

// Les images sont déjà compressées : les recompresser ne fait que perdre du temps
const DEJA_COMPRESSE = /\.(png|jpe?g|gif|webp|ico)$/i;

/** @param {Map<string, Uint8Array|string>} fichiers @returns {Buffer} */
export function creerZip(fichiers) {
    const entrees = {};
    for (const [chemin, contenu] of fichiers) {
        const octets = typeof contenu === 'string' ? new TextEncoder().encode(contenu) : contenu;
        entrees[chemin] = [octets, { level: DEJA_COMPRESSE.test(chemin) ? 0 : 6 }];
    }
    return Buffer.from(zipSync(entrees, { mtime: new Date() }));
}

/**
 * @param {Uint8Array} octets contenu du fichier ZIP
 * @returns {Map<string, Uint8Array>} fichiers (les dossiers sont ignorés)
 */
export function lireZip(octets, limites = LIMITES_ARCHIVE) {
    let nombre = 0, total = 0;
    let fichiers;
    try {
        fichiers = unzipSync(octets, {
            filter(f) {
                if (f.name.endsWith('/')) return false;
                nombre++;
                total += f.originalSize;
                if (nombre > limites.fichiers) throw new ErreurArchive(`Archive refusée : plus de ${limites.fichiers} fichiers.`);
                if (total > limites.totalDecompresse) throw new ErreurArchive('Archive refusée : trop volumineuse une fois décompressée.');
                return true;
            },
        });
    } catch (err) {
        if (err instanceof ErreurArchive) throw err;
        throw new ErreurArchive("Ce fichier n'est pas une archive ZIP lisible.");
    }
    // La taille annoncée peut mentir : on vérifie aussi la taille réelle
    const reel = Object.values(fichiers).reduce((n, f) => n + f.length, 0);
    if (reel > limites.totalDecompresse) throw new ErreurArchive('Archive refusée : trop volumineuse une fois décompressée.');
    return new Map(Object.entries(fichiers));
}

export class ErreurArchive extends Error {
    constructor(message) { super(message); this.statusCode = 400; }
}
