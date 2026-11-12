// Règles de validation partagées (serveur, CLI, import).

export class ErreurWiki extends Error {
    /**
     * @param {number} statut code HTTP correspondant
     * @param {string} message texte en français (API, ligne de commande, journaux)
     * @param {string} [code] code stable, traduit par l'interface (catalogues « erreur.<code> »)
     * @param {Record<string, string|number>} [params] valeurs variables du message, pour la traduction
     */
    constructor(statut, message, code = null, params = null) {
        super(message);
        this.statut = statut;
        this.code = code;
        this.params = params;
    }
}

// Identifiant (slug) d'une page existante : lettres, chiffres, _ - . ; sans « .. » ni point initial.
export const REGEX_SLUG = /^(?!\.)(?!.*\.\.)[A-Za-z0-9_.-]{1,200}$/;
// Slug d'une page nouvelle ou renommée (généré par le front à partir du titre).
export const REGEX_NOUVEAU_SLUG = /^[A-Za-z0-9_-]{1,200}$/;
// Clé d'un fichier stocké : « uploads/… » ou « media/… », sous-dossiers autorisés.
export const REGEX_CLE_FICHIER = /^(uploads|media)\/(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_.\-\/]{1,300}$/;

export const PARAMETRES_DEFAUT = Object.freeze({ nom: 'Mon Wiki', banniereActive: false, banniereUrl: '' });

export const PROFONDEUR_MAX_ARBRE = 20;
export const TAILLE_MAX_PAGE = 2 * 1024 * 1024;
export const TAILLE_MAX_IMAGE = 10 * 1024 * 1024;

export function verifierSlug(slug) {
    if (typeof slug !== 'string' || !REGEX_SLUG.test(slug)) throw new ErreurWiki(400, 'Identifiant de page invalide.', 'page_identifiant_invalide');
    return slug;
}

export function nettoyerParametres(p) {
    if (!p || typeof p !== 'object') p = {};
    const texte = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const resultat = {
        nom: texte(p.nom, 200) || PARAMETRES_DEFAUT.nom,
        banniereActive: p.banniereActive === true,
        banniereUrl: texte(p.banniereUrl, 2000),
    };
    if (typeof p.couleurLiens === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.couleurLiens)) resultat.couleurLiens = p.couleurLiens;
    if (typeof p.pageAccueil === 'string' && (p.pageAccueil === '' || REGEX_SLUG.test(p.pageAccueil))) resultat.pageAccueil = p.pageAccueil;
    return resultat;
}

/** Valide un arbre reçu du front : [{ id, titre, enfants: [...] }] */
export function nettoyerArbre(elements, profondeur = 0, vus = new Set()) {
    if (!Array.isArray(elements)) throw new ErreurWiki(400, 'Arbre invalide.', 'arbre_invalide');
    if (profondeur > PROFONDEUR_MAX_ARBRE) throw new ErreurWiki(400, 'Arbre trop profond.', 'arbre_trop_profond');
    return elements.map(el => {
        if (!el || typeof el !== 'object') throw new ErreurWiki(400, "Élément d'arbre invalide.", 'arbre_element_invalide');
        if (typeof el.id !== 'string' || !REGEX_SLUG.test(el.id)) {
            throw new ErreurWiki(400, `Identifiant de page invalide : ${String(el.id).slice(0, 50)}`, 'page_identifiant_invalide');
        }
        if (vus.has(el.id)) throw new ErreurWiki(400, `Page présente deux fois dans l'arbre : ${el.id}`, 'arbre_doublon', { page: el.id });
        vus.add(el.id);
        const titre = typeof el.titre === 'string' && el.titre.trim() ? el.titre.slice(0, 300) : el.id;
        return { id: el.id, titre, enfants: nettoyerArbre(el.enfants || [], profondeur + 1, vus) };
    });
}

/** Détecte le vrai type d'une image à partir de ses premiers octets (l'extension annoncée est ignorée). */
export function detecterTypeImage(octets) {
    if (!octets || octets.length < 12) return null;
    if (octets[0] === 0x89 && octets.toString('latin1', 1, 4) === 'PNG') return { ext: 'png', mime: 'image/png' };
    if (octets[0] === 0xFF && octets[1] === 0xD8 && octets[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
    if (octets.toString('latin1', 0, 4) === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
    if (octets.toString('latin1', 0, 4) === 'RIFF' && octets.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    return null;
}

export const TYPES_MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
