// Application du wiki : navigation, lecture, édition, arbre des pages, administration.
// Les gestionnaires d'événements sont déclarés dans main.js (aucun code JavaScript dans le HTML : CSP stricte).
import Sortable from 'sortablejs';
import {
    echapperHtml, rendreMarkdown, rendreMarkdownEnLigne, corrigerLiensAvecEspaces, turndownService,
} from './markdown.js';
import { creerIndexPages, estLienNonPage } from './liens.js';
import { remplirEditeur, reconstruireMarkdown } from './editeur-blocs.js';
import { configurerComptes, brancherComptes, installer, libelleRole, actionsComptes } from './comptes.js';
import { connexionKratos, deconnexionKratos, verifierAdresseKratos } from './kratos.js';
import { configurerHistorique, actionsHistorique } from './historique.js';
import { configurerSauvegarde, brancherSauvegarde, actionsSauvegarde } from './sauvegarde.js';

let etatEditeurBlocs = null; // lien entre les blocs affichés dans l'éditeur visuel et leur Markdown d'origine

let modeEditionActuel = 'markdown';
let frontMatterCourant = '';
// L'éditeur visuel ne reconvertit le HTML en Markdown que s'il a réellement été modifié :
// sinon on garde le Markdown d'origine tel quel (la conversion HTML → Markdown n'est pas parfaitement fidèle).
let visuelModifie = false;
function marquerVisuelModifie() { visuelModifie = true; }

// Markdown à jour : conversion depuis l'éditeur visuel seulement s'il a été modifié
function markdownCourant() {
    const editeurTexte = document.getElementById('editeur-texte');
    if (modeEditionActuel === 'visuel' && visuelModifie) {
        // Seuls les blocs modifiés sont reconvertis : les autres reprennent leur Markdown d'origine exact
        editeurTexte.value = frontMatterCourant + reconstruireMarkdown(document.getElementById('editeur-visuel'), etatEditeurBlocs);
        visuelModifie = false;
    }
    return editeurTexte.value;
}

function basculerModeEdition(mode) {
    if (mode === modeEditionActuel) return;
    const editeurTexte = document.getElementById('editeur-texte');
    const editeurVisuel = document.getElementById('editeur-visuel');
    const tabVisuel = document.getElementById('tab-mode-visuel');
    const tabMarkdown = document.getElementById('tab-mode-markdown');

    // Capturer sélection et scroll avant de basculer
    let texteSelectionne = '';
    let scrollPercent = 0;
    if (modeEditionActuel === 'visuel') {
        texteSelectionne = window.getSelection().toString();
        const plage = editeurVisuel.scrollHeight - window.innerHeight;
        scrollPercent = plage > 0 ? Math.max(0, Math.min(1, (window.scrollY - editeurVisuel.offsetTop) / plage)) : 0;
    } else {
        texteSelectionne = editeurTexte.value.substring(editeurTexte.selectionStart, editeurTexte.selectionEnd);
        const plage = editeurTexte.scrollHeight - editeurTexte.clientHeight;
        scrollPercent = plage > 0 ? editeurTexte.scrollTop / plage : 0;
    }

    if (mode === 'visuel') {
        let texte = editeurTexte.value;
        let texteAAfficher = texte;
        if (texte.startsWith('---')) {
            const fin = texte.indexOf('---', 3);
            if (fin !== -1) texteAAfficher = texte.substring(fin + 3).trim();
        }
        // Page vide : rien dans l'éditeur, le texte indicatif est affiché en CSS (il ne peut plus être enregistré)
        etatEditeurBlocs = remplirEditeur(editeurVisuel, texteAAfficher || '');
        visuelModifie = false;
        editeurVisuel.classList.remove('hidden');
        editeurTexte.classList.add('hidden');
        tabVisuel.className = 'px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 border-b-2 border-indigo-500';
        tabMarkdown.className = 'px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent';
        requestAnimationFrame(() => {
            const plage = editeurVisuel.scrollHeight - window.innerHeight;
            window.scrollTo(0, editeurVisuel.offsetTop + scrollPercent * Math.max(0, plage));
            if (texteSelectionne) selectionnerTexteInDOM(editeurVisuel, texteSelectionne);
        });
    } else {
        markdownCourant();
        editeurVisuel.classList.add('hidden');
        editeurTexte.classList.remove('hidden');
        tabMarkdown.className = 'px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 border-b-2 border-indigo-500';
        tabVisuel.className = 'px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent';
        requestAnimationFrame(() => {
            const plage = editeurTexte.scrollHeight - editeurTexte.clientHeight;
            editeurTexte.scrollTop = scrollPercent * Math.max(0, plage);
            if (texteSelectionne) {
                const idx = editeurTexte.value.indexOf(texteSelectionne);
                if (idx !== -1) { editeurTexte.focus(); editeurTexte.setSelectionRange(idx, idx + texteSelectionne.length); }
            }
        });
    }
    modeEditionActuel = mode;
    mettreAJourBoutonImage();
    mettreAJourBoutonLien();
}

function selectionnerTexteInDOM(container, texte) {
    if (!texte) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
        const idx = node.textContent.indexOf(texte);
        if (idx !== -1) {
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + texte.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return;
        }
    }
}


        let configGlobal = { parametres: { nom: "Mon Wiki", banniereActive: false, banniereUrl: "" }, arbre: [] };
        let pageActuelleId = null, pageActuelleTitre = "", isAdmin = false;
        let promessePageActuelle = Promise.resolve();
        const rubriquesOuvertes = new Set();

        const params = new URLSearchParams(window.location.search);
        const modeAdminDemande = params.get('mode') === 'admin';

        /* CONNEXION ADMINISTRATEUR : le mode admin n'est activé que si le serveur confirme la session */
        // Session courante : { connecte, utilisateur, role, installationRequise, visibilite }
        let sessionCourante = { connecte: false, utilisateur: null, role: null, installationRequise: false, visibilite: 'public' };
        const RANG_ROLE = { reader: 1, editor: 2, owner: 3 };
        const peut = minimum => (RANG_ROLE[sessionCourante.role] || 0) >= RANG_ROLE[minimum];
        async function lireSession(rafraichir = false) {
            sessionCourante = await fetch(rafraichir ? '/api/session?rafraichir=1' : '/api/session').then(r => r.json()).catch(() => sessionCourante);
            return sessionCourante;
        }

        function activerModeAdmin() {
            isAdmin = true;
            document.body.classList.add('mode-admin');
            document.body.classList.toggle('role-owner', peut('owner'));
            document.getElementById('lien-connexion').classList.add('hidden');
            document.getElementById('titre-page-lecture').classList.add('cursor-pointer', 'hover:text-indigo-600', 'transition');
            const { utilisateur, role } = sessionCourante;
            document.getElementById('status-mode').innerText = `🔧 ${utilisateur ? utilisateur.nom : ''} · ${libelleRole(role)}`;
            document.getElementById('status-mode').className = "text-xs text-center text-amber-700 font-medium bg-amber-50 py-1 rounded";
        }

        function allerConnexion() {
            window.location.href = window.location.pathname + '?mode=admin';
        }

        let resoudreConnexion = null;
        // Mode Kratos : connexion par le serveur d'identification ; le formulaire local reste accessible en secours
        async function demanderConnexion(message) {
            if (sessionCourante.auth === 'kratos') {
                const r = await connexionKratos({ message, secours: true, secondeEtape: !!sessionCourante.secondeEtape, inscription: !!sessionCourante.inscription });
                if (r === 'connecte') {
                    await lireSession(true);
                    // Double authentification activée : après le mot de passe, Kratos demande le code
                    if (sessionCourante.secondeEtape && await connexionKratos({ secondeEtape: true }) === 'connecte') await lireSession(true);
                    return sessionCourante.connecte;
                }
                if (r !== 'secours') return false;
            }
            return demanderConnexionLocale(message);
        }
        function demanderConnexionLocale(message) {
            document.getElementById('connexion-info').textContent = message || 'Connectez-vous pour modifier le wiki.';
            document.getElementById('connexion-erreur').classList.add('hidden');
            document.getElementById('input-mot-de-passe').value = '';
            const champIdentifiant = document.getElementById('input-identifiant');
            if (!champIdentifiant.value) {
                try { champIdentifiant.value = localStorage.getItem('wz_identifiant') || ''; } catch (e) { /* stockage indisponible */ }
            }
            document.getElementById('modal-connexion').classList.remove('hidden');
            (champIdentifiant.value ? document.getElementById('input-mot-de-passe') : champIdentifiant).focus();
            return new Promise(resolve => { resoudreConnexion = resolve; });
        }
        function fermerConnexion(succes = false) {
            document.getElementById('modal-connexion').classList.add('hidden');
            if (resoudreConnexion) { resoudreConnexion(succes); resoudreConnexion = null; }
        }
        document.getElementById('form-connexion').addEventListener('submit', async (e) => {
            e.preventDefault();
            const erreur = document.getElementById('connexion-erreur');
            const res = await fetch('/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    identifiant: document.getElementById('input-identifiant').value,
                    motDePasse: document.getElementById('input-mot-de-passe').value,
                })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                try { localStorage.setItem('wz_identifiant', document.getElementById('input-identifiant').value.trim()); } catch (e) { /* facultatif */ }
                await lireSession();
                fermerConnexion(true);
                return;
            }
            erreur.textContent = data.message || 'Connexion impossible.';
            erreur.classList.remove('hidden');
        });
        async function seDeconnecter() {
            if (sessionCourante.auth === 'kratos') await deconnexionKratos();
            await fetch('/api/logout', { method: 'POST' });
            window.location.href = window.location.pathname; // même page, en lecture
        }

        // Requête d'écriture vers l'API : gère la session expirée et les erreurs.
        // Renvoie la réponse si tout va bien, lève une erreur sinon (le contenu en cours d'édition n'est pas perdu).
        async function apiEcrire(url, options = {}) {
            let res = await fetch(url, options);
            if (res.status === 401) {
                const connecte = await demanderConnexion('Votre session a expiré. Reconnectez-vous pour enregistrer.');
                if (!connecte) throw new Error('Non connecté : modification non enregistrée.');
                res = await fetch(url, options);
            }
            if (!res.ok) {
                const data = await res.clone().json().catch(() => ({}));
                const message = data.message || `Erreur ${res.status}`;
                alert(`⚠️ ${message}`);
                throw new Error(message);
            }
            return res;
        }

function nettoyerTitresArbre(elements) {
            elements.forEach(el => {
                el.titre = el.titre.replace(/🏠/g, '').trim();
                if (el.enfants) nettoyerTitresArbre(el.enfants);
            });
            return elements;
        }

/* ADRESSES DES PAGES : chaque page a son URL ( /<slug> ), l'accueil est « / » */
        let indexPages = creerIndexPages([]);

        function indexerPages(arbre, orphelins, redirections) {
            const pages = flattenArbre(arbre);
            const connus = new Set(pages.map(p => p.id));
            (orphelins || []).forEach(id => { if (!connus.has(id)) pages.push({ id, titre: id.replace(/_/g, ' ') }); });
            indexPages = creerIndexPages(pages, redirections || {});
        }

        function urlDePage(slug) {
            const chemin = slug === configGlobal.parametres.pageAccueil ? '/' : '/' + encodeURIComponent(slug);
            return chemin + (modeAdminDemande ? '?mode=admin' : '');
        }

        function slugDepuisUrl() {
            const chemin = window.location.pathname.replace(/^\/+|\/+$/g, '');
            if (!chemin) return null;
            try { return decodeURIComponent(chemin); } catch (e) { return chemin; }
        }


        function preparerLiensInternes(conteneur) {
            conteneur.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href');
                if (estLienNonPage(href)) {
                    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
                    return;
                }
                const slug = indexPages.resoudre(href);
                if (slug) {
                    a.setAttribute('href', urlDePage(slug));
                    a.dataset.slug = slug;
                } else {
                    a.classList.add('lien-casse');
                    a.title = `Page introuvable : ${href}`;
                }
            });
        }

        async function chargerStructure() {
            const res = await fetch('/api/structure');
            if (res.status === 401) {
                // Wiki privé : lecture réservée aux membres
                if (await demanderConnexion('Ce wiki est privé : connectez-vous pour le consulter.')) return chargerStructure();
                document.getElementById('zone-vide').innerHTML = '<p class="text-lg">🔒 Ce wiki est privé.</p>';
                return;
            }
            if (res.status === 403) {
                document.getElementById('zone-vide').innerHTML = "<p class=\"text-lg\">🔒 Votre compte n'a pas accès à ce wiki privé.</p>";
                return;
            }
            const dataRecue = await res.json();

            configGlobal.parametres = dataRecue.parametres || { nom: "Mon Wiki", banniereActive: false, banniereUrl: "" };
            configGlobal.arbre = nettoyerTitresArbre(dataRecue.arbre || []);
            indexerPages(configGlobal.arbre, dataRecue.orphelins, dataRecue.redirections);

            document.getElementById('nom-du-wiki').innerText = configGlobal.parametres.nom;
            applyBanniereVisuel();
            if (configGlobal.parametres.couleurLiens) appliquerCouleurLiens(configGlobal.parametres.couleurLiens);
            rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre'));
            afficherOrphelins(dataRecue.orphelins);
            if (isAdmin) activerDragAndDrop();
        }

        function ouvrirDepuisUrl() {
            const slug = slugDepuisUrl() || configGlobal.parametres.pageAccueil;
            if (!slug) {
                document.getElementById('zone-lecture').classList.add('hidden');
                document.getElementById('zone-vide').classList.remove('hidden');
                return;
            }
            ouvrirPage(slug, indexPages.titre(slug) || slug.replace(/_/g, ' '), { historique: 'aucun' });
        }

        async function initialiser() {
            configurerComptes({ apiEcrire, session: () => sessionCourante });
            configurerHistorique({
                apiEcrire,
                pageActuelle: () => ({ id: pageActuelleId, titre: pageActuelleTitre }),
                rouvrirPage: (id, titre) => ouvrirPage(id, titre, { historique: 'aucun' }),
                rechargerStructure: chargerStructure,
            });
            configurerSauvegarde({ apiEcrire });
            brancherComptes();
            brancherSauvegarde();
            await lireSession();

            // Première ouverture d'une installation neuve : création du compte propriétaire
            if (sessionCourante.installationRequise) {
                // Mode Kratos : on se connecte d'abord avec son compte, le jeton le rend ensuite propriétaire
                if (sessionCourante.auth === 'kratos') {
                    while (!sessionCourante.connecte) {
                        await connexionKratos({ message: "Installation : connectez-vous, puis saisissez le jeton d'installation.", inscription: !!sessionCourante.inscription });
                        await lireSession(true);
                    }
                }
                await installer();
                await lireSession();
                if (!modeAdminDemande) { window.location.href = window.location.pathname + '?mode=admin'; return; }
            }

            if (modeAdminDemande && !isAdmin) {
                if (!sessionCourante.connecte) await demanderConnexion();
                // Mode Kratos : une invitation n'est reliée au compte qu'une fois l'adresse email vérifiée
                if (!peut('editor') && sessionCourante.connecte && sessionCourante.utilisateur?.externe && !sessionCourante.role
                    && confirm("Votre compte n'a pas encore de droits sur ce wiki.\n\nSi vous avez été invité avec votre adresse email, il faut d'abord la vérifier. Recevoir un code de vérification maintenant ?")) {
                    await verifierAdresseKratos();
                    await lireSession(true);
                }
                if (peut('editor')) activerModeAdmin();
                else if (sessionCourante.connecte) alert("Votre compte n'a pas les droits de modification sur ce wiki : vous êtes en lecture seule.");
            }

            await chargerStructure();
            ouvrirDepuisUrl();

            // Navigation : boutons précédent / suivant du navigateur et liens internes sans rechargement
            window.addEventListener('popstate', ouvrirDepuisUrl);
            document.getElementById('contenu-html').addEventListener('click', (e) => {
                const a = e.target.closest('a[data-slug]');
                if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                ouvrirPage(a.dataset.slug, indexPages.titre(a.dataset.slug) || a.dataset.slug);
                window.scrollTo(0, 0);
            });

            if (isAdmin) configurerCopierCollerImage(); // une seule fois (sinon les écouteurs s'empilent)
        }

        function afficherOrphelins(orphelins) {
            const blocOrphelins = document.getElementById('bloc-orphelins');
            const listeOrphelins = document.getElementById('liste-orphelins');
            
            listeOrphelins.innerHTML = '';
            if (isAdmin && orphelins && orphelins.length > 0) {
                blocOrphelins.classList.remove('hidden');

                orphelins.forEach(idFichier => {
                    const div = document.createElement('div');
                    div.className = "flex justify-between items-center bg-amber-50 border border-amber-200 rounded p-1.5 text-xs text-amber-900";
                    const nomAffichage = idFichier.replace(/_/g, ' ');
                    
                    // SÉCURISATION : On utilise la propriété dataset plutôt que d'écrire l'ID dans le onclick textuel
                    div.innerHTML = `
                        <span class="truncate font-medium flex-1 cursor-pointer bouton-ouvrir-orphelin" title="Voir">${echapperHtml(nomAffichage)}</span>
                        <button class="bg-amber-600 text-white px-1.5 py-0.5 rounded font-bold text-[10px] bouton-ranger-orphelin">Ranger</button>
                        <button class="bg-red-600 text-white px-1.5 py-0.5 rounded font-bold text-[10px] ml-1 bouton-supprimer-orphelin">Supprimer</button>
                    `;

                    // On attache les événements proprement en JavaScript natif
                    div.querySelector('.bouton-ouvrir-orphelin').onclick = () => ouvrirPage(idFichier, nomAffichage);
                    div.querySelector('.bouton-ranger-orphelin').onclick = () => {
                        // On nettoie l'élément de la zone orange pour éviter les doubles clics
                        div.remove();
                        if (listeOrphelins.children.length === 0) blocOrphelins.classList.add('hidden');
                        integrerFichierOrphelin(idFichier);
                    };
                    div.querySelector('.bouton-supprimer-orphelin').onclick = () => {
                        if (!confirm(`Mettre la page « ${nomAffichage} » à la corbeille ? Elle pourra être restaurée depuis « 🗑️ Corbeille ».`)) return;
                        div.remove();
                        if (listeOrphelins.children.length === 0) blocOrphelins.classList.add('hidden');
                        supprimerFichierOrphelin(idFichier);
                    };

                    listeOrphelins.appendChild(div);
                });
            } else {
                blocOrphelins.classList.add('hidden');
            }
        }

        function applyBanniereVisuel() {
            const b = configGlobal.parametres; const el = document.getElementById('banniere-site');
            // JSON.stringify produit une chaîne CSS entre guillemets correctement échappée
            if(b.banniereActive && b.banniereUrl) { el.style.backgroundImage = `url(${JSON.stringify(String(b.banniereUrl).replace(/[\n\r\f]/g, ''))})`; el.classList.remove('hidden'); } else el.classList.add('hidden');
        }

        function trouverPageDansArbre(arbre, id) {
            for (const p of arbre) {
                if (p.id === id) return p;
                if (p.enfants) { const f = trouverPageDansArbre(p.enfants, id); if (f) return f; }
            }
            return null;
        }

        function flattenArbre(arbre, result = []) {
            arbre.forEach(p => { result.push({ id: p.id, titre: p.titre }); if (p.enfants) flattenArbre(p.enfants, result); });
            return result;
        }

        function rendreArbre(elements, conteneur) {
            conteneur.innerHTML = '';
            elements.forEach(el => {
                const li = document.createElement('div');
                li.className = `page-item my-1 p-2 bg-gray-50 rounded border border-gray-200 ${isAdmin ? 'cursor-grab' : ''}`;
                li.dataset.id = el.id;
                li.dataset.titre = el.titre;
                const estAccueil = el.id === configGlobal.parametres.pageAccueil;
                const icone = estAccueil ? '<span class="text-indigo-400 mr-1 text-xs">🏠</span>' : '';
                const aDesEnfants = el.enfants && el.enfants.length > 0;
                const ouvert = rubriquesOuvertes.has(el.id);
                const chevron = aDesEnfants
                    ? `<span class="clic-page cursor-pointer select-none text-gray-400 hover:text-indigo-600 text-xs w-3 shrink-0 text-center">${ouvert ? '▾' : '▸'}</span>`
                    : `<span class="w-3 shrink-0"></span>`;
                // Le titre et l'id sont échappés et les clics attachés en JavaScript (pas de code construit à partir des données)
                li.innerHTML = `<div class="flex justify-between items-center gap-1"><div class="flex items-center gap-1 flex-1 min-w-0">${chevron}<span class="clic-page font-medium hover:text-indigo-600 cursor-pointer text-sm whitespace-nowrap">${icone}${echapperHtml(el.titre)}</span></div>${isAdmin ? `<button class="bouton-supprimer-page text-gray-400 hover:text-red-500 text-xs px-1" title="Supprimer">✕</button>` : ''}</div><div class="nested-sortable mt-1 ${aDesEnfants && !ouvert ? 'hidden' : ''}"></div>`;
                const ligne = li.firstElementChild;
                ligne.querySelectorAll('.clic-page').forEach(s => s.addEventListener('click', () => ouvrirEtDeplier(el.id, el.titre, aDesEnfants)));
                const boutonSupprimer = ligne.querySelector('.bouton-supprimer-page');
                if (boutonSupprimer) boutonSupprimer.addEventListener('click', () => supprimerPage(el.id));
                conteneur.appendChild(li);
                if (aDesEnfants) rendreArbre(el.enfants, li.querySelector('.nested-sortable'));
            });
        }

        function toggleRubrique(id) {
            if (rubriquesOuvertes.has(id)) rubriquesOuvertes.delete(id); else rubriquesOuvertes.add(id);
            rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre'));
            if (isAdmin) activerDragAndDrop();
        }

        function ouvrirEtDeplier(id, titre, aDesEnfants) {
            ouvrirPage(id, titre);
            if (aDesEnfants) toggleRubrique(id);
        }

        function activerDragAndDrop() {
            document.querySelectorAll('#menu-arbre, .nested-sortable').forEach(liste => {
                new Sortable(liste, { group: 'nested', animation: 150, onEnd: () => { configGlobal.arbre = serialiserArbre(document.getElementById('menu-arbre')); } });
            });
        }

        function serialiserArbre(conteneur) {
            const result = [];
            for (let item of conteneur.children) {
                if (item.classList.contains('page-item')) {
                    result.push({ id: item.dataset.id, titre: item.dataset.titre, enfants: serialiserArbre(item.querySelector('.nested-sortable')) });
                }
            }
            return result;
        }

        // historique : 'ajouter' (clic), 'remplacer', 'aucun' (navigation précédent/suivant, chargement initial)
        async function ouvrirPage(id, titre, { historique = 'ajouter' } = {}) {
            pageActuelleId = id; pageActuelleTitre = titre;
            document.getElementById('zone-vide').classList.add('hidden');
            document.getElementById('zone-edition').classList.add('hidden');
            document.getElementById('zone-lecture').classList.remove('hidden');
            document.getElementById('titre-page-lecture').innerText = titre;
            document.title = `${titre} — ${configGlobal.parametres.nom || 'Wiki'}`;
            const url = urlDePage(id);
            if (historique !== 'aucun' && url !== window.location.pathname + window.location.search) {
                if (historique === 'remplacer') history.replaceState(null, '', url); else history.pushState(null, '', url);
            }

            // On expose la promesse de chargement pour que passerEnEdition() puisse l'attendre
            // et éviter de basculer en édition avant que le contenu de CETTE page soit arrivé.
            promessePageActuelle = (async () => {
                const res = await fetch(`/api/page/${encodeURIComponent(id)}`);
                if (res.status === 404 || res.status === 400) {
                    document.getElementById('contenu-html').innerHTML = '<p class="text-gray-400 italic">Cette page n\'existe pas.</p>';
                    document.getElementById('editeur-texte').value = '';
                    return;
                }
                let texteBrut = res.ok ? await res.text() : '';

                // Nettoyage intelligent du Front Matter de Wiki.js (--- metadata ---)
                let texteAAfficher = texteBrut;
                if (texteBrut.startsWith('---')) {
                    const finFrontMatter = texteBrut.indexOf('---', 3);
                    if (finFrontMatter !== -1) {
                        texteAAfficher = texteBrut.substring(finFrontMatter + 3).trim();
                    }
                }

                const zoneContenu = document.getElementById('contenu-html');
                zoneContenu.innerHTML = texteAAfficher ? rendreMarkdown(corrigerLiensAvecEspaces(texteAAfficher)) : '<p class="text-gray-400 italic">Page vide.</p>';
                preparerLiensInternes(zoneContenu);
                document.getElementById('editeur-texte').value = texteBrut;
            })();
            await promessePageActuelle;
        }

        async function passerEnEdition() {
            await promessePageActuelle;
            document.getElementById('zone-lecture').classList.add('hidden');
            document.getElementById('zone-edition').classList.remove('hidden');
            const texte = document.getElementById('editeur-texte').value;
            if (texte.startsWith('---')) {
                const fin = texte.indexOf('---', 3);
                frontMatterCourant = fin !== -1 ? texte.substring(0, fin + 4) : '';
            } else { frontMatterCourant = ''; }
            modeEditionActuel = 'markdown';
            basculerModeEdition('visuel');
        }
        function annulerEdition() { ouvrirPage(pageActuelleId, pageActuelleTitre); }
        async function sauvegarderContenu() {
            let contenu = markdownCourant();
            // Nettoyage d'un ancien défaut : le texte indicatif de l'éditeur pouvait être enregistré dans la page
            contenu = contenu.replace(/^(---[\s\S]*?---\s*\n)?\s*Commencez à écrire\.\.\.\s*\n*/, (m, fm) => fm || '');
            document.getElementById('editeur-texte').value = contenu;
            // En cas d'échec on reste en mode édition : le texte n'est pas perdu
            try {
                await apiEcrire(`/api/page/${encodeURIComponent(pageActuelleId)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: contenu });
            } catch (e) { return; }
            ouvrirPage(pageActuelleId, pageActuelleTitre);
        }

        async function sauvegarderConfigurationGlobal() {
            configGlobal.arbre = serialiserArbre(document.getElementById('menu-arbre'));
            try {
                await apiEcrire('/api/structure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parametres: configGlobal.parametres, arbre: configGlobal.arbre }) });
            } catch (e) { return; }
            await chargerStructure(); // recharge l'arbre sans quitter la page en cours
        }
        
        function ajouterPage() { 
            const titre = prompt("Nom de la page ?"); if (!titre) return; 
            const idUnique = 'page_' + Date.now();
            configGlobal.arbre.push({ id: idUnique, titre, enfants: [] }); 
            rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre')); 
            activerDragAndDrop(); 
        }
        
        function supprimerPage(id) { 
            if(confirm("Supprimer la page de la liste ?")) { 
                configGlobal.arbre = filtrerArbre(configGlobal.arbre, id); 
                rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre')); 
                activerDragAndDrop(); 
            } 
        }
        function filtrerArbre(l, id) { return l.filter(e => e.id !== id).map(e => ({...e, enfants: filtrerArbre(e.enfants, id)})); }

        function genererIdDepuisTitre(titre) {
            return titre.trim().toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '') || ('page_' + Date.now());
        }

        function renommerDansArbre(elements, id, nouvelId, nouveauTitre) {
            elements.forEach(el => {
                if (el.id === id) { el.id = nouvelId; el.titre = nouveauTitre; }
                if (el.enfants) renommerDansArbre(el.enfants, id, nouvelId, nouveauTitre);
            });
        }

        async function renommerPage(id, ancienTitre) {
            const nouveauTitre = prompt("Nouveau titre de la page ?", ancienTitre);
            if (!nouveauTitre || nouveauTitre === ancienTitre) return;

            const nouvelId = genererIdDepuisTitre(nouveauTitre);
            try {
                await apiEcrire(`/api/renommer/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nouvelId }) });
            } catch (e) { return; } // apiEcrire a déjà affiché le message d'erreur

            renommerDansArbre(configGlobal.arbre, id, nouvelId, nouveauTitre);
            if (configGlobal.parametres.pageAccueil === id) configGlobal.parametres.pageAccueil = nouvelId;
            if (pageActuelleId === id) {
                pageActuelleId = nouvelId;
                pageActuelleTitre = nouveauTitre;
                document.getElementById('titre-page-lecture').innerText = nouveauTitre;
                history.replaceState(null, '', urlDePage(nouvelId));
            }

            rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre'));
            if (isAdmin) activerDragAndDrop();
            sauvegarderConfigurationGlobal();
        }

        function integrerFichierOrphelin(idFichier) {
            const nomAffichage = idFichier.replace(/_/g, ' ');
            configGlobal.arbre.push({ id: idFichier, titre: nomAffichage, enfants: [] });
            rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre'));
            activerDragAndDrop();
            sauvegarderConfigurationGlobal();
        }

        async function supprimerFichierOrphelin(idFichier) {
            try { await apiEcrire(`/api/page/${encodeURIComponent(idFichier)}`, { method: 'DELETE' }); }
            catch (e) { initialiser(); } // on réaffiche la liste réelle si la suppression a échoué
        }

        /* BARRE D'OUTILS ET STYLE */
        function insererStyle(avant, apres) {
            if (modeEditionActuel === 'visuel') {
                document.getElementById('editeur-visuel').focus();
                if (avant === '**' && apres === '**') document.execCommand('bold');
                else if (avant === '*' && apres === '*') document.execCommand('italic');
                else if (avant === '# ') document.execCommand('formatBlock', false, 'h1');
                else if (avant === '## ') document.execCommand('formatBlock', false, 'h2');
                return;
            }
            const editeur = document.getElementById('editeur-texte'); let start = editeur.selectionStart, end = editeur.selectionEnd, texte = editeur.value;
            if (avant.startsWith('#')) {
                const texteAvant = texte.substring(0, start); const debutLigneIndex = texteAvant.lastIndexOf('\n') + 1; const ligneActuelle = texte.substring(debutLigneIndex, end);
                if (ligneActuelle.startsWith(avant)) {
                    editeur.value = texte.substring(0, debutLigneIndex) + ligneActuelle.substring(avant.length) + texte.substring(end);
                    editeur.setSelectionRange(start - avant.length, end - avant.length);
                } else {
                    editeur.value = texte.substring(0, debutLigneIndex) + avant + ligneActuelle + texte.substring(end);
                    editeur.setSelectionRange(start + avant.length, end + avant.length);
                }
                editeur.focus(); return;
            }
            if (start === end) {
                const avantCurseur = texte.substring(0, start); const apresCurseur = texte.substring(start);
                const debutMotMatch = avantCurseur.match(/[a-zA-Z0-9À-ÿ\.\-]+$/); const finMotMatch = apresCurseur.match(/^[a-zA-Z0-9À-ÿ\.\-]+/);
                const debutMotIndex = debutMotMatch ? start - debutMotMatch[0].length : start; const finMotIndex = finMotMatch ? start + finMotMatch[0].length : end;
                if (debutMotIndex !== finMotIndex) { start = debutMotIndex; end = finMotIndex; editeur.setSelectionRange(start, end); }
            }
            let texteSelectionne = texte.substring(start, end);
            if (texteSelectionne.startsWith(avant) && texteSelectionne.endsWith(apres)) {
                const tNettoye = texteSelectionne.substring(avant.length, texteSelectionne.length - apres.length);
                editeur.value = texte.substring(0, start) + tNettoye + texte.substring(end);
                editeur.setSelectionRange(start, start + tNettoye.length);
            } else {
                editeur.value = texte.substring(0, start) + avant + texteSelectionne + apres + texte.substring(end);
                editeur.setSelectionRange(start, end + avant.length + apres.length);
            }
            editeur.focus();
        }

        /* LIENS */
        let lienEnEditionInfo = null; let lienEnEditionVisuel = null;

        function detecterLienSousCurseur() {
            const editeur = document.getElementById('editeur-texte');
            const texte = editeur.value;
            const curseur = editeur.selectionStart;
            const debutLigne = texte.lastIndexOf('\n', curseur - 1) + 1;
            const finLigneIdx = texte.indexOf('\n', curseur);
            const ligne = texte.substring(debutLigne, finLigneIdx === -1 ? texte.length : finLigneIdx);
            const curseurInLine = curseur - debutLigne;
            const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
            let match;
            while ((match = regex.exec(ligne)) !== null) {
                if (match.index > 0 && ligne[match.index - 1] === '!') continue;
                if (curseurInLine >= match.index && curseurInLine <= match.index + match[0].length) {
                    return { start: debutLigne + match.index, end: debutLigne + match.index + match[0].length, texte: match[1], url: match[2] };
                }
            }
            return null;
        }

        function mettreAJourBoutonLien() {
            const btn = document.getElementById('btn-ajouter-lien');
            if (!btn) return;
            if (modeEditionActuel === 'visuel') {
                btn.textContent = '🔗 Lien'; btn.classList.remove('bg-amber-600','hover:bg-amber-700'); btn.classList.add('bg-sky-600','hover:bg-sky-700'); return;
            }
            const info = detecterLienSousCurseur();
            if (info) {
                btn.textContent = '🔗 Modifier Lien'; btn.classList.remove('bg-sky-600','hover:bg-sky-700'); btn.classList.add('bg-amber-600','hover:bg-amber-700');
            } else {
                btn.textContent = '🔗 Lien'; btn.classList.remove('bg-amber-600','hover:bg-amber-700'); btn.classList.add('bg-sky-600','hover:bg-sky-700');
            }
        }

        function ouvrirBoiteLien() {
            if (modeEditionActuel === 'visuel') basculerModeEdition('markdown');
            lienEnEditionInfo = detecterLienSousCurseur();
            lienEnEditionVisuel = null;
            const edition = !!lienEnEditionInfo;
            document.getElementById('titre-modal-lien').textContent = edition ? "Modifier le lien" : "Insérer un lien";
            document.getElementById('btn-valider-lien').textContent = edition ? 'Remplacer' : 'Insérer';
            document.getElementById('input-texte-lien').value = edition ? lienEnEditionInfo.texte : '';
            document.getElementById('input-url-lien').value = edition ? lienEnEditionInfo.url : '';
            if (!edition) {
                const editeur = document.getElementById('editeur-texte');
                const sel = editeur.value.substring(editeur.selectionStart, editeur.selectionEnd);
                if (sel) document.getElementById('input-texte-lien').value = sel;
            }
            document.getElementById('modal-lien').classList.remove('hidden');
            document.getElementById('input-url-lien').focus();
        }

        function ouvrirBoiteLienVisuel(aElement) {
            lienEnEditionVisuel = aElement;
            lienEnEditionInfo = null;
            document.getElementById('titre-modal-lien').textContent = "Modifier le lien";
            document.getElementById('btn-valider-lien').textContent = 'Remplacer';
            document.getElementById('input-texte-lien').value = aElement.textContent;
            document.getElementById('input-url-lien').value = aElement.getAttribute('href') || '';
            document.getElementById('modal-lien').classList.remove('hidden');
            document.getElementById('input-url-lien').focus();
        }

        function fermerBoiteLien() { document.getElementById('modal-lien').classList.add('hidden'); lienEnEditionInfo = null; lienEnEditionVisuel = null; }

        function validerEtInsererLien() {
            const texte = document.getElementById('input-texte-lien').value;
            const url = document.getElementById('input-url-lien').value.trim();
            if (!url) { fermerBoiteLien(); return; }
            const texteAffiche = texte.trim() || url;
            if (lienEnEditionVisuel) {
                lienEnEditionVisuel.setAttribute('href', url);
                marquerVisuelModifie();
                lienEnEditionVisuel.textContent = texteAffiche;
                fermerBoiteLien(); return;
            }
            const nouveauCode = `[${texteAffiche}](${url})`;
            const editeur = document.getElementById('editeur-texte');
            if (lienEnEditionInfo) {
                editeur.value = editeur.value.substring(0, lienEnEditionInfo.start) + nouveauCode + editeur.value.substring(lienEnEditionInfo.end);
                editeur.setSelectionRange(lienEnEditionInfo.start, lienEnEditionInfo.start + nouveauCode.length);
            } else {
                const s = editeur.selectionStart, e = editeur.selectionEnd;
                editeur.value = editeur.value.substring(0, s) + nouveauCode + editeur.value.substring(e);
                editeur.setSelectionRange(s, s + nouveauCode.length);
            }
            editeur.focus();
            fermerBoiteLien();
        }

        /* IMAGES COPIER COLLER ET APPARAUX */
        let urlImageSelectionneeDuServeur = null; let ongletActuel = 'tab-upload'; let imageEnEditionInfo = null; let imgEnEditionVisuel = null;

        function detecterImageSousCurseur() {
            const editeur = document.getElementById('editeur-texte');
            const texte = editeur.value;
            const curseur = editeur.selectionStart;
            const debutLigne = texte.lastIndexOf('\n', curseur - 1) + 1;
            const finLigneIdx = texte.indexOf('\n', curseur);
            const ligne = texte.substring(debutLigne, finLigneIdx === -1 ? texte.length : finLigneIdx);
            const match = /!\[([^\]]*)\]\(([^)]+)\)/.exec(ligne);
            if (!match) return null;
            let url = match[2], width = '';
            if (url.includes('?width=')) { const p = url.split('?width='); url = p[0]; width = p[1]; }
            return { start: debutLigne + match.index, end: debutLigne + match.index + match[0].length, url, width };
        }

        function mettreAJourBoutonImage() {
            const btn = document.getElementById('btn-ajouter-image');
            if (!btn) return;
            if (modeEditionActuel === 'visuel') {
                btn.textContent = '🖼️ Ajouter Image';
                btn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
                btn.classList.add('bg-emerald-600', 'hover:bg-emerald-700');
                return;
            }
            const info = detecterImageSousCurseur();
            if (info) {
                btn.textContent = '🖼️ Modifier Image';
                btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-700');
                btn.classList.add('bg-blue-600', 'hover:bg-blue-700');
            } else {
                btn.textContent = '🖼️ Ajouter Image';
                btn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
                btn.classList.add('bg-emerald-600', 'hover:bg-emerald-700');
            }
        }

        function ouvrirBoiteImage() {
            if (modeEditionActuel === 'visuel') basculerModeEdition('markdown');
            imageEnEditionInfo = detecterImageSousCurseur();
            document.querySelector('#modal-image h3').textContent = imageEnEditionInfo ? "Modifier l'image" : "Options de l'image";
            document.getElementById('btn-valider-image').textContent = imageEnEditionInfo ? 'Remplacer' : 'Insérer';
            document.getElementById('input-taille-image').value = imageEnEditionInfo ? (imageEnEditionInfo.width || '') : '';
            document.getElementById('input-url-image').value = '';
            document.getElementById('input-file-image').value = '';
            urlImageSelectionneeDuServeur = null;
            if (imageEnEditionInfo && !imageEnEditionInfo.url.startsWith('http')) {
                changerOngletImage('tab-serveur');
            } else if (imageEnEditionInfo) {
                changerOngletImage('tab-url');
                document.getElementById('input-url-image').value = imageEnEditionInfo.url;
            } else {
                changerOngletImage('tab-upload');
            }
            document.getElementById('modal-image').classList.remove('hidden');
        }
        function fermerBoiteImage() { document.getElementById('modal-image').classList.add('hidden'); imageEnEditionInfo = null; imgEnEditionVisuel = null; }
        function changerOngletImage(idOnglet) {
            ongletActuel = idOnglet; document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active', 'border-indigo-600', 'text-indigo-600'));
            document.getElementById(`btn-${idOnglet}`).classList.add('active', 'border-indigo-600', 'text-indigo-600');
            document.querySelectorAll('.onglet-contenu').forEach(c => c.classList.add('hidden')); document.getElementById(idOnglet).classList.remove('hidden');
            if(idOnglet === 'tab-serveur') chargerGalerieServeur();
        }
        async function chargerGalerieServeur() {
            const c = document.getElementById('galerie-serveur'); c.innerHTML = '';
            const res = await fetch('/api/images');
            if (!res.ok) { c.textContent = 'Galerie indisponible (session expirée ?).'; return; }
            const list = await res.json();
            list.forEach(u => {
                const w = document.createElement('div'); w.className = "border rounded p-1 cursor-pointer thumbnail-img";
                const urlNormalisee = u.replace(/^\//, '');
                const urlEditionNormalisee = imageEnEditionInfo ? imageEnEditionInfo.url.replace(/^\//, '')
                    : (imgEnEditionVisuel ? (imgEnEditionVisuel.getAttribute('src') || '').replace(/^\//, '') : null);
                const estSelectionnee = urlEditionNormalisee && (urlNormalisee === urlEditionNormalisee);
                if (estSelectionnee) { w.classList.add('ring-2', 'ring-emerald-500'); urlImageSelectionneeDuServeur = u; }
                const vignette = document.createElement('img');
                vignette.src = u; vignette.className = 'w-full h-12 object-cover'; vignette.loading = 'lazy';
                w.appendChild(vignette);
                w.onclick = () => {
                    urlImageSelectionneeDuServeur = u;
                    document.querySelectorAll('.thumbnail-img').forEach(t => t.classList.remove('ring-2', 'ring-emerald-500'));
                    w.classList.add('ring-2', 'ring-emerald-500');
                };
                c.appendChild(w);
            });
        }
        async function envoyerFichierImage(fileBlob) {
            // Le serveur détermine lui-même le type réel de l'image
            const res = await apiEcrire('/api/upload', { method: 'POST', body: fileBlob, headers: { 'Content-Type': 'application/octet-stream' } });
            const data = await res.json(); return data.url;
        }
        async function validerEtInsererImage() {
            let url = "";
            if (ongletActuel === 'tab-upload') {
                const file = document.getElementById('input-file-image').files[0];
                if (file) { try { url = await envoyerFichierImage(file); } catch (e) { return; } }
                else if (imageEnEditionInfo) url = imageEnEditionInfo.url;
                else if (imgEnEditionVisuel) url = imgEnEditionVisuel.getAttribute('src') || '';
                else { fermerBoiteImage(); return; }
            } else if (ongletActuel === 'tab-url') {
                url = document.getElementById('input-url-image').value;
            } else {
                url = urlImageSelectionneeDuServeur;
            }
            if (!url) { fermerBoiteImage(); return; }
            const w = document.getElementById('input-taille-image').value;
            if (imgEnEditionVisuel) {
                imgEnEditionVisuel.setAttribute('src', url);
                marquerVisuelModifie();
                if (w) imgEnEditionVisuel.setAttribute('style', `width:${w}px`);
                else imgEnEditionVisuel.removeAttribute('style');
                fermerBoiteImage();
                return;
            }
            const nouveauCode = `![Image](${url}${w ? '?width='+w : ''})`;
            const editeur = document.getElementById('editeur-texte');
            if (imageEnEditionInfo) {
                editeur.value = editeur.value.substring(0, imageEnEditionInfo.start) + nouveauCode + editeur.value.substring(imageEnEditionInfo.end);
                editeur.setSelectionRange(imageEnEditionInfo.start, imageEnEditionInfo.start + nouveauCode.length);
                editeur.focus();
            } else {
                insererStyle(`\n${nouveauCode}\n`, "");
            }
            imageEnEditionInfo = null;
            fermerBoiteImage();
        }
        function configurerCopierCollerImage() {
            const editeur = document.getElementById('editeur-texte');
            editeur.addEventListener('paste', async (e) => {
                const items = (e.clipboardData || e.originalEvent.clipboardData).items;
                for (let item of items) {
                    if (item.type.indexOf("image") === 0) {
                        e.preventDefault();
                        let url; try { url = await envoyerFichierImage(item.getAsFile()); } catch (err) { return; }
                        insererStyle(`\n![Image](${url}?width=400)\n`, "");
                    }
                }
            });
            document.addEventListener('selectionchange', () => {
                if (document.activeElement === editeur) { mettreAJourBoutonImage(); mettreAJourBoutonLien(); }
            });
            document.getElementById('editeur-visuel').addEventListener('click', (e) => {
                const img = e.target.closest('img');
                const table = e.target.closest('table');
                const lien = e.target.closest('a');
                if (img) { e.preventDefault(); ouvrirBoiteImageVisuel(img); }
                else if (table) { e.preventDefault(); ouvrirTableauDepuisVisuel(table); }
                else if (lien) { e.preventDefault(); ouvrirBoiteLienVisuel(lien); }
            });
        }

        function ouvrirBoiteImageVisuel(imgElement) {
            imgEnEditionVisuel = imgElement;
            imageEnEditionInfo = null;
            const src = imgElement.getAttribute('src') || '';
            const style = imgElement.getAttribute('style') || '';
            const widthMatch = style.match(/width:\s*(\d+)px/);
            document.querySelector('#modal-image h3').textContent = "Modifier l'image";
            document.getElementById('btn-valider-image').textContent = 'Remplacer';
            document.getElementById('input-taille-image').value = widthMatch ? widthMatch[1] : '';
            document.getElementById('input-url-image').value = '';
            document.getElementById('input-file-image').value = '';
            urlImageSelectionneeDuServeur = null;
            if (!src.startsWith('http')) { changerOngletImage('tab-serveur'); }
            else { changerOngletImage('tab-url'); document.getElementById('input-url-image').value = src; }
            document.getElementById('modal-image').classList.remove('hidden');
        }

        /* MODULE TABLEAU RE-EDITION INTELLIGENTE */
        let tableauEnEditionInfo = null; let colonnesActuelles = 3, lignesActuelles = 3; let tableEnEditionVisuel = null;
        function markdownCellToHtml(md) {
            if (!md) return '';
            return rendreMarkdownEnLigne(md);
        }

        function cellHtmlToMarkdown(html) {
            if (!html) return '';
            return turndownService.turndown(html).trim().replace(/\n+/g, ' ');
        }

        function ouvrirModuleTableau() {
            if (modeEditionActuel === 'visuel') basculerModeEdition('markdown');
            const editeur = document.getElementById('editeur-texte'); const texte = editeur.value; const curseurPos = editeur.selectionStart;
            const lignes = texte.split('\n'); let indexCaractereCumule = 0; let ligneCurseurIndex = 0;
            for (let i = 0; i < lignes.length; i++) {
                indexCaractereCumule += lignes[i].length + 1; if (curseurPos < indexCaractereCumule) { ligneCurseurIndex = i; break; }
            }
            if (lignes[ligneCurseurIndex] && lignes[ligneCurseurIndex].includes('|')) {
                let d = ligneCurseurIndex, f = ligneCurseurIndex;
                while (d > 0 && lignes[d - 1].includes('|')) d--; while (f < lignes.length - 1 && lignes[f + 1].includes('|')) f++;
                let lTab = lignes.slice(d, f + 1).filter(l => !l.match(/^\|[\s---|-]*\|$/));
                if (lTab.length > 0) {
                    tableauEnEditionInfo = {
                        start: lignes.slice(0, d).join('\n').length + (d > 0 ? 1 : 0),
                        end: lignes.slice(0, f + 1).join('\n').length
                    };
                    let matrice = lTab.map(l => {
                        let c = l.split('|').map(x => x.trim()); if (c[0] === "") c.shift(); if (c[c.length - 1] === "") c.pop();
                        return c.map(cell => markdownCellToHtml(cell));
                    });
                    colonnesActuelles = Math.max(...matrice.map(r => r.length), 2); lignesActuelles = matrice.length - 1;
                    document.getElementById('modal-tableau').classList.remove('hidden'); construireGrilleExcel(matrice); return;
                }
            }
            tableauEnEditionInfo = null; colonnesActuelles = 3; lignesActuelles = 3;
            document.getElementById('modal-tableau').classList.remove('hidden'); construireGrilleExcel();
        }

        function construireGrilleExcel(donnees = null) {
            const g = document.getElementById('grille-excel'); g.innerHTML = '';
            const th = document.createElement('tr');
            for (let c = 0; c < colonnesActuelles; c++) {
                const cell = document.createElement('th');
                cell.className = 'border p-1 bg-gray-100';
                const div = document.createElement('div');
                div.contentEditable = 'true';
                div.className = 'text-xs font-bold text-center';
                div.innerHTML = (donnees && donnees[0] && donnees[0][c] !== undefined) ? donnees[0][c] : '';
                cell.appendChild(div); th.appendChild(cell);
            }
            g.appendChild(th);
            for (let r = 0; r < lignesActuelles; r++) {
                const tr = document.createElement('tr');
                for (let c = 0; c < colonnesActuelles; c++) {
                    const cell = document.createElement('td');
                    cell.className = 'border p-1';
                    const div = document.createElement('div');
                    div.contentEditable = 'true';
                    div.className = 'text-xs';
                    div.innerHTML = (donnees && donnees[r + 1] && donnees[r + 1][c] !== undefined) ? donnees[r + 1][c] : '';
                    cell.appendChild(div); tr.appendChild(cell);
                }
                g.appendChild(tr);
            }
        }

        function modifierGrille(act) {
            const rows = Array.from(document.getElementById('grille-excel').querySelectorAll('tr'));
            const donneesActuelles = rows.map(row => Array.from(row.querySelectorAll('[contenteditable]')).map(d => d.innerHTML));
            if (act === 'add-row') { lignesActuelles++; donneesActuelles.push([]); }
            if (act === 'add-col') colonnesActuelles++;
            construireGrilleExcel(donneesActuelles);
        }

        function injecterTableauDansEditeur() {
            const rows = document.getElementById('grille-excel').querySelectorAll('tr');
            let md = "\n", ent = [];
            rows[0].querySelectorAll('[contenteditable]').forEach(d => ent.push(cellHtmlToMarkdown(d.innerHTML) || " "));
            md += "| " + ent.join(" | ") + " |\n|" + Array(colonnesActuelles).fill("---").join(" | ") + " |\n";
            for (let i = 1; i < rows.length; i++) {
                let d = []; rows[i].querySelectorAll('[contenteditable]').forEach(div => d.push(cellHtmlToMarkdown(div.innerHTML) || " "));
                md += "| " + d.join(" | ") + " |\n";
            }
            if (tableEnEditionVisuel) {
                const temp = document.createElement('div');
                temp.innerHTML = rendreMarkdown(md.trim());
                const newTable = temp.querySelector('table');
                if (newTable) { tableEnEditionVisuel.replaceWith(newTable); marquerVisuelModifie(); }
                fermerModuleTableau(); return;
            }
            const editeur = document.getElementById('editeur-texte');
            if (tableauEnEditionInfo) {
                editeur.value = editeur.value.substring(0, tableauEnEditionInfo.start) + md.trim() + editeur.value.substring(tableauEnEditionInfo.end);
            } else { insererStyle(md, ""); }
            fermerModuleTableau();
        }

        function ouvrirTableauDepuisVisuel(tableElement) {
            tableEnEditionVisuel = tableElement;
            tableauEnEditionInfo = null;
            const rows = Array.from(tableElement.querySelectorAll('tr'));
            const matrice = rows.map(row => Array.from(row.querySelectorAll('th, td')).map(c => c.innerHTML));
            colonnesActuelles = Math.max(...matrice.map(r => r.length), 2);
            lignesActuelles = Math.max(matrice.length - 1, 1);
            document.getElementById('modal-tableau').classList.remove('hidden');
            construireGrilleExcel(matrice);
        }

        function fermerModuleTableau() { document.getElementById('modal-tableau').classList.add('hidden'); tableEnEditionVisuel = null; }

function convertirDokuWikiEnMarkdown() {
    if (modeEditionActuel === 'visuel') basculerModeEdition('markdown');
    const editeur = document.getElementById('editeur-texte');
    let texte = editeur.value;

    if (!texte.trim()) return;

    // Sauvegarde de la position du curseur
    const positionCurseur = editeur.selectionStart;

    // 1. NETTOYAGE DES MACROS ET CODES SPÉCIFIQUES DOKUWIKI
    texte = texte.replace(/~~NOTOC~~/gi, '');
    texte = texte.replace(/~~NOCACHE~~/gi, '');

    // 2. CONVERSION DES TITRES (de ====== à ==)
    texte = texte.replace(/^======\s*(.*?)\s*======/gm, '## $1');
    texte = texte.replace(/^=====\s*(.*?)\s*=====/gm, '### $1');
    texte = texte.replace(/^====\s*(.*?)\s*====/gm, '#### $1');
    texte = texte.replace(/^===\s*(.*?)\s*===/gm, '##### $1');
    texte = texte.replace(/^==\s*(.*?)\s*==/gm, '###### $1');

    // 3. EN-TÊTES ET CELLULES DE TABLEAUX (Gestion des lignes complexes)
    // Remplacement des séparateurs d'en-tête DokuWiki "^" par des "|" Markdown
    texte = texte.replace(/\^/g, '|');

    // Reconstruction ligne par ligne pour injecter la séparation d'en-tête Markdown (---)
    let lignes = texte.split('\n');
    let enTableau = false;

    for (let i = 0; i < lignes.length; i++) {
        let ligne = lignes[i].trim();

        if (ligne.startsWith('|')) {
            // Nettoyage des espaces doubles créés par DokuWiki
            let cellules = ligne.split('|').map(c => c.trim());
            
            // Recalibrer les extrémités vides
            if (cellules[0] === "") cellules.shift();
            if (cellules[cellules.length - 1] === "") cellules.pop();

            lignes[i] = "| " + cellules.join(" | ") + " |";

            // Si c'est le début d'un tableau, on génère la ligne de structure Markdown réglementaire
            if (!enTableau) {
                enTableau = true;
                let ligneSeparation = "|" + Array(cellules.length).fill(" --- ").join("|") + "|";
                lignes[i] = lignes[i] + "\n" + ligneSeparation;
            }
        } else {
            enTableau = false;
        }
    }
    texte = lignes.join('\n');

    // 4. MISES EN FORME TEXTUELLES STANDARDS
    texte = texte.replace(/\/\/(.*?)\/\//g, '*$1*');   // Italique : //texte// -> *texte*
    texte = texte.replace(/__(.*?)__/g, '<u>$1</u>');    // Souligné : __texte__ -> <u>texte</u>
    texte = texte.replace(/<del>(.*?)<\/del>/g, '~~$1~~'); // Barré
    texte = texte.replace(/<code\b[^>]*>(.*?)<\/code>/gi, '`$1`'); // Code en ligne

    // 5. LIENS ET IMAGES DOKUWIKI
    // Liens internes/externes : [[url|nom]] ou [[url]] -> [nom](url)
    texte = texte.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '[$2]($1)');
    texte = texte.replace(/\[\[([^\]]+)\]\]/g, '[$1]($1)');

    // Images : {{fichier.png|titre}} ou {{fichier.png}} -> ![titre](fichier.png)
    texte = texte.replace(/\{\{([^|\]}]+)\|([^}]+)\}\}/g, '![$2]($1)');
    texte = texte.replace(/\{\{([^}]+)\}\}/g, '![Image]($1)');

    // 6. LISTES À PUCES
    // DokuWiki utilise des indentations d'espaces suivies de * ou -
    texte = texte.replace(/^(\s{2,})\*\s/gm, '- ');
    texte = texte.replace(/^(\s{2,})-\s/gm, '- ');

    // Application immédiate dans l'éditeur
    editeur.value = texte;

    // Restitution précise du focus et de la position de saisie
    editeur.focus();
    editeur.setSelectionRange(positionCurseur, positionCurseur);
}

        /* BANNIERE ET PARAMETRES */
        function appliquerCouleurLiens(couleur) {
            if (!/^#[0-9a-f]{3,8}$/i.test(couleur || '')) return; // seule une couleur hexadécimale est injectée dans le CSS
            let el = document.getElementById('style-couleur-liens');
            if (!el) { el = document.createElement('style'); el.id = 'style-couleur-liens'; document.head.appendChild(el); }
            el.textContent = `.prose a, #editeur-visuel a { color: ${couleur} !important; } #editeur-visuel a { text-decoration: underline; }`;
        }
        function previsualiserCouleurLiens(couleur) { appliquerCouleurLiens(couleur); }
        function ouvrirParametres() {
            document.getElementById('param-visibilite').value = sessionCourante.visibilite || 'public';
            document.getElementById('param-nom').value = configGlobal.parametres.nom;
            document.getElementById('param-banniere-active').checked = configGlobal.parametres.banniereActive;
            document.getElementById('param-banniere-url').value = configGlobal.parametres.banniereUrl || "";
            document.getElementById('param-couleur-liens').value = configGlobal.parametres.couleurLiens || '#4f46e5';
            const sel = document.getElementById('param-page-accueil');
            sel.innerHTML = '<option value="">-- Aucune --</option>';
            flattenArbre(configGlobal.arbre).forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id; opt.textContent = p.titre;
                if (p.id === configGlobal.parametres.pageAccueil) opt.selected = true;
                sel.appendChild(opt);
            });
            toggleChampBanniere();
            document.getElementById('modal-parametres').classList.remove('hidden');
        }
        function fermerParametres() { document.getElementById('modal-parametres').classList.add('hidden'); }
        function toggleChampBanniere() { document.getElementById('bloc-url-banniere').style.display = document.getElementById('param-banniere-active').checked ? 'block' : 'none'; }
        async function appliquerParametres() {
            // Visibilité : appliquée tout de suite (propriétaires uniquement)
            const visibilite = document.getElementById('param-visibilite').value;
            if (peut('owner') && visibilite !== sessionCourante.visibilite) {
                try {
                    await apiEcrire('/api/wiki/visibilite', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibilite }) });
                    sessionCourante.visibilite = visibilite;
                } catch (e) { return; }
            }
            configGlobal.parametres.nom = document.getElementById('param-nom').value;
            configGlobal.parametres.banniereActive = document.getElementById('param-banniere-active').checked;
            configGlobal.parametres.banniereUrl = document.getElementById('param-banniere-url').value;
            configGlobal.parametres.couleurLiens = document.getElementById('param-couleur-liens').value;
            configGlobal.parametres.pageAccueil = document.getElementById('param-page-accueil').value;
            document.getElementById('nom-du-wiki').innerText = configGlobal.parametres.nom;
            applyBanniereVisuel();
            appliquerCouleurLiens(configGlobal.parametres.couleurLiens);
            rendreArbre(configGlobal.arbre, document.getElementById('menu-arbre'));
            if (isAdmin) activerDragAndDrop();
            fermerParametres();
        }

        // Toute frappe, collage ou mise en forme dans l'éditeur visuel le marque comme modifié
        document.getElementById('editeur-visuel').addEventListener('input', marquerVisuelModifie);

/* ACTIONS déclenchées depuis le HTML (attributs data-action, data-entree, data-on-change, data-on-input) */
export const actions = {
    ...actionsComptes,
    ...actionsHistorique,
    ...actionsSauvegarde,
    allerConnexion,
    ajouterPage,
    annulerEdition,
    appliquerParametres,
    basculerModeEdition,
    changerOngletImage,
    convertirDokuWikiEnMarkdown,
    fermerBoiteImage,
    fermerBoiteLien,
    fermerConnexion,
    fermerModuleTableau,
    fermerParametres,
    injecterTableauDansEditeur,
    insererStyle,
    modifierGrille,
    ouvrirBoiteImage,
    ouvrirBoiteLien,
    ouvrirModuleTableau,
    ouvrirParametres,
    passerEnEdition,
    previsualiserCouleurLiens,
    sauvegarderConfigurationGlobal,
    sauvegarderContenu,
    seDeconnecter,
    toggleChampBanniere,
    validerEtInsererImage,
    validerEtInsererLien,
    renommerPageActuelle: () => renommerPage(pageActuelleId, pageActuelleTitre),
    renommerPageActuelleSiAdmin: () => { if (isAdmin) renommerPage(pageActuelleId, pageActuelleTitre); },
    reinitialiserCouleurLiens: () => {
        document.getElementById('param-couleur-liens').value = '#4f46e5';
        previsualiserCouleurLiens('#4f46e5');
    },
};

export { initialiser };
