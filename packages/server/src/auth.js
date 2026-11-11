// Limitation des tentatives de connexion (en mémoire) : par IP et par identifiant.
export const COOKIE_SESSION = 'wz_session';

const MAX_ECHECS = 5;
const FENETRE_MS = 15 * 60 * 1000;

export function creerLimiteur({ max = MAX_ECHECS, fenetreMs = FENETRE_MS } = {}) {
    const echecs = new Map(); // clé -> { nombre, debut }
    const minuterie = setInterval(() => {
        const t = Date.now();
        for (const [cle, e] of echecs) if (t - e.debut > fenetreMs) echecs.delete(cle);
    }, fenetreMs);
    minuterie.unref();

    return {
        bloque(cle) {
            const e = echecs.get(cle);
            if (!e) return false;
            if (Date.now() - e.debut > fenetreMs) { echecs.delete(cle); return false; }
            return e.nombre >= max;
        },
        echec(cle) {
            const e = echecs.get(cle);
            if (!e || Date.now() - e.debut > fenetreMs) echecs.set(cle, { nombre: 1, debut: Date.now() });
            else e.nombre++;
        },
        reinitialiser(cle) { echecs.delete(cle); },
    };
}
