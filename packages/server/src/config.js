// Configuration par variables d'environnement.
import path from 'node:path';

const MODES_AUTH = ['local', 'kratos'];

export function lireConfig(env = process.env) {
    const dossierDonnees = path.resolve(env.WIZIKI_DATA_DIR || './data');
    const mode = env.WIZIKI_MODE || 'standalone';
    if (mode !== 'standalone') throw new Error(`WIZIKI_MODE=${mode} : seul le mode « standalone » est disponible pour l'instant.`);

    // Identification : comptes intégrés (local) ou serveur Ory Kratos existant (kratos)
    const auth = env.WIZIKI_AUTH || 'local';
    if (!MODES_AUTH.includes(auth)) throw new Error(`WIZIKI_AUTH=${auth} : valeurs possibles « local » ou « kratos ».`);
    let kratosUrl = null;
    if (auth === 'kratos') {
        if (!env.WIZIKI_KRATOS_URL) throw new Error('WIZIKI_AUTH=kratos : indiquez WIZIKI_KRATOS_URL (API publique de Kratos, ex. http://kratos:4433).');
        try {
            const u = new URL(env.WIZIKI_KRATOS_URL);
            if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
            kratosUrl = u.href.replace(/\/+$/, '');
        } catch { throw new Error(`WIZIKI_KRATOS_URL invalide : ${env.WIZIKI_KRATOS_URL}`); }
    }

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
        auth,
        kratos: auth === 'kratos' ? {
            url: kratosUrl,
            cookie: env.WIZIKI_KRATOS_COOKIE || 'ory_kratos_session',
            // Par défaut, une adresse email n'est reconnue que si Kratos l'a vérifiée (sinon n'importe qui
            // pourrait s'inscrire avec l'adresse d'un membre et prendre sa place)
            adressesNonVerifiees: env.WIZIKI_KRATOS_ADRESSES_NON_VERIFIEES === '1',
            // Inscription depuis le wiki : fermée par défaut (les comptes se créent sur le serveur d'identification)
            inscription: env.WIZIKI_KRATOS_INSCRIPTION === '1',
        } : null,
    };
}
