// Écrans liés aux comptes : installation, membres du wiki, mot de passe.
// Les dépendances (requêtes API, session courante) sont fournies par app.js via configurerComptes().
import { echapperHtml } from './markdown.js';
import { ouvrirCompteKratos } from './kratos.js';
import { t, messageErreur, formaterDate } from './i18n.js';

let deps = null;
/** @param {{ apiEcrire: Function, session: () => any }} d */
export function configurerComptes(d) { deps = d; }

const ROLES = ['owner', 'editor', 'reader'];
export const libelleRole = role => (ROLES.includes(role) ? t(`js.role_${role}`) : t('js.role_aucun'));

const $ = id => document.getElementById(id);
function afficherErreur(id, message) {
    const el = $(id);
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
}
async function envoyerJson(methode, url, corps) {
    const res = await fetch(url, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, statut: res.status, data };
}

// ------------------------------------------------------------ Installation (premier démarrage)

/** Affiche l'écran d'installation ; se résout une fois le compte propriétaire créé (et connecté). */
export function installer() {
    const kratos = deps.session().auth === 'kratos';
    // Mode Kratos : le compte existe déjà (connexion faite), seul le jeton est demandé
    for (const el of document.querySelectorAll('#form-installation .auth-local')) {
        el.classList.toggle('hidden', kratos);
        if (el.tagName === 'INPUT' && el.dataset.requis !== undefined) el.required = !kratos;
    }
    $('inst-kratos').classList.toggle('hidden', !kratos);
    if (kratos) $('inst-kratos').textContent = t('js.installation_connecte', { compte: deps.session().utilisateur?.email || deps.session().utilisateur?.nom || t('js.votre_compte') });
    $('modal-installation').classList.remove('hidden');
    $('inst-jeton').focus();
    return new Promise(resolve => {
        $('form-installation').onsubmit = async (e) => {
            e.preventDefault();
            if (!kratos && $('inst-mdp').value !== $('inst-mdp2').value) { afficherErreur('inst-erreur', t('js.mots_de_passe_differents')); return; }
            const { ok, data } = await envoyerJson('POST', '/api/installation', {
                jeton: $('inst-jeton').value.trim(), identifiant: $('inst-identifiant').value,
                nom: $('inst-nom').value, email: $('inst-email').value || null, motDePasse: $('inst-mdp').value,
            });
            if (!ok) { afficherErreur('inst-erreur', messageErreur(data, t('js.installation_impossible'))); return; }
            $('modal-installation').classList.add('hidden');
            resolve(data);
        };
    });
}

// ------------------------------------------------------------ Membres (propriétaires)

async function chargerMembres() {
    const corps = $('liste-membres');
    corps.innerHTML = `<tr><td class="p-3 text-gray-400" colspan="4">${t('js.chargement')}</td></tr>`;
    const res = await fetch('/api/membres');
    if (!res.ok) { corps.innerHTML = `<tr><td class="p-3 text-red-600" colspan="4">${t('js.liste_indisponible')}</td></tr>`; return; }
    const membres = await res.json();
    const moi = deps.session().utilisateur;
    corps.innerHTML = '';
    for (const m of membres) {
        const tr = document.createElement('tr');
        tr.className = 'border-t';
        const derniere = m.last_login_at ? formaterDate(m.last_login_at, { dateStyle: 'medium' }) : t('js.jamais');
        tr.innerHTML = `
            <td class="p-2"><div class="font-medium">${echapperHtml(m.nom)}</div><div class="text-xs text-gray-400">${echapperHtml(m.identifiant)}${m.email ? ' · ' + echapperHtml(m.email) : ''}${m.sans_mot_de_passe && !m.externe ? ` · <i>${t('js.invite_pas_connecte')}</i>` : ''}</div></td>
            <td class="p-2"><select class="choix-role p-1 border rounded text-xs">
                ${ROLES.map(v => `<option value="${v}" ${v === m.role ? 'selected' : ''}>${libelleRole(v)}</option>`).join('')}
            </select></td>
            <td class="p-2 text-xs text-gray-500">${derniere}</td>
            <td class="p-2 text-right"><button class="retirer text-xs text-gray-400 hover:text-red-600" title="${t('js.retirer_du_wiki')}">✕</button></td>`;
        tr.querySelector('.choix-role').addEventListener('change', async (e) => {
            try { await deps.apiEcrire(`/api/membres/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: e.target.value }) }); }
            catch { /* message déjà affiché */ }
            chargerMembres();
        });
        tr.querySelector('.retirer').addEventListener('click', async () => {
            if (!confirm(m.id === moi?.id ? t('js.confirmer_retrait_soi') : t('js.confirmer_retrait', { nom: m.nom }))) return;
            try { await deps.apiEcrire(`/api/membres/${m.id}`, { method: 'DELETE' }); } catch { /* message déjà affiché */ }
            chargerMembres();
        });
        corps.appendChild(tr);
    }
}

export function ouvrirMembres() {
    afficherErreur('membre-erreur', '');
    $('form-membre').reset();
    // Mode Kratos : on invite par email ; un mot de passe ne sert que pour un compte local de secours
    const externe = deps.session().auth === 'externe'; // plateforme : invitation par email uniquement
    const kratos = externe || deps.session().auth === 'kratos';
    $('membre-mdp').classList.toggle('hidden', externe);
    $('membre-identifiant').placeholder = kratos ? t('js.membre_email_placeholder') : t('ui.identifiant_ou_compte_existant');
    $('membre-email').classList.toggle('hidden', kratos);
    $('membre-mdp').placeholder = kratos ? t('js.membre_mdp_secours') : t('ui.mot_de_passe_initial_nouveau_compte_10_c');
    $('membre-aide-kratos').classList.toggle('hidden', !kratos);
    $('modal-membres').classList.remove('hidden');
    chargerMembres();
}
export function fermerMembres() { $('modal-membres').classList.add('hidden'); }

function brancherFormulaireMembre() {
    $('form-membre').addEventListener('submit', async (e) => {
        e.preventDefault();
        const { ok, data } = await envoyerJson('POST', '/api/membres', {
            identifiant: $('membre-identifiant').value, role: $('membre-role').value,
            nom: $('membre-nom').value || null, email: $('membre-email').value || null, motDePasse: $('membre-mdp').value,
        });
        if (!ok) { afficherErreur('membre-erreur', messageErreur(data, t('js.ajout_impossible'))); return; }
        afficherErreur('membre-erreur', '');
        $('form-membre').reset();
        chargerMembres();
    });
}

// ------------------------------------------------------------ Mon compte

export function ouvrirMonCompte() {
    const { utilisateur, role } = deps.session();
    if (deps.session().compteExterne) { window.location.href = deps.session().compteExterne; return; } // compte géré par la plateforme
    if (utilisateur?.externe) { ouvrirCompteKratos(); return; } // email, mot de passe, double authentification : gérés par Kratos
    $('form-compte').reset();
    $('compte-identifiant').value = utilisateur?.identifiant || '';
    $('compte-info').textContent = utilisateur ? `${utilisateur.nom} (${utilisateur.identifiant}) · ${libelleRole(role)}` : '';
    $('compte-message').classList.add('hidden');
    $('modal-compte').classList.remove('hidden');
    $('compte-actuel').focus();
}
export function fermerMonCompte() { $('modal-compte').classList.add('hidden'); }

function brancherFormulaireCompte() {
    $('form-compte').addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = $('compte-message');
        const afficher = (texte, succes) => {
            message.textContent = texte;
            message.className = `text-xs ${succes ? 'text-green-700' : 'text-red-600'}`;
        };
        if ($('compte-nouveau').value !== $('compte-nouveau2').value) { afficher(t('js.nouveaux_mots_de_passe_differents'), false); return; }
        const { ok, data } = await envoyerJson('POST', '/api/compte/mot-de-passe', { actuel: $('compte-actuel').value, nouveau: $('compte-nouveau').value });
        if (!ok) { afficher(messageErreur(data, t('js.changement_impossible')), false); return; }
        $('form-compte').reset();
        afficher(t('js.mot_de_passe_modifie'), true);
    });
}

export function brancherComptes() {
    brancherFormulaireMembre();
    brancherFormulaireCompte();
}

export const actionsComptes = { ouvrirMembres, fermerMembres, ouvrirMonCompte, fermerMonCompte };
