// Stockage des fichiers (images). Mode standalone : disque local.
// Interface commune : ecrire(wikiId, cle, octets), lireFlux(wikiId, cle), supprimer(wikiId, cle), supprimerWiki(wikiId).
// Un adaptateur S3 (mode platform) exposera les mêmes fonctions.
import fs from 'node:fs';
import path from 'node:path';

export function creerStockageDisque(racine) {
    const base = path.resolve(racine);
    fs.mkdirSync(base, { recursive: true });

    // Chemin d'un fichier, sans jamais sortir du dossier du wiki
    function chemin(wikiId, cle) {
        if (!Number.isInteger(wikiId) || wikiId <= 0) throw new Error('wikiId invalide');
        const dossierWiki = path.join(base, String(wikiId));
        const complet = path.resolve(dossierWiki, cle);
        if (!complet.startsWith(dossierWiki + path.sep)) throw new Error(`Chemin refusé : ${cle}`);
        return complet;
    }

    return {
        async ecrire(wikiId, cle, octets) {
            const destination = chemin(wikiId, cle);
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            const temporaire = `${destination}.${process.pid}.${Date.now()}.tmp`;
            await fs.promises.writeFile(temporaire, octets);
            await fs.promises.rename(temporaire, destination);
        },
        lireFlux(wikiId, cle) {
            return fs.createReadStream(chemin(wikiId, cle));
        },
        async supprimer(wikiId, cle) {
            await fs.promises.rm(chemin(wikiId, cle), { force: true });
        },
        /** Tous les fichiers d'un wiki (suppression du wiki) */
        async supprimerWiki(wikiId) {
            if (!Number.isInteger(wikiId) || wikiId <= 0) throw new Error('wikiId invalide');
            await fs.promises.rm(path.join(base, String(wikiId)), { recursive: true, force: true });
        },
    };
}
