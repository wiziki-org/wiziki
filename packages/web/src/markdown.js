// Conversion Markdown ⇄ HTML.
// Règle de sécurité : tout HTML produit à partir du Markdown passe par DOMPurify avant d'être injecté dans la page.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export function echapperHtml(texte) {
    return String(texte ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function nettoyerHtml(html) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

// ---------------------------------------------------------------- Markdown → HTML (marked)

const renderer = new marked.Renderer();

// Images : « /uploads/… » forcé en chemin absolu, largeur via « ?width=400 »
renderer.image = function ({ href = '', title = '', text = '' }) {
    let src = typeof href === 'string' ? href : '';
    let style = '';
    if (src.startsWith('uploads/')) src = '/' + src;
    if (src.includes('?width=')) {
        const [chemin, largeur] = src.split('?width=');
        src = chemin;
        const px = parseInt(largeur, 10);
        if (px > 0) style = `style="width:${px}px"`;
    }
    return `<img src="${echapperHtml(src)}" alt="${echapperHtml(text)}" title="${echapperHtml(title || '')}" ${style} class="max-w-full h-auto my-4 rounded shadow-sm" />`;
};

marked.setOptions({ renderer, breaks: true, gfm: true });

export function rendreMarkdown(md) {
    return nettoyerHtml(marked.parse(md));
}

export function rendreMarkdownEnLigne(md) {
    return nettoyerHtml(marked.parseInline(md));
}

// Les liens « [texte](titre avec espaces) » ne sont pas des liens valides en Markdown :
// on les entoure de < > pour qu'ils deviennent cliquables à l'affichage (le contenu enregistré n'est pas modifié).
export function corrigerLiensAvecEspaces(md) {
    return md.replace(/(\]\()((?![a-z][a-z0-9+.-]*:)[^()<>"\n]*\s[^()<>"\n]*)\)/gi, (m, debut, cible) => `${debut}<${cible.trim()}>)`);
}

/** Sépare l'en-tête « front matter » (--- … ---, hérité de Wiki.js) du corps de la page. */
export function separerFrontMatter(texte) {
    if (texte.startsWith('---')) {
        const fin = texte.indexOf('---', 3);
        if (fin !== -1) return { frontMatter: texte.substring(0, fin + 4), corps: texte.substring(fin + 3).trim() };
    }
    return { frontMatter: '', corps: texte };
}

// ---------------------------------------------------------------- HTML → Markdown (Turndown, éditeur visuel)

export const turndownService = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
turndownService.use(gfm);

// Échappement minimal : Turndown échappe par défaut tous les « _ », « [ », « ] »… ce qui produit « AJOUT\_VISUEL ».
// On n'échappe que ce qui changerait réellement le rendu.
const estLettre = c => !!c && /[\p{L}\p{N}]/u.test(c);
turndownService.escape = (texte) => texte
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')                       // antislash devant une ponctuation
    .replace(/\*/g, '\\*')
    .replace(/_/g, (m, pos, s) => (estLettre(s[pos - 1]) && estLettre(s[pos + 1]) ? '_' : '\\_')) // « mot_mot » reste tel quel
    .replace(/`/g, '\\`')
    .replace(/\](?=[([:])/g, '\\]')                                   // « [x](y) » ne doit pas devenir un lien
    .replace(/<(?=[A-Za-z/!])/g, '&lt;')                              // « <balise » ne doit pas devenir du HTML
    .replace(/^(\s*)([-+])(?= )/gm, '$1\\$2')                         // début de ligne : liste
    .replace(/^(\s*)(#{1,6})(?= )/gm, '$1\\$2')                       // titre
    .replace(/^(\s*)>/gm, '$1\\>')                                    // citation
    .replace(/^(\s*)(=+|~~~)/gm, '$1\\$2')
    .replace(/^(\s*\d+)\.(?= )/gm, '$1\\.');                          // liste numérotée
// Saut de ligne : le wiki affiche déjà un simple retour à la ligne comme un saut (option breaks de marked),
// inutile d'ajouter les deux espaces de fin de ligne que Turndown met par défaut.
turndownService.addRule('sautDeLigne', {
    filter: 'br',
    replacement: () => '\n',
});

turndownService.addRule('imageAvecLargeur', {
    filter: 'img',
    replacement: (content, node) => {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || ''; // ne pas inventer de texte alternatif : ![](…) reste ![](…)
        const largeur = (node.getAttribute('style') || '').match(/width:\s*(\d+)px/);
        return `![${alt}](${src}${largeur ? '?width=' + largeur[1] : ''})`;
    },
});
