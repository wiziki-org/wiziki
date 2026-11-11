// Historique d'une page (versions, différences, restauration) et corbeille (pages supprimées).
import { echapperHtml, rendreMarkdown, separerFrontMatter } from './markdown.js';
import { diffLignes, zonesModifiees } from './diff.js';

let deps = null;
/** @param {{ apiEcrire: Function, pageActuelle: () => ({ id: string, titre: string }), rouvrirPage: Function, rechargerStructure: Function }} d */
export function configurerHistorique(d) { deps = d; }

const $ = id => document.getElementById(id);
const formatDate = iso => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

let versions = [];
let contenuActuel = '';
let selection = null;      // version affichée
let affichage = 'diff';    // 'diff' | 'apercu'

export async function ouvrirHistorique() {
    const { id, titre } = deps.pageActuelle();
    if (!id) return;
    $('historique-titre').textContent = `🕘 Historique : ${titre}`;
    $('historique-liste').innerHTML = '<li class="p-3 text-gray-400 text-sm">Chargement…</li>';
    $('historique-contenu').innerHTML = '';
    $('modal-historique').classList.remove('hidden');

    const res = await fetch(`/api/page/${encodeURIComponent(id)}/revisions`);
    if (!res.ok) { $('historique-liste').innerHTML = '<li class="p-3 text-red-600 text-sm">Historique indisponible.</li>'; return; }
    versions = await res.json();
    contenuActuel = versions.length ? (await (await fetch(`/api/revisions/${versions[0].id}`)).json()).contenu : '';

    const liste = $('historique-liste');
    liste.innerHTML = '';
    versions.forEach((v, i) => {
        const li = document.createElement('li');
        li.className = 'version p-2 border-b cursor-pointer hover:bg-indigo-50 text-sm';
        li.innerHTML = `<div class="font-medium">${formatDate(v.created_at)}${v.actuelle ? ' <span class="text-xs text-green-700">(actuelle)</span>' : ''}</div>
            <div class="text-xs text-gray-500">${echapperHtml(v.auteur || (i === versions.length - 1 ? 'import' : 'inconnu'))} · ${v.taille} car.</div>`;
        li.addEventListener('click', () => selectionner(v, li));
        liste.appendChild(li);
    });
    if (versions.length > 1) selectionner(versions[1], liste.children[1]);
    else if (versions.length) selectionner(versions[0], liste.children[0]);
}

async function selectionner(version, li) {
    document.querySelectorAll('#historique-liste .version').forEach(el => el.classList.remove('bg-indigo-100'));
    li.classList.add('bg-indigo-100');
    const res = await fetch(`/api/revisions/${version.id}`);
    if (!res.ok) return;
    selection = { ...version, contenu: (await res.json()).contenu };
    $('btn-restaurer-version').disabled = version.actuelle;
    $('btn-restaurer-version').classList.toggle('opacity-40', version.actuelle);
    afficherSelection();
}

function afficherSelection() {
    if (!selection) return;
    const zone = $('historique-contenu');
    document.querySelectorAll('[data-onglet-historique]').forEach(b =>
        b.classList.toggle('border-indigo-600', b.dataset.ongletHistorique === affichage));
    if (affichage === 'apercu') {
        const { corps } = separerFrontMatter(selection.contenu);
        zone.innerHTML = `<div class="prose max-w-none p-3">${corps ? rendreMarkdown(corps) : '<p class="text-gray-400 italic">Page vide.</p>'}</div>`;
        return;
    }
    if (selection.actuelle) {
        zone.innerHTML = '<p class="p-3 text-sm text-gray-500">C\'est la version actuelle. Choisissez une version plus ancienne pour voir ce qui a changé depuis.</p>';
        return;
    }
    const lignes = zonesModifiees(diffLignes(selection.contenu, contenuActuel));
    if (!lignes.length) { zone.innerHTML = '<p class="p-3 text-sm text-gray-500">Identique à la version actuelle.</p>'; return; }
    const styles = { '+': 'bg-green-50 text-green-900', '-': 'bg-red-50 text-red-900 line-through decoration-red-300', '=': 'text-gray-600', '…': 'text-gray-400 italic bg-gray-50 text-center' };
    zone.innerHTML = `<p class="px-3 py-2 text-xs text-gray-500">Ce qui a changé entre cette version et la version actuelle :
        <span class="bg-red-50 text-red-900 px-1">retiré</span> <span class="bg-green-50 text-green-900 px-1">ajouté</span></p>
        <pre class="text-xs font-mono whitespace-pre-wrap break-words">${lignes.map(l =>
            `<div class="px-3 ${styles[l.type]}">${l.type === '…' ? echapperHtml(l.texte) : `${l.type === '=' ? '&nbsp;' : l.type} ${echapperHtml(l.texte) || '&nbsp;'}`}</div>`).join('')}</pre>`;
}

export function changerAffichageHistorique(mode) { affichage = mode; afficherSelection(); }

export async function restaurerVersion() {
    if (!selection || selection.actuelle) return;
    if (!confirm(`Remettre la page telle qu'elle était le ${formatDate(selection.created_at)} ?\nLa version actuelle reste dans l'historique.`)) return;
    const { id, titre } = deps.pageActuelle();
    try {
        await deps.apiEcrire(`/api/page/${encodeURIComponent(id)}/restaurer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: selection.id }),
        });
    } catch { return; }
    fermerHistorique();
    deps.rouvrirPage(id, titre);
}

export function fermerHistorique() { $('modal-historique').classList.add('hidden'); selection = null; }

// ------------------------------------------------------------ Corbeille

export async function ouvrirCorbeille() {
    const liste = $('liste-corbeille');
    liste.innerHTML = '<li class="p-3 text-gray-400 text-sm">Chargement…</li>';
    $('modal-corbeille').classList.remove('hidden');
    const res = await fetch('/api/corbeille');
    if (!res.ok) { liste.innerHTML = '<li class="p-3 text-red-600 text-sm">Corbeille indisponible.</li>'; return; }
    const pages = await res.json();
    liste.innerHTML = pages.length ? '' : '<li class="p-3 text-gray-400 text-sm">La corbeille est vide.</li>';
    for (const p of pages) {
        const li = document.createElement('li');
        li.className = 'flex justify-between items-center gap-2 p-2 border-b text-sm';
        li.innerHTML = `<div><div class="font-medium">${echapperHtml(p.titre)}</div>
            <div class="text-xs text-gray-500">${echapperHtml(p.slug)} · supprimée le ${formatDate(p.deleted_at)}${p.supprime_par ? ' par ' + echapperHtml(p.supprime_par) : ''}</div></div>
            <button class="restaurer shrink-0 bg-indigo-600 text-white px-3 py-1 rounded text-xs font-semibold">Restaurer</button>`;
        li.querySelector('.restaurer').addEventListener('click', async () => {
            try { await deps.apiEcrire(`/api/corbeille/${p.id}/restaurer`, { method: 'POST' }); } catch { return; }
            li.remove();
            await deps.rechargerStructure();
            if (!liste.children.length) liste.innerHTML = '<li class="p-3 text-gray-400 text-sm">La corbeille est vide.</li>';
        });
        liste.appendChild(li);
    }
}

export function fermerCorbeille() { $('modal-corbeille').classList.add('hidden'); }

export const actionsHistorique = {
    ouvrirHistorique, fermerHistorique, restaurerVersion, changerAffichageHistorique, ouvrirCorbeille, fermerCorbeille,
};
