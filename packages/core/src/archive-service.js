// Export / import d'un wiki complet dans un format ouvert (voir docs/format-export.md).
// Le cœur travaille sur une Map « chemin → octets » ; la mise en ZIP est faite par l'adaptateur d'archive.
import path from 'node:path';
import {
    ErreurWiki, REGEX_SLUG, REGEX_CLE_FICHIER, PROFONDEUR_MAX_ARBRE, TAILLE_MAX_PAGE, TAILLE_MAX_IMAGE,
    TYPES_MIME, detecterTypeImage, nettoyerParametres,
} from './validation.js';

export const FORMAT_EXPORT = 'wiziki-export';
export const VERSION_FORMAT = 1;
const maintenant = () => new Date().toISOString();
const decodeur = new TextDecoder('utf-8');

/** Arbre reçu d'une source extérieure : on ignore (avec un avertissement) ce qui est invalide au lieu de tout refuser. */
export function arbreTolerant(elements, avertir, vus = new Set(), profondeur = 0) {
    if (!Array.isArray(elements)) return [];
    return elements.flatMap(el => {
        if (!el || typeof el.id !== 'string' || !REGEX_SLUG.test(el.id)) { avertir(`élément d'arbre invalide ignoré : ${String(el?.id).slice(0, 60)}`); return []; }
        if (vus.has(el.id)) { avertir(`page en double dans l'arbre ignorée : ${el.id}`); return []; }
        vus.add(el.id);
        let enfants = [];
        if (profondeur >= PROFONDEUR_MAX_ARBRE) {
            if (el.enfants?.length) avertir(`arbre trop profond sous « ${el.id} » : ses sous-pages deviennent non classées`);
        } else enfants = arbreTolerant(el.enfants, avertir, vus, profondeur + 1);
        const titre = typeof el.titre === 'string' && el.titre.trim() ? el.titre.slice(0, 300) : el.id;
        return [{ id: el.id, titre, enfants }];
    });
}

const dateValide = (v, defaut) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : defaut);

async function fluxVersOctets(flux) {
    const morceaux = [];
    for await (const m of flux) morceaux.push(m);
    return Buffer.concat(morceaux);
}

export function creerServiceArchive({ db, storage, wikis, logiciel = { nom: 'wiziki' } }) {

    // ---------------------------------------------------------------- Export

    /** @returns {Promise<Map<string, Uint8Array|string>>} */
    async function exporterWiki(wikiId, { historique = true } = {}) {
        const wiki = await wikis.trouverWikiParId(wikiId);
        if (!wiki) throw new ErreurWiki(404, 'Wiki introuvable.');
        const structure = await wikis.lireStructure(wikiId);
        const pages = await db.selectFrom('pages')
            .select(['id', 'slug', 'titre', 'contenu', 'created_at', 'updated_at'])
            .where('wiki_id', '=', wikiId).where('deleted_at', 'is', null).orderBy('id').execute();
        const fichiers = new Map();

        const manifestePages = [];
        for (const p of pages) {
            const entree = { slug: p.slug, titre: p.titre, fichier: `pages/${p.slug}.md`, cree_le: p.created_at, modifie_le: p.updated_at };
            fichiers.set(entree.fichier, p.contenu);
            if (historique) {
                const versions = await db.selectFrom('revisions').leftJoin('users', 'users.id', 'revisions.author_id')
                    .select(['revisions.titre', 'revisions.contenu', 'revisions.created_at', 'users.nom', 'revisions.auteur_nom'])
                    .where('revisions.page_id', '=', p.id).orderBy('revisions.id').execute();
                entree.revisions = versions.map((v, i) => {
                    const fichier = `revisions/${p.slug}/${String(i + 1).padStart(4, '0')}.md`;
                    fichiers.set(fichier, v.contenu);
                    return { fichier, titre: v.titre, date: v.created_at, auteur: v.nom ?? v.auteur_nom ?? null };
                });
            }
            manifestePages.push(entree);
        }

        const medias = await db.selectFrom('media').select(['cle', 'mime']).where('wiki_id', '=', wikiId).orderBy('id').execute();
        const manifesteFichiers = [];
        for (const m of medias) {
            try {
                fichiers.set(m.cle, await fluxVersOctets(storage.lireFlux(wikiId, m.cle)));
                manifesteFichiers.push({ chemin: m.cle, type: m.mime });
            } catch { /* fichier référencé mais absent du disque : ignoré */ }
        }

        const manifeste = {
            format: FORMAT_EXPORT,
            version: VERSION_FORMAT,
            exporte_le: maintenant(),
            logiciel,
            wiki: { nom: wiki.nom, parametres: JSON.parse(wiki.parametres || '{}') },
            arbre: structure.arbre,
            pages: manifestePages,
            redirections: structure.redirections,
            fichiers: manifesteFichiers,
        };
        // wiki.json en premier : on comprend l'archive en l'ouvrant
        return new Map([['wiki.json', JSON.stringify(manifeste, null, 2) + '\n'], ...fichiers]);
    }

    // ---------------------------------------------------------------- Import

    /** Lit et vérifie toute l'archive avant de toucher au wiki. */
    function preparerImport(fichiers) {
        const avertissements = [];
        const avertir = m => { if (avertissements.length < 500) avertissements.push(m); };
        const texte = chemin => decodeur.decode(fichiers.get(chemin));

        if (!fichiers.has('wiki.json')) throw new ErreurWiki(400, "Archive non reconnue : le fichier wiki.json est absent. S'agit-il bien d'un export Wiziki ?");
        let manifeste;
        try { manifeste = JSON.parse(texte('wiki.json')); } catch { throw new ErreurWiki(400, 'Archive invalide : wiki.json illisible.'); }
        if (manifeste?.format !== FORMAT_EXPORT) throw new ErreurWiki(400, "Archive non reconnue : ce n'est pas un export Wiziki.");
        if (!(manifeste.version <= VERSION_FORMAT)) {
            throw new ErreurWiki(400, `Cet export a été fait par une version plus récente de Wiziki (format ${manifeste.version}). Mettez Wiziki à jour pour l'importer.`);
        }
        const date = maintenant();

        // Pages : celles du manifeste, puis les fichiers pages/*.md qu'il ne cite pas (archive retouchée à la main)
        const pages = new Map();
        const ajouterPage = (slug, infos, fichier) => {
            if (!REGEX_SLUG.test(slug)) { avertir(`page ignorée (nom invalide) : ${slug}`); return; }
            if (pages.has(slug)) { avertir(`page en double ignorée : ${slug}`); return; }
            if (!fichiers.has(fichier)) { avertir(`page ignorée (fichier absent) : ${fichier}`); return; }
            if (fichiers.get(fichier).length > TAILLE_MAX_PAGE) { avertir(`page ignorée (trop volumineuse) : ${slug}`); return; }
            const modifie = dateValide(infos.modifie_le, date);
            const page = {
                slug, contenu: texte(fichier), modifie_le: modifie, cree_le: dateValide(infos.cree_le, modifie),
                titre: typeof infos.titre === 'string' && infos.titre.trim() ? infos.titre.slice(0, 300) : slug.replace(/_/g, ' '),
                revisions: [],
            };
            for (const r of Array.isArray(infos.revisions) ? infos.revisions : []) {
                if (typeof r?.fichier !== 'string' || !fichiers.has(r.fichier)) { avertir(`version ignorée (fichier absent) pour ${slug}`); continue; }
                page.revisions.push({
                    contenu: texte(r.fichier), date: dateValide(r.date, modifie),
                    titre: typeof r.titre === 'string' && r.titre ? r.titre.slice(0, 300) : page.titre,
                    auteur: typeof r.auteur === 'string' && r.auteur ? r.auteur.slice(0, 200) : null,
                });
            }
            pages.set(slug, page);
        };
        for (const p of Array.isArray(manifeste.pages) ? manifeste.pages : []) {
            if (typeof p?.slug !== 'string') { avertir('page sans identifiant ignorée'); continue; }
            ajouterPage(p.slug, p, typeof p.fichier === 'string' ? p.fichier : `pages/${p.slug}.md`);
        }
        const citees = new Set([...pages.values()].map(p => `pages/${p.slug}.md`));
        for (const chemin of fichiers.keys()) {
            const m = /^pages\/([^/]+)\.md$/.exec(chemin);
            if (m && !citees.has(chemin) && !pages.has(m[1])) ajouterPage(m[1], {}, chemin);
        }

        const arbre = arbreTolerant(manifeste.arbre, avertir);

        // Redirections : seulement vers une page importée, et jamais à la place d'une vraie page
        const redirections = [];
        for (const [ancien, actuel] of Object.entries(manifeste.redirections && typeof manifeste.redirections === 'object' ? manifeste.redirections : {})) {
            if (REGEX_SLUG.test(ancien) && pages.has(actuel) && !pages.has(ancien)) redirections.push({ ancien, actuel });
        }

        // Images : tout fichier uploads/… ou media/… de l'archive
        const images = [];
        for (const [chemin, octets] of fichiers) {
            if (chemin === 'wiki.json' || /^(pages|revisions)\//.test(chemin)) continue;
            if (!/^(uploads|media)\//.test(chemin)) { avertir(`fichier ignoré : ${chemin}`); continue; }
            if (!REGEX_CLE_FICHIER.test(chemin)) { avertir(`fichier ignoré (nom avec caractères non gérés) : ${chemin}`); continue; }
            const ext = path.extname(chemin).toLowerCase();
            if (!TYPES_MIME[ext]) { avertir(`fichier ignoré (pas une image) : ${chemin}`); continue; }
            if (octets.length > TAILLE_MAX_IMAGE) { avertir(`image ignorée (plus de ${TAILLE_MAX_IMAGE / 1024 / 1024} Mo) : ${chemin}`); continue; }
            // Le vrai format, lu dans le fichier, l'emporte sur l'extension (images mal nommées)
            const detecte = detecterTypeImage(Buffer.from(octets.buffer, octets.byteOffset, octets.length));
            images.push({ cle: chemin, octets, mime: detecte?.mime || TYPES_MIME[ext] });
        }

        const wiki = manifeste.wiki && typeof manifeste.wiki === 'object' ? manifeste.wiki : {};
        const parametres = nettoyerParametres({ ...(wiki.parametres || {}), nom: wiki.parametres?.nom || wiki.nom });
        return { parametres, pages, arbre, redirections, images, avertissements };
    }

    async function contenuExistant(wikiId) {
        const r = await db.selectFrom('pages').select(db.fn.countAll().as('n')).where('wiki_id', '=', wikiId).executeTakeFirst();
        return Number(r.n);
    }

    /**
     * Remplace tout le contenu d'un wiki par celui d'une archive.
     * Sont conservés : le wiki lui-même, sa visibilité et ses membres.
     * @param {Map<string, Uint8Array>} fichiers
     */
    async function importerWiki(wikiId, fichiers, { remplacer = false, auteurId = null } = {}) {
        const wiki = await wikis.trouverWikiParId(wikiId);
        if (!wiki) throw new ErreurWiki(404, 'Wiki introuvable.');
        const donnees = preparerImport(fichiers);
        const existant = await contenuExistant(wikiId);
        if (existant > 0 && !remplacer) {
            throw new ErreurWiki(409, `Ce wiki contient déjà ${existant} pages : l'import remplacerait tout son contenu.`);
        }
        const anciennesCles = (await db.selectFrom('media').select('cle').where('wiki_id', '=', wikiId).execute()).map(m => m.cle);

        // 1. Fichiers d'abord : si la suite échoue, l'ancien wiki reste intact en base
        for (const img of donnees.images) await storage.ecrire(wikiId, img.cle, img.octets);

        // 2. Base de données, en une seule transaction
        const date = maintenant();
        await db.transaction().execute(async trx => {
            for (const table of ['redirections', 'revisions']) await trx.deleteFrom(table).where('wiki_id', '=', wikiId).execute();
            await trx.updateTable('pages').set({ parent_id: null }).where('wiki_id', '=', wikiId).execute();
            await trx.deleteFrom('pages').where('wiki_id', '=', wikiId).execute();
            await trx.deleteFrom('media').where('wiki_id', '=', wikiId).execute();
            await trx.updateTable('wikis')
                .set({ nom: donnees.parametres.nom, parametres: JSON.stringify(donnees.parametres), updated_at: date })
                .where('id', '=', wikiId).execute();

            const idParSlug = new Map();
            for (const p of donnees.pages.values()) {
                const res = await trx.insertInto('pages').values({
                    wiki_id: wikiId, slug: p.slug, titre: p.titre, contenu: p.contenu, parent_id: null, position: null, dans_arbre: 0,
                    created_at: p.cree_le, updated_at: p.modifie_le, updated_by: auteurId,
                }).executeTakeFirstOrThrow();
                const pageId = Number(res.insertId);
                idParSlug.set(p.slug, pageId);
                const versions = [...p.revisions];
                // La dernière version doit toujours correspondre au contenu actuel
                if (!versions.length || versions.at(-1).contenu !== p.contenu) {
                    versions.push({ contenu: p.contenu, date: p.modifie_le, titre: p.titre, auteur: null });
                }
                for (const v of versions) {
                    await trx.insertInto('revisions').values({
                        page_id: pageId, wiki_id: wikiId, titre: v.titre, contenu: v.contenu,
                        author_id: null, auteur_nom: v.auteur, created_at: v.date,
                    }).execute();
                }
            }

            const placer = async (elements, parentId) => {
                for (let position = 0; position < elements.length; position++) {
                    const el = elements[position];
                    let id = idParSlug.get(el.id);
                    if (id === undefined) {
                        // Page présente dans l'arbre sans contenu : créée vide, comme dans l'éditeur
                        const res = await trx.insertInto('pages').values({
                            wiki_id: wikiId, slug: el.id, titre: el.titre, contenu: '', parent_id: parentId, position,
                            dans_arbre: 1, created_at: date, updated_at: date, updated_by: auteurId,
                        }).executeTakeFirstOrThrow();
                        id = Number(res.insertId);
                        idParSlug.set(el.id, id);
                    } else {
                        await trx.updateTable('pages').set({ titre: el.titre, parent_id: parentId, position, dans_arbre: 1 }).where('id', '=', id).execute();
                    }
                    await placer(el.enfants, id);
                }
            };
            await placer(donnees.arbre, null);

            for (const r of donnees.redirections) {
                await trx.insertInto('redirections').values({ wiki_id: wikiId, ancien_slug: r.ancien, page_id: idParSlug.get(r.actuel), created_at: date }).execute();
            }
            for (const img of donnees.images) {
                await trx.insertInto('media').values({ wiki_id: wikiId, cle: img.cle, mime: img.mime, taille: img.octets.length, uploader_id: auteurId, created_at: date }).execute();
            }
        });

        // 3. Ménage : images de l'ancien wiki absentes du nouveau
        const nouvelles = new Set(donnees.images.map(i => i.cle));
        for (const cle of anciennesCles) if (!nouvelles.has(cle)) await storage.supprimer(wikiId, cle).catch(() => {});

        const compter = els => els.reduce((n, e) => n + 1 + compter(e.enfants), 0);
        return {
            pages: donnees.pages.size,
            dansArbre: compter(donnees.arbre),
            versions: [...donnees.pages.values()].reduce((n, p) => n + Math.max(1, p.revisions.length), 0),
            images: donnees.images.length,
            avertissements: donnees.avertissements,
        };
    }

    return { exporterWiki, importerWiki };
}
