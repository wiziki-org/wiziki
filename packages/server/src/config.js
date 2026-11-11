// Configuration par variables d'environnement.
import path from 'node:path';

export function lireConfig(env = process.env) {
    const dossierDonnees = path.resolve(env.WIZIKI_DATA_DIR || './data');
    const mode = env.WIZIKI_MODE || 'standalone';
    if (mode !== 'standalone') throw new Error(`WIZIKI_MODE=${mode} : seul le mode « standalone » est disponible pour l'instant.`);
    return {
        mode,
        port: parseInt(env.PORT, 10) || 3000,
        hote: env.HOST || '0.0.0.0',
        dossierDonnees,
        fichierBase: path.join(dossierDonnees, 'wiziki.db'),
        dossierFichiers: path.join(dossierDonnees, 'files'),
        motDePasseAdmin: env.ADMIN_PASSWORD || '',
        trustProxy: env.TRUST_PROXY === '1',
        // Wiki servi en mode standalone (créé automatiquement s'il n'existe pas)
        slugWiki: env.WIZIKI_WIKI || 'default',
        logs: env.WIZIKI_LOG_LEVEL || 'info',
    };
}
