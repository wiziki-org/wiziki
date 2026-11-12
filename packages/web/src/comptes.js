// Écrans liés aux comptes : installation, membres du wiki, mot de passe.
// Les dépendances (requêtes API, session courante) sont fournies par app.js via configurerComptes().
import { echapperHtml } from './markdown.js';
import { ouvrirCompteKratos } from './kratos.js';

let deps = null;
/** @param {{ apiEcrire: Function, session: () => any }} d */
export function configurerComptes(d) { deps = d; }

const LIBELLES_ROLES = { owner: 'Propriétaire', editor: 'Éditeur', reader: 'Lecteur' };
export const libelleRole = role => LIBELLES_ROLES[role] || 'Aucun rôle';

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
    if (kratos) $('inst-kratos').textContent = `Connecté avec ${deps.session().utilisateur?.email || deps.session().utilisateur?.nom || 'votre compte'}. Saisissez le jeton pour devenir propriétaire du wiki.`;
    $('modal-installation').classList.remove('hidden');
    $('inst-jeton').focus();
    return new Promise(resolve => {
        $('form-installation').onsubmit = async (e) => {
            e.preventDefault();
            if (!kratos && $('inst-mdp').value !== $('inst-mdp2').value) { afficherErreur('inst-erreur', 'Les deux mots de passe ne correspondent pas.'); return; }
            const { ok, data } = await envoyerJson('POST', '/api/installation', {
                jeton: $('inst-jeton').value.trim(), identifiant: $('inst-identifiant').value,
                nom: $('inst-nom').value, email: $('inst-email').value || null, motDePasse: $('inst-mdp').value,
            });
            if (!ok) { afficherErreur('inst-erreur', data.message || 'Installation impossible.'); return; }
            $('modal-installation').classList.add('hidden');
            resolve(data);
        };
    });
}

// ------------------------------------------------------------ Membres (propriétaires)

async function chargerMembres() {
    const corps = $('liste-membres');
    corps.innerHTML = '<tr><td class="p-3 text-gray-400" colspan="4">Chargement…</td></tr>';
    const res = await fetch('/api/membres');
    if (!res.ok) { corps.innerHTML = '<tr><td class="p-3 text-red-600" colspan="4">Liste indisponible.</td></tr>'; return; }
    const membres = await res.json();
    const moi = deps.session().utilisateur;
    corps.innerHTML = '';
    for (const m of membres) {
        const tr = document.createElement('tr');
        tr.className = 'border-t';
        const derniere = m.last_login_at ? new Date(m.last_login_at).toLocaleDateString('fr-FR') : 'jamais';
        tr.innerHTML = `
            <td class="p-2"><div class="font-medium">${echapperHtml(m.nom)}</div><div class="text-xs text-gray-400">${echapperHtml(m.identifiant)}${m.email ? ' · ' + echapperHtml(m.email) : ''}${m.sans_mot_de_passe && !m.externe ? ' · <i>invité, pas encore connecté</i>' : ''}</div></td>
            <td class="p-2"><select class="choix-role p-1 border rounded text-xs">
                ${Object.entries(LIBELLES_ROLES).map(([v, l]) => `<option value="${v}" ${v === m.role ? 'selected' : ''}>${l}</option>`).join('')}
            </select></td>
            <td class="p-2 text-xs text-gray-500">${derniere}</td>
            <td class="p-2 text-right"><button class="retirer text-xs text-gray-400 hover:text-red-600" title="Retirer du wiki">✕</button></td>`;
        tr.querySelector('.choix-role').addEventListener('change', async (e) => {
            try { await deps.apiEcrire(`/api/membres/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: e.target.value }) }); }
            catch { /* message déjà affiché */ }
            chargerMembres();
        });
        tr.querySelector('.retirer').addEventListener('click', async () => {
            const qui = m.id === moi?.id ? 'vous retirer vous-même' : `retirer ${m.nom}`;
            if (!confirm(`Voulez-vous ${qui} de ce wiki ? Le compte n'est pas supprimé.`)) return;
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
    $('membre-identifiant').placeholder = kratos ? 'Email du membre (ou identifiant existant)' : 'Identifiant (ou compte existant)';
    $('membre-email').classList.toggle('hidden', kratos);
    $('membre-mdp').placeholder = kratos ? 'Mot de passe : seulement pour un compte local de secours' : 'Mot de passe initial (nouveau compte, 10 caractères minimum)';
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
        if (!ok) { afficherErreur('membre-erreur', data.message || 'Ajout impossible.'); return; }
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
        if ($('compte-nouveau').value !== $('compte-nouveau2').value) { afficher('Les deux nouveaux mots de passe ne correspondent pas.', false); return; }
        const { ok, data } = await envoyerJson('POST', '/api/compte/mot-de-passe', { actuel: $('compte-actuel').value, nouveau: $('compte-nouveau').value });
        if (!ok) { afficher(data.message || 'Changement impossible.', false); return; }
        $('form-compte').reset();
        afficher('✅ Mot de passe modifié. Vos sessions ouvertes sur d\'autres appareils ont été fermées.', true);
    });
}

export function brancherComptes() {
    brancherFormulaireMembre();
    brancherFormulaireCompte();
}

export const actionsComptes = { ouvrirMembres, fermerMembres, ouvrirMonCompte, fermerMonCompte };
