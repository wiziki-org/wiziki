// Export / import du wiki complet (format ouvert .zip), réservé aux propriétaires.
import { echapperHtml } from './markdown.js';
import { t, messageErreur } from './i18n.js';

let deps = null;
/** @param {{ apiEcrire: Function }} d */
export function configurerSauvegarde(d) { deps = d; }

const $ = id => document.getElementById(id);

export function ouvrirSauvegarde() {
    $('form-import').reset();
    $('import-resultat').classList.add('hidden');
    $('modal-sauvegarde').classList.remove('hidden');
}
export function fermerSauvegarde() { $('modal-sauvegarde').classList.add('hidden'); }

export function telechargerExport() {
    // Téléchargement direct : le serveur répond avec « Content-Disposition: attachment »
    window.location.href = `/api/export?historique=${$('export-historique').checked ? 1 : 0}`;
}

function brancherImport() {
    $('form-import').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fichier = $('import-fichier').files[0];
        if (!fichier || !$('import-confirmer').checked) return;
        const zone = $('import-resultat');
        const bouton = $('btn-importer');
        bouton.disabled = true;
        bouton.textContent = t('js.import_en_cours');
        zone.className = 'mt-3 text-sm text-gray-600';
        zone.textContent = t('js.envoi_taille', { mo: (fichier.size / 1024 / 1024).toFixed(1) });
        try {
            const res = await deps.apiEcrire('/api/import?remplacer=1', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: fichier });
            const r = await res.json();
            zone.className = 'mt-3 text-sm text-green-800';
            zone.innerHTML = t('js.import_termine', { pages: r.pages, images: r.images, versions: r.versions })
                + (r.avertissements.length ? `<details class="mt-2 text-gray-600"><summary>${t('js.elements_ignores', { n: r.avertissements.length })}</summary><ul class="list-disc pl-5 text-xs">${r.avertissements.map(a => `<li>${echapperHtml(a)}</li>`).join('')}</ul></details>` : '')
                + '<button data-action="rechargerApresImport" class="block mt-3 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">' + t('js.afficher_wiki_importe') + '</button>';
        } catch (err) {
            zone.className = 'mt-3 text-sm text-red-700';
            zone.textContent = t('js.import_echec', { message: err.message });
        } finally {
            bouton.disabled = false;
            bouton.textContent = t('ui.importer');
        }
    });
}

export function brancherSauvegarde() { brancherImport(); }

export const actionsSauvegarde = {
    ouvrirSauvegarde, fermerSauvegarde, telechargerExport,
    rechargerApresImport: () => window.location.reload(),
};
