// Résolution des liens internes entre pages.
// Un lien peut viser une page par son slug (« boite_de_vitesse_02j »), par son titre (« Boite de vitesse 02J »),
// par un ancien chemin Wiki.js (« ../../les-bougies-pour-le-1.8t-20v ») ou par un ancien nom (page renommée).

export function cleNormalisee(texte) {
    return String(texte).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * @param {Array<{id: string, titre: string}>} pages  toutes les pages (arbre aplati + non classées)
 * @param {Record<string, string>} redirections        ancien slug → slug actuel
 */
export function creerIndexPages(pages, redirections = {}) {
    const titres = new Map(pages.map(p => [p.id, p.titre]));
    const slugParCle = new Map();
    for (const [slug, titre] of titres) {
        for (const cle of [cleNormalisee(slug), cleNormalisee(titre)]) if (cle && !slugParCle.has(cle)) slugParCle.set(cle, slug);
    }
    for (const [ancien, actuel] of Object.entries(redirections)) {
        const cle = cleNormalisee(ancien);
        if (cle && !slugParCle.has(cle) && titres.has(actuel)) slugParCle.set(cle, actuel);
    }

    function resoudre(href) {
        let cible = String(href).split(/[?#]/)[0];
        if (!cible) return null;
        cible = cible.replace(/\/+$/, '').split('/').pop();
        try { cible = decodeURIComponent(cible); } catch { /* lien mal encodé : gardé tel quel */ }
        if (titres.has(cible)) return cible;
        if (redirections[cible] && titres.has(redirections[cible])) return redirections[cible];
        const cle = cleNormalisee(cible);
        if (slugParCle.has(cle)) return slugParCle.get(cle);
        // Dernier recours (pages renommées avant l'existence des redirections) :
        // « s3-passion.com_easy_diag » → « easy_diag » si une seule page correspond à la fin du nom
        let meilleur = null, longueur = 0, exAequo = false;
        for (const [k, slug] of slugParCle) {
            if (k.length >= 4 && cle.endsWith('_' + k)) {
                if (k.length > longueur) { meilleur = slug; longueur = k.length; exAequo = false; }
                else if (k.length === longueur && slug !== meilleur) exAequo = true;
            }
        }
        return exAequo ? null : meilleur;
    }

    return {
        titre: slug => titres.get(slug),
        existe: slug => titres.has(slug),
        resoudre,
    };
}

/** Lien externe, ancre ou fichier : à ne pas traiter comme un lien vers une page */
export function estLienNonPage(href) {
    return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href) || /^\/?(media|uploads|api|assets)\//.test(href);
}
