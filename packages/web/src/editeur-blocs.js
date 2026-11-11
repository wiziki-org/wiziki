// Éditeur visuel fidèle au Markdown d'origine.
//
// Principe : chaque bloc de premier niveau (paragraphe, titre, liste, tableau…) affiché dans l'éditeur garde
// l'index du jeton Markdown dont il est issu (attribut data-bloc) et une copie de son HTML initial.
// À l'enregistrement, un bloc intact reprend sa source Markdown exacte ; seuls les blocs modifiés,
// ajoutés ou fusionnés sont reconvertis depuis le HTML (Turndown).
import { marked } from 'marked';
import { nettoyerHtml, echapperHtml, turndownService } from './markdown.js';

const REGEX_DEFINITION_LIEN = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm;

/**
 * Affiche `md` dans `conteneur` (éditeur contenteditable) et renvoie l'état nécessaire à la reconstruction.
 */
export function remplirEditeur(conteneur, md) {
    const jetons = marked.lexer(md);
    const definitions = md.match(REGEX_DEFINITION_LIEN) || []; // « [1]: http://… » ne produit pas de jeton
    const instantanes = new Map(); // index du jeton -> [outerHTML initial de chaque nœud]
    conteneur.innerHTML = '';

    jetons.forEach((jeton, i) => {
        if (jeton.type === 'space') return;
        const lot = [jeton];
        lot.links = jetons.links;
        const modele = document.createElement('template');
        modele.innerHTML = nettoyerHtml(marked.parser(lot));
        for (const noeud of [...modele.content.childNodes]) {
            if (noeud.nodeType === Node.TEXT_NODE && !noeud.textContent.trim()) continue;
            if (noeud.nodeType === Node.ELEMENT_NODE) noeud.setAttribute('data-bloc', String(i));
            conteneur.appendChild(noeud);
        }
    });

    // Instantané pris après insertion : c'est la forme exacte que le navigateur conservera si rien n'est touché
    for (const el of conteneur.children) {
        if (el.dataset.bloc === undefined) continue;
        if (!instantanes.has(el.dataset.bloc)) instantanes.set(el.dataset.bloc, []);
        instantanes.get(el.dataset.bloc).push(el.outerHTML);
    }
    return { jetons, instantanes, definitions };
}

// Jetons sans rendu visible : lignes vides, définitions de liens « [1]: http://… »
const estInvisible = jeton => jeton.type === 'space' || jeton.type === 'def';

function indexSuivantVisible(jetons, i) {
    for (let j = i + 1; j < jetons.length; j++) if (!estInvisible(jetons[j])) return j;
    return -1;
}

/**
 * Reconstruit le Markdown à partir de l'éditeur, en réutilisant la source d'origine des blocs intacts.
 */
export function reconstruireMarkdown(conteneur, etat) {
    const { jetons, instantanes, definitions } = etat;
    const noeuds = [...conteneur.childNodes];
    const dejaEmis = new Set();
    let sortie = '';
    let dernierIntact = -1; // index du dernier jeton recopié tel quel (pour recopier aussi l'espacement d'origine)

    const ajouterBloc = (md) => {
        md = md.replace(/\s+$/, '');
        if (!md.trim()) return;
        sortie = sortie ? sortie.replace(/\n*$/, '') + '\n\n' + md : md;
    };
    const ajouterConverti = (html) => {
        ajouterBloc(turndownService.turndown(html));
        dernierIntact = -1;
    };

    let k = 0;
    while (k < noeuds.length) {
        const noeud = noeuds[k];

        if (noeud.nodeType === Node.ELEMENT_NODE && noeud.dataset.bloc !== undefined) {
            const index = noeud.dataset.bloc;
            const groupe = [];
            while (k < noeuds.length && noeuds[k].nodeType === Node.ELEMENT_NODE && noeuds[k].dataset.bloc === index) {
                groupe.push(noeuds[k]);
                k++;
            }
            const attendu = instantanes.get(index) || [];
            const i = Number(index);
            const intact = !dejaEmis.has(i) && groupe.length === attendu.length && groupe.every((el, j) => el.outerHTML === attendu[j]);
            if (!intact) {
                // data-bloc n'a pas de sens dans le Markdown : on le retire avant conversion
                ajouterConverti(groupe.map(el => {
                    const copie = el.cloneNode(true);
                    copie.removeAttribute('data-bloc');
                    return copie.outerHTML;
                }).join(''));
                continue;
            }
            dejaEmis.add(i);
            if (dernierIntact >= 0 && indexSuivantVisible(jetons, dernierIntact) === i) {
                // Deux blocs intacts qui se suivaient déjà : on recopie la source d'origine, espacement compris
                sortie += jetons.slice(dernierIntact + 1, i).map(t => t.raw).join('') + jetons[i].raw;
            } else if (!sortie && indexSuivantVisible(jetons, -1) === i) {
                // Premier bloc de la page, intact : on garde aussi ce qui le précède (lignes vides, définitions)
                sortie = jetons.slice(0, i).map(t => t.raw).join('') + jetons[i].raw;
            } else {
                // Source d'origine conservée telle quelle (y compris ses sauts de ligne finaux)
                sortie = sortie ? sortie.replace(/\n*$/, '') + '\n\n' + jetons[i].raw : jetons[i].raw;
            }
            dernierIntact = i;
            continue;
        }

        // Nœud sans bloc d'origine : texte saisi directement, paragraphe ajouté, image ou tableau inséré…
        if (noeud.nodeType === Node.TEXT_NODE) {
            if (noeud.textContent.trim()) ajouterConverti(`<p>${echapperHtml(noeud.textContent)}</p>`);
        } else if (noeud.nodeType === Node.ELEMENT_NODE) {
            ajouterConverti(noeud.outerHTML);
        }
        k++;
    }

    // Fin de page : si le dernier bloc visible est intact, on recopie la fin d'origine telle quelle
    let dernierVisible = -1;
    jetons.forEach((t, j) => { if (!estInvisible(t)) dernierVisible = j; });
    if (dernierIntact >= 0 && dernierIntact === dernierVisible) {
        sortie += jetons.slice(dernierIntact + 1).map(t => t.raw).join('');
    } else {
        sortie = sortie.replace(/\s+$/, '') + (jetons.length && /\n$/.test(jetons[jetons.length - 1].raw) ? '\n' : '');
    }

    // Définitions de liens « [x]: url » qui n'ont pas pu être recopiées à leur place : ajoutées à la fin
    const manquantes = definitions.filter(d => !sortie.includes(d.trim()));
    if (manquantes.length) sortie = sortie.replace(/\s+$/, '') + '\n\n' + manquantes.join('\n') + '\n';

    return sortie;
}
