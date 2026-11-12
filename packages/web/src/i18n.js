// Traduction de l'interface (français par défaut, anglais).
//
// - Textes du HTML : attributs data-i18n (texte), data-i18n-html (HTML de confiance, venant des catalogues),
//   data-i18n-placeholder, data-i18n-title, data-i18n-data-placeholder. Le français est écrit dans index.html :
//   il s'affiche sans attendre ; traduirePage() ne fait rien en français.
// - Textes du code : t('cle', { variable }) ; les {variables} sont remplacées.
// - Erreurs du serveur : messageErreur(reponse) traduit par le code stable (catalogue « erreur.<code> »).
// - Langue : réglage du wiki (paramètres, injecté par le serveur dans <html data-langue-wiki>), sinon langue du
//   navigateur, sinon français.
import fr from './i18n/fr.js';
import en from './i18n/en.js';

export const CATALOGUES = { fr, en };
export const LANGUES = Object.keys(CATALOGUES);
const LOCALES = { fr: 'fr-FR', en: 'en-GB' };
let langue = 'fr';

/** Choisit la langue : réglage du wiki, puis navigateur, puis français */
export function choisirLangue(reglageWiki = document.documentElement.dataset.langueWiki) {
    const navigateur = (navigator.languages?.length ? navigator.languages : [navigator.language || 'fr'])
        .map(l => String(l).slice(0, 2).toLowerCase()).find(l => CATALOGUES[l]);
    langue = CATALOGUES[reglageWiki] ? reglageWiki : (navigateur || 'fr');
    document.documentElement.lang = langue;
    return langue;
}

export const langueActive = () => langue;
export const locale = () => LOCALES[langue] || 'fr-FR';

/** Texte traduit ; repli sur le français puis sur la clé (visible, pour repérer un oubli) */
export function t(cle, valeurs = {}) {
    const texte = CATALOGUES[langue][cle] ?? fr[cle] ?? cle;
    return texte.replace(/\{(\w+)\}/g, (m, k) => (k in valeurs ? String(valeurs[k]) : m));
}

/** Message d'erreur d'une réponse de l'API : traduit par son code s'il est connu, sinon le message du serveur */
export function messageErreur(reponse, defaut) {
    const cle = reponse?.code ? `erreur.${reponse.code}` : null;
    if (cle && langue !== 'fr' && CATALOGUES[langue][cle]) return t(cle, reponse.params || {});
    return reponse?.message || defaut;
}

/** Applique la langue active aux textes marqués du HTML */
export function traduirePage(racine = document) {
    if (langue === 'fr') return;
    for (const el of racine.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of racine.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
    for (const [attribut, nom] of [['placeholder', 'i18nPlaceholder'], ['title', 'i18nTitle'], ['data-placeholder', 'i18nDataPlaceholder']]) {
        for (const el of racine.querySelectorAll(`[data-i18n-${attribut}]`)) el.setAttribute(attribut, t(el.dataset[nom]));
    }
}

/** Date et heure au format de la langue active */
export const formaterDate = (date, options = { dateStyle: 'medium', timeStyle: 'short' }) =>
    new Intl.DateTimeFormat(locale(), options).format(new Date(date));
