// Connexion par Ory Kratos (WIZIKI_AUTH=kratos) : connexion, inscription, mot de passe oublié et réglages du compte,
// affichés à partir des « parcours » de Kratos. Tout passe par le relais /kratos du wiki (même origine).

const FR = {
    1010001: 'Se connecter', 1010003: 'Confirmez votre identité pour continuer.',
    1010004: "Terminez la seconde étape d'authentification.", 1010005: 'Vérifier',
    1010006: "Code de l'application d'authentification", 1010007: 'Code de secours',
    1010009: "Utiliser l'application d'authentification", 1010010: 'Utiliser un code de secours',
    1010013: 'Continuer', 1010022: 'Se connecter',
    1040001: 'Créer mon compte', 1040003: 'Continuer', 1040008: 'Retour',
    1040009: 'Choisissez votre mot de passe.', 1070002: 'Adresse email',
    1050001: 'Modifications enregistrées.', 1050004: "Désactiver l'application d'authentification",
    1050005: "QR code à scanner avec l'application d'authentification",
    1050007: 'Afficher les codes de secours', 1050008: 'Générer de nouveaux codes de secours',
    1050010: 'Voici vos codes de secours. Conservez-les en lieu sûr : chacun ne sert qu’une fois.',
    1050011: "J'ai noté mes codes de secours", 1050017: "Clé de l'application (si le QR code ne peut pas être scanné)",
    1060001: 'Compte récupéré. Choisissez maintenant un nouveau mot de passe.',
    1060002: 'Si un compte correspond à cette adresse, un email de récupération vient de lui être envoyé.',
    1060003: 'Si un compte correspond à cette adresse, un email contenant un code vient de lui être envoyé.',
    1070001: 'Mot de passe', 1070003: 'Enregistrer', 1070004: 'Adresse email', 1070005: 'Envoyer',
    1070006: 'Vérifier le code', 1070007: 'Adresse email', 1070008: 'Renvoyer le code',
    1070009: 'Continuer', 1070010: 'Code de récupération', 1070011: 'Code de vérification',
    1080001: 'Un email contenant un code vient de vous être envoyé.', 1080002: 'Adresse email vérifiée.',
    1080003: 'Si cette adresse est enregistrée, un email contenant un code vient de lui être envoyé.',
    4070005: 'La demande de vérification a expiré. Recommencez.', 4070006: 'Code de vérification invalide ou déjà utilisé.',
    4000002: 'Ce champ est obligatoire.', 4000004: 'Format invalide.',
    4000006: 'Adresse email ou mot de passe incorrect.',
    4000007: 'Un compte existe déjà avec cette adresse. Connectez-vous, ou récupérez votre compte si le mot de passe est oublié.',
    4000008: "Code d'authentification invalide. Réessayez.", 4000012: 'Ce code de secours a déjà été utilisé.',
    4000016: 'Code de secours invalide.', 4000031: 'Ce mot de passe ressemble trop à votre adresse email.',
    4000034: 'Ce mot de passe figure dans des fuites de données connues. Choisissez-en un autre.',
    4010001: 'La page de connexion a expiré. Recommencez.', 4010002: 'Formulaire incomplet. Vérifiez votre saisie.',
    4010003: 'Formulaire incomplet. Vérifiez votre saisie.', 4040001: "La page d'inscription a expiré. Recommencez.",
    4050001: 'La page a expiré. Recommencez.', 4060004: 'Lien de récupération invalide ou déjà utilisé.',
    4060005: 'La demande de récupération a expiré. Recommencez.', 4060006: 'Code de récupération invalide ou déjà utilisé.',
};

function tr(message) {
    if (!message) return '';
    const c = message.context || {};
    switch (message.id) {
        case 4000003: return `Trop court : au moins ${c.min_length ?? ''} caractères.`;
        case 4000005: return `Ce mot de passe ne peut pas être utilisé${c.reason ? ` : ${c.reason}` : '.'}`;
        case 4000032: return `Le mot de passe doit contenir au moins ${c.min_length ?? 8} caractères.`;
        default: return FR[message.id] || message.text;
    }
}

const ECRANS = {
    connexion: { flux: 'login', titre: '🔐 Connexion' },
    inscription: { flux: 'registration', titre: '✨ Créer un compte' },
    oubli: { flux: 'recovery', titre: '🔑 Mot de passe oublié' },
    compte: { flux: 'settings', titre: '🔑 Mon compte' },
    verification: { flux: 'verification', titre: '✉️ Vérifier mon adresse email' },
};
const TITRES_GROUPES = { profile: 'Adresse email', password: 'Mot de passe', totp: 'Application d’authentification', lookup_secret: 'Codes de secours' };

// Petit constructeur d'éléments : h('button.classe', { type: 'button', onclick }, 'texte')
function h(spec, props = {}, ...enfants) {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [cle, valeur] of Object.entries(props || {})) {
        if (valeur === undefined || valeur === null || valeur === false) continue;
        if (cle.startsWith('on')) el.addEventListener(cle.slice(2), valeur);
        else if (cle === 'value') el.value = valeur;
        else if (valeur === true) el.setAttribute(cle, '');
        else el.setAttribute(cle, valeur);
    }
    for (const e of enfants.flat()) if (e !== null && e !== undefined && e !== false) el.append(e);
    return el;
}

const CLASSES_BOUTON = 'bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-semibold w-full';
const CLASSES_BOUTON_SECONDAIRE = 'bg-gray-100 px-4 py-2 rounded-lg text-sm w-full';
const CLASSES_CHAMP = 'w-full p-2 border rounded-lg text-sm';

// Les adresses renvoyées par Kratos visent son domaine réel : on les ramène sur le relais
function versRelais(absolue) {
    const u = new URL(absolue, location.origin);
    return `/kratos${u.pathname}${u.search}`;
}

async function kratosJson(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    const corps = res.status === 204 ? null : await res.json().catch(() => null);
    return { statut: res.status, corps };
}

/** Ferme la session Kratos (la session locale éventuelle est fermée par /api/logout) */
export async function deconnexionKratos() {
    const { statut, corps } = await kratosJson('/kratos/self-service/logout/browser').catch(() => ({}));
    if (statut === 200 && corps?.logout_url) await kratosJson(versRelais(corps.logout_url)).catch(() => {});
}

// Écran correspondant à une adresse de redirection de Kratos
function ecranDepuisRedirection(cible) {
    const u = new URL(cible, location.origin);
    const params = new URLSearchParams();
    for (const cle of ['flow', 'refresh', 'aal']) if (u.searchParams.get(cle)) params.set(cle, u.searchParams.get(cle));
    const nom = u.pathname.includes('settings') ? 'compte' : u.pathname.includes('recovery') ? 'oubli'
        : u.pathname.includes('verification') ? 'verification'
        : u.pathname.includes('regist') ? 'inscription' : u.pathname.includes('login') ? 'connexion' : null;
    return { nom, params };
}

// Adresse de redirection qui ne dit pas de quel écran il s'agit (ex. toutes les ui_url de Kratos sur la racine du wiki) :
// on demande à Kratos à quel parcours appartient ce flux
async function devinerEcran(idFlux) {
    for (const nom of ['compte', 'verification', 'connexion', 'inscription', 'oubli']) {
        const r = await kratosJson(`/kratos/self-service/${ECRANS[nom].flux}/flows?id=${encodeURIComponent(idFlux)}`).catch(() => ({}));
        if (r.statut === 200 && r.corps?.ui) return nom;
    }
    return null;
}

const $ = id => document.getElementById(id);
let fin = null; // résolution de la fenêtre en cours

function fermer(resultat) {
    $('modal-kratos').classList.add('hidden');
    $('kratos-carte').replaceChildren();
    if (fin) { const f = fin; fin = null; f(resultat); }
}

/**
 * Ouvre la fenêtre de connexion Kratos.
 * @param {{ message?: string, secours?: () => void }} options `secours` : passer au compte local de secours
 * @returns {Promise<'connecte'|'annule'|'secours'>}
 */
export function connexionKratos({ message, secours } = {}) {
    return ouvrir('connexion', new URLSearchParams(), { message, secours });
}

/** Vérification de l'adresse email (un code est envoyé par Kratos) */
export function verifierAdresseKratos() {
    return ouvrir('verification', new URLSearchParams(), {});
}

/** Réglages du compte Kratos (email, mot de passe, double authentification) */
export function ouvrirCompteKratos() {
    return ouvrir('compte', new URLSearchParams(), {});
}

function ouvrir(nom, params, options) {
    if (fin) fermer('annule');
    $('modal-kratos').classList.remove('hidden');
    return new Promise(resolve => {
        fin = resolve;
        afficherEcran(nom, params, options);
    });
}

async function afficherEcran(nom, params, options) {
    const ecran = ECRANS[nom];
    const carte = $('kratos-carte');
    carte.replaceChildren(h('p.text-sm.text-gray-500', {}, 'Chargement…'));

    const recommencer = message => {
        const neufs = new URLSearchParams(params);
        neufs.delete('flow');
        afficherEcran(nom, neufs, { ...options, message: message || options.message });
    };
    const aller = (autre, p = new URLSearchParams()) => afficherEcran(autre, p, { ...options, message: null });

    const probleme = ({ statut, corps }) => {
        const id = corps?.error?.id;
        if (corps?.redirect_browser_to) {
            const cible = ecranDepuisRedirection(corps.redirect_browser_to);
            if (cible.nom) aller(cible.nom, cible.params);
            else if (cible.params.get('flow')) devinerEcran(cible.params.get('flow')).then(n => (n ? aller(n, cible.params) : fermer('connecte')));
            else fermer('connecte');
        } else if (id === 'session_already_available') {
            fermer('connecte');
        } else if (statut === 401 && nom === 'compte') {
            aller('connexion');
        } else if (statut === 410 || statut === 404 || statut === 403 || id === 'security_csrf_violation') {
            recommencer('La page a expiré. Recommencez.');
        } else {
            echec(carte, corps?.error?.message ? 'Le service de connexion a refusé la demande.' : 'Le service de connexion est momentanément indisponible.', () => recommencer());
        }
    };

    const afficherFlux = flux => {
        const envoyer = async (form, bouton) => {
            // À lire avant de désactiver les boutons : un bouton désactivé n'est pas transmis
            const donnees = new FormData(form, bouton);
            for (const b of form.querySelectorAll('button')) b.disabled = true;
            const charge = {};
            for (const [cle, valeur] of donnees.entries()) placer(charge, cle, valeur);
            let r;
            try {
                r = await kratosJson(versRelais(flux.ui.action), {
                    method: flux.ui.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(charge),
                });
            } catch {
                for (const b of form.querySelectorAll('button')) b.disabled = false;
                form.before(h('p.text-xs.text-red-600.mb-2', {}, 'Connexion au serveur impossible. Vérifiez votre réseau.'));
                return;
            }
            if (r.corps?.ui) afficherFlux(r.corps); // erreurs de saisie, étape suivante ou confirmation
            else if (r.statut >= 200 && r.statut < 300) {
                // Inscription réussie : Kratos demande de vérifier l'adresse (code envoyé par email)
                const suite = (r.corps?.continue_with || []).find(c => c.action === 'show_verification_ui');
                if (suite?.flow?.id) { aller('verification', new URLSearchParams({ flow: suite.flow.id })); return; }
                if (nom === 'compte') afficherFlux(flux); else fermer('connecte');
            } else probleme(r);
        };
        carte.replaceChildren(...rendreFlux(flux, nom, ecran.titre, envoyer, aller, options));
        carte.querySelector('input:not([type=hidden])')?.focus();
    };

    try {
        let r;
        const idFlux = params.get('flow');
        if (idFlux) r = await kratosJson(`/kratos/self-service/${ecran.flux}/flows?id=${encodeURIComponent(idFlux)}`);
        else {
            const q = new URLSearchParams();
            for (const cle of ['refresh', 'aal']) if (params.get(cle)) q.set(cle, params.get(cle));
            r = await kratosJson(`/kratos/self-service/${ecran.flux}/browser?${q}`);
        }
        if (r.statut === 200 && r.corps?.ui) afficherFlux(r.corps);
        else probleme(r);
    } catch {
        echec(carte, 'Connexion au serveur impossible. Vérifiez votre réseau.', () => recommencer());
    }
}

function echec(carte, message, reessayer) {
    carte.replaceChildren(
        h('p.text-sm.text-red-600.mb-4', {}, message),
        h('div.flex.gap-2', {},
            h('button', { type: 'button', class: CLASSES_BOUTON_SECONDAIRE, onclick: () => fermer('annule') }, 'Fermer'),
            h('button', { type: 'button', class: CLASSES_BOUTON, onclick: reessayer }, 'Réessayer')),
    );
}

// { traits: { email } } à partir du nom de champ « traits.email »
function placer(cible, chemin, valeur) {
    const cles = chemin.split('.');
    const derniere = cles.pop();
    let n = cible;
    for (const c of cles) n = n[c] ??= {};
    n[derniere] = valeur;
}

function rendreFlux(flux, nom, titre, envoyer, aller, options) {
    const parties = [];
    const deuxEtapes = flux.requested_aal === 'aal2';
    const rafraichir = flux.refresh === true;
    parties.push(h('h3.text-lg.font-bold.text-gray-900.mb-1', {}, deuxEtapes ? '🔐 Seconde étape' : rafraichir ? '🔐 Confirmer votre identité' : titre));
    if (options.message && nom === 'connexion') parties.push(h('p.text-xs.text-gray-500.mb-3', {}, options.message));
    for (const m of flux.ui.messages || []) parties.push(elementMessage(m));

    const caches = flux.ui.nodes.filter(n => n.group === 'default' && n.attributes.type === 'hidden');
    // Réglages et seconde étape : une action par formulaire, pour que les champs obligatoires de l'une ne bloquent pas les autres
    if (nom === 'compte' || deuxEtapes) {
        const groupes = [...new Set(flux.ui.nodes.map(n => n.group))].filter(g => g !== 'default');
        for (const g of groupes) {
            const form = construireFormulaire([...caches, ...flux.ui.nodes.filter(n => n.group === g)], envoyer);
            parties.push(nom === 'compte' && TITRES_GROUPES[g]
                ? h('section.mt-4.pt-3.border-t', {}, h('h4.text-sm.font-semibold.text-gray-700.mb-2', {}, TITRES_GROUPES[g]), form)
                : form);
        }
    } else parties.push(construireFormulaire(flux.ui.nodes, envoyer));

    const liens = [];
    const lien = (texte, onclick) => h('button.text-xs.text-gray-500.hover:text-indigo-600', { type: 'button', onclick }, texte);
    if (nom === 'connexion' && !deuxEtapes && !rafraichir) {
        liens.push(lien('Mot de passe oublié ?', () => aller('oubli')));
        liens.push(lien('Créer un compte', () => aller('inscription')));
        if (options.secours) liens.push(lien('Compte local (secours)', () => fermer('secours')));
    } else if (nom === 'inscription' || nom === 'oubli') {
        liens.push(lien('J’ai déjà un compte', () => aller('connexion')));
    } else if (nom === 'compte') {
        liens.push(lien('Vérifier mon adresse email', () => aller('verification')));
    }
    // Après une inscription, la personne est déjà connectée : fermer la vérification ne l'annule pas
    const termine = nom === 'compte' || nom === 'verification';
    liens.push(lien(termine ? (flux.state === 'passed_challenge' ? 'Continuer' : 'Fermer') : 'Annuler', () => fermer(termine ? 'connecte' : 'annule')));
    parties.push(h('nav.flex.flex-wrap.justify-between.gap-2.mt-4', {}, ...liens));
    return parties;
}

function construireFormulaire(noeuds, envoyer) {
    const form = h('form.space-y-2', { onsubmit: e => { e.preventDefault(); envoyer(form, e.submitter); } });
    for (const n of noeuds) {
        const el = rendreNoeud(n);
        if (el) form.append(el);
    }
    return form;
}

function elementMessage(m) {
    const couleur = m.type === 'error' ? 'text-red-600' : m.type === 'success' ? 'text-green-700' : 'text-gray-600';
    return h(`p.text-xs.${couleur}.mb-2`, {}, tr(m));
}

function rendreNoeud(n) {
    const a = n.attributes;
    const libelle = tr(n.meta?.label);
    const messages = (n.messages || []).map(elementMessage);
    switch (n.type) {
        case 'input': {
            if (a.type === 'hidden') return h('input', { type: 'hidden', name: a.name, value: a.value ?? '' });
            if (a.type === 'submit' || a.type === 'button') {
                const secondaire = a.name === 'screen' || a.value === 'previous';
                return h('button', {
                    class: secondaire ? CLASSES_BOUTON_SECONDAIRE : CLASSES_BOUTON,
                    type: secondaire ? 'submit' : a.type === 'button' ? 'button' : 'submit',
                    name: a.name, value: a.value ?? '', formnovalidate: secondaire || undefined,
                }, libelle || 'Continuer');
            }
            const champ = h('input', {
                class: CLASSES_CHAMP, type: a.type || 'text', name: a.name, value: a.value ?? '',
                required: a.required || undefined, disabled: a.disabled || undefined, autocomplete: a.autocomplete || undefined,
                autocapitalize: a.type === 'email' || a.name === 'identifier' ? 'none' : undefined,
                inputmode: a.name === 'totp_code' ? 'numeric' : undefined,
            });
            return h('label.block', {}, h('span.block.text-xs.text-gray-600.mb-1', {}, libelle || a.name), champ, ...messages);
        }
        case 'img':
            return h('figure.flex.justify-center', {}, h('img', { src: a.src, alt: libelle || 'QR code', width: a.width, height: a.height }));
        case 'text': {
            const secrets = a.text?.context?.secrets;
            const contenu = Array.isArray(secrets)
                ? h('ul.grid.grid-cols-2.gap-1.font-mono.text-xs', {}, ...secrets.map(s => h('li', {}, tr(s))))
                : h('code.block.text-xs.break-all.bg-gray-50.p-2.rounded', {}, tr(a.text));
            return h('div', {}, libelle ? h('span.block.text-xs.text-gray-600.mb-1', {}, libelle) : null, contenu);
        }
        case 'a':
            return /^https?:\/\//i.test(a.href || '') ? h('a.text-xs.text-indigo-600', { href: a.href }, tr(a.title)) : null;
        default:
            return null;
    }
}
