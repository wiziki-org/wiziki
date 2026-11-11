// Export / import du wiki complet (format ouvert .zip), réservé aux propriétaires.
import { echapperHtml } from './markdown.js';

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
        bouton.textContent = 'Import en cours…';
        zone.className = 'mt-3 text-sm text-gray-600';
        zone.textContent = `Envoi de ${(fichier.size / 1024 / 1024).toFixed(1)} Mo…`;
        try {
            const res = await deps.apiEcrire('/api/import?remplacer=1', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: fichier });
            const r = await res.json();
            zone.className = 'mt-3 text-sm text-green-800';
            zone.innerHTML = `✅ Import terminé : ${r.pages} pages, ${r.images} images, ${r.versions} versions.`
                + (r.avertissements.length ? `<details class="mt-2 text-gray-600"><summary>${r.avertissements.length} élément(s) ignoré(s)</summary><ul class="list-disc pl-5 text-xs">${r.avertissements.map(a => `<li>${echapperHtml(a)}</li>`).join('')}</ul></details>` : '')
                + '<button data-action="rechargerApresImport" class="block mt-3 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">Afficher le wiki importé</button>';
        } catch (err) {
            zone.className = 'mt-3 text-sm text-red-700';
            zone.textContent = `Import non effectué : ${err.message}`;
        } finally {
            bouton.disabled = false;
            bouton.textContent = 'Importer';
        }
    });
}

export function brancherSauvegarde() { brancherImport(); }

export const actionsSauvegarde = {
    ouvrirSauvegarde, fermerSauvegarde, telechargerExport,
    rechargerApresImport: () => window.location.reload(),
};
