// Client Ory Kratos (API publique) : qui est connecté, et relais des parcours de connexion.
// Kratos dit *qui* est la personne ; les droits sur le wiki restent gérés par wiziki.
import crypto from 'node:crypto';

// Une page de wiki déclenche plusieurs requêtes (images, structure, page…) : on évite d'interroger Kratos
// à chacune. Une session fermée ailleurs reste donc acceptée au plus cette durée ; une déconnexion
// depuis le wiki, elle, est immédiate.
const DUREE_CACHE_MS = 30_000;
const MAX_CACHE = 10_000;
const DELAI_MS = 5_000;

export class KratosIndisponible extends Error {}
export class SecondeEtapeRequise extends Error {}

/**
 * @param {{ url: string, cookie?: string, dureeCacheMs?: number, fetch?: typeof fetch }} options
 */
export function creerClientKratos({ url, cookie = 'ory_kratos_session', dureeCacheMs = DUREE_CACHE_MS, fetch: f = fetch }) {
    const base = url.replace(/\/+$/, '');
    const cache = new Map(); // empreinte du cookie -> { identite, expire }
    const cle = valeur => crypto.createHash('sha256').update(valeur).digest('hex');

    async function whoami(valeur) {
        let res;
        try {
            res = await f(`${base}/sessions/whoami`, {
                headers: { Accept: 'application/json', Cookie: `${cookie}=${valeur}` },
                signal: AbortSignal.timeout(DELAI_MS),
            });
        } catch (err) {
            throw new KratosIndisponible(`Kratos injoignable : ${err.message}`);
        }
        const corps = await res.json().catch(() => null);
        if (res.status === 401) return null;
        if (res.status === 403 && corps?.error?.id === 'session_aal2_required') throw new SecondeEtapeRequise();
        if (res.status !== 200 || !corps) throw new KratosIndisponible(`Kratos a répondu ${res.status}`);
        const identite = corps.identity;
        if (!corps.active || !identite?.id) return null;
        const email = typeof identite.traits?.email === 'string' ? identite.traits.email.trim().toLowerCase() : null;
        const adresse = (identite.verifiable_addresses || []).find(a => String(a.value).toLowerCase() === email);
        const nom = identite.traits?.name;
        return {
            id: String(identite.id),
            email,
            emailVerifie: !!adresse?.verified,
            nom: typeof nom === 'string' ? nom : (nom && typeof nom === 'object' ? [nom.first, nom.last].filter(Boolean).join(' ') : null),
        };
    }

    return {
        nomCookie: cookie,

        /** Identité correspondant au cookie de session Kratos, ou null. Lève KratosIndisponible / SecondeEtapeRequise. */
        async identifier(valeur) {
            if (typeof valeur !== 'string' || !valeur || valeur.length > 4096) return null;
            const k = cle(valeur);
            const e = cache.get(k);
            if (e && e.expire > Date.now()) return e.identite;
            const identite = await whoami(valeur);
            // Seuls les succès sont gardés : une connexion qui vient d'aboutir est vue tout de suite
            if (identite) {
                if (cache.size >= MAX_CACHE) cache.clear();
                cache.set(k, { identite, expire: Date.now() + dureeCacheMs });
            } else cache.delete(k);
            return identite;
        },

        /** Oublie une session (déconnexion depuis le wiki) */
        oublier(valeur) { if (typeof valeur === 'string') cache.delete(cle(valeur)); },

        /**
         * Relaie une requête vers un parcours self-service de Kratos.
         * @param {{ methode: string, chemin: string, entetes: Record<string,string>, corps?: Buffer }} r
         * @returns {Promise<{ statut: number, entetes: Record<string,string>, cookies: string[], corps: Buffer }>}
         */
        async relayer({ methode, chemin, entetes, corps }) {
            let res;
            try {
                res = await f(base + chemin, {
                    method: methode, headers: entetes, redirect: 'manual',
                    body: ['GET', 'HEAD'].includes(methode) ? undefined : corps,
                    signal: AbortSignal.timeout(DELAI_MS * 2),
                });
            } catch (err) {
                throw new KratosIndisponible(`Kratos injoignable : ${err.message}`);
            }
            const sortie = {};
            for (const nom of ['content-type', 'cache-control', 'location']) {
                const v = res.headers.get(nom);
                if (v) sortie[nom] = v;
            }
            // Les adresses renvoyées par Kratos visent son domaine : on les ramène sur le relais du wiki
            if (sortie.location?.startsWith(base + '/')) sortie.location = '/kratos' + sortie.location.slice(base.length);
            return {
                statut: res.status,
                entetes: sortie,
                cookies: res.headers.getSetCookie?.() || [],
                corps: Buffer.from(await res.arrayBuffer()),
            };
        },
    };
}
