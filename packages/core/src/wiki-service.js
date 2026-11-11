// Logique métier d'un wiki : pages, arbre, paramètres, révisions, images.
// Ne connaît ni HTTP ni l'infrastructure : reçoit une instance Kysely (`db`) et un stockage de fichiers (`storage`).

import crypto from 'node:crypto';
import path from 'node:path';
import {
    ErreurWiki, REGEX_NOUVEAU_SLUG, REGEX_CLE_FICHIER, PARAMETRES_DEFAUT, TAILLE_MAX_PAGE, TAILLE_MAX_IMAGE,
    verifierSlug, nettoyerParametres, nettoyerArbre, detecterTypeImage, TYPES_MIME,
} from './validation.js';

const maintenant = () => new Date().toISOString();

export function creerServiceWiki({ db, storage }) {

    // ---------------------------------------------------------------- Wikis

    async function trouverWikiParSlug(slug) {
        return db.selectFrom('wikis').selectAll().where('slug', '=', slug).executeTakeFirst();
    }

    async function creerWiki({ slug, nom = PARAMETRES_DEFAUT.nom, parametres = {} }) {
        const date = maintenant();
        const params = nettoyerParametres({ ...parametres, nom });
        const res = await db.insertInto('wikis')
            .values({ slug, nom: params.nom, parametres: JSON.stringify(params), visibilite: 'public', suspendu: 0, created_at: date, updated_at: date })
            .executeTakeFirstOrThrow();
        return trouverWikiParId(Number(res.insertId));
    }

    async function trouverWikiParId(id) {
        return db.selectFrom('wikis').selectAll().where('id', '=', id).executeTakeFirst();
    }

    async function listerWikis() {
        return db.selectFrom('wikis').selectAll().orderBy('id').execute();
    }

    // ---------------------------------------------------------------- Structure

    /**
     * Arbre et paramètres d'un wiki, au format attendu par le front :
     * { parametres, arbre: [{ id, titre, enfants }], orphelins?: [slug] }
     */
    async function lireStructure(wikiId, { avecOrphelins = false } = {}) {
        const wiki = await trouverWikiParId(wikiId);
        if (!wiki) throw new ErreurWiki(404, 'Wiki introuvable.');
        const pages = await db.selectFrom('pages')
            .select(['id', 'slug', 'titre', 'parent_id', 'position', 'dans_arbre'])
            .where('wiki_id', '=', wikiId).where('deleted_at', 'is', null)
            .orderBy('position').orderBy('id')
            .execute();

        const enfantsDe = new Map();
        for (const p of pages.filter(p => p.dans_arbre)) {
            const cle = p.parent_id ?? 0;
            if (!enfantsDe.has(cle)) enfantsDe.set(cle, []);
            enfantsDe.get(cle).push(p);
        }
        const construire = (parentId, profondeur) => (enfantsDe.get(parentId) || []).map(p => ({
            id: p.slug,
            titre: p.titre,
            enfants: profondeur < 50 ? construire(p.id, profondeur + 1) : [],
        }));

        const resultat = { parametres: JSON.parse(wiki.parametres || '{}'), arbre: construire(0, 0) };
        if (avecOrphelins) resultat.orphelins = pages.filter(p => !p.dans_arbre).map(p => p.slug);
        resultat.redirections = await lireRedirections(wikiId);
        return resultat;
    }

    /** Enregistre l'arbre complet et les paramètres (format du front). Transactionnel. */
    async function enregistrerStructure(wikiId, { parametres, arbre }, auteurId = null) {
        const params = nettoyerParametres(parametres);
        const arbrePropre = nettoyerArbre(arbre || []);
        const date = maintenant();

        await db.transaction().execute(async trx => {
            await trx.updateTable('wikis')
                .set({ nom: params.nom, parametres: JSON.stringify(params), updated_at: date })
                .where('id', '=', wikiId).execute();

            const existantes = await trx.selectFrom('pages').select(['id', 'slug'])
                .where('wiki_id', '=', wikiId).where('deleted_at', 'is', null).execute();
            const idParSlug = new Map(existantes.map(p => [p.slug, p.id]));
            const placees = new Set();

            const placer = async (elements, parentId) => {
                for (let position = 0; position < elements.length; position++) {
                    const el = elements[position];
                    let id = idParSlug.get(el.id);
                    if (id === undefined) {
                        // Page ajoutée dans l'arbre mais jamais enregistrée : on la crée vide
                        const res = await trx.insertInto('pages').values({
                            wiki_id: wikiId, slug: el.id, titre: el.titre, contenu: '', parent_id: parentId, position,
                            dans_arbre: 1, created_at: date, updated_at: date, updated_by: auteurId,
                        }).executeTakeFirstOrThrow();
                        id = Number(res.insertId);
                        idParSlug.set(el.id, id);
                    } else {
                        await trx.updateTable('pages')
                            .set({ titre: el.titre, parent_id: parentId, position, dans_arbre: 1 })
                            .where('id', '=', id).execute();
                    }
                    placees.add(id);
                    await placer(el.enfants, id);
                }
            };
            await placer(arbrePropre, null);

            // Les pages absentes de l'arbre deviennent « non classées »
            const aRetirer = existantes.map(p => p.id).filter(id => !placees.has(id));
            for (let i = 0; i < aRetirer.length; i += 500) {
                await trx.updateTable('pages').set({ dans_arbre: 0, parent_id: null, position: null })
                    .where('id', 'in', aRetirer.slice(i, i + 500)).execute();
            }
        });
    }

    // ---------------------------------------------------------------- Pages

    async function trouverPage(wikiId, slug) {
        verifierSlug(slug);
        return db.selectFrom('pages').selectAll()
            .where('wiki_id', '=', wikiId).where('slug', '=', slug).where('deleted_at', 'is', null)
            .executeTakeFirst();
    }

    async function lirePage(wikiId, slug) {
        const page = await trouverPage(wikiId, slug);
        if (!page) throw new ErreurWiki(404, 'Page introuvable.');
        return page;
    }

    /** Crée ou met à jour le contenu d'une page, en conservant une révision. */
    async function enregistrerPage(wikiId, slug, contenu, auteurId = null) {
        verifierSlug(slug);
        if (typeof contenu !== 'string') throw new ErreurWiki(400, 'Contenu invalide.');
        if (Buffer.byteLength(contenu, 'utf8') > TAILLE_MAX_PAGE) throw new ErreurWiki(413, 'Page trop volumineuse.');
        const date = maintenant();

        await db.transaction().execute(async trx => {
            const page = await trx.selectFrom('pages').select(['id', 'titre', 'contenu'])
                .where('wiki_id', '=', wikiId).where('slug', '=', slug).where('deleted_at', 'is', null)
                .executeTakeFirst();
            let pageId;
            let titre;
            if (page) {
                if (page.contenu === contenu) return; // rien à faire
                pageId = page.id;
                titre = page.titre;
                await trx.updateTable('pages').set({ contenu, updated_at: date, updated_by: auteurId }).where('id', '=', pageId).execute();
            } else {
                // Une vraie page prend le pas sur une redirection du même nom
                await trx.deleteFrom('redirections').where('wiki_id', '=', wikiId).where('ancien_slug', '=', slug).execute();
                // Comme l'ancienne version : une page enregistrée hors de l'arbre est « non classée »
                titre = slug.replace(/_/g, ' ');
                const res = await trx.insertInto('pages').values({
                    wiki_id: wikiId, slug, titre, contenu, parent_id: null, position: null, dans_arbre: 0,
                    created_at: date, updated_at: date, updated_by: auteurId,
                }).executeTakeFirstOrThrow();
                pageId = Number(res.insertId);
            }
            await trx.insertInto('revisions').values({
                page_id: pageId, wiki_id: wikiId, titre, contenu, author_id: auteurId, created_at: date,
            }).execute();
        });
    }

    /** Suppression « douce » : la page et ses révisions restent en base (corbeille, étape ultérieure). */
    async function supprimerPage(wikiId, slug, auteurId = null) {
        const page = await trouverPage(wikiId, slug);
        if (!page) return;
        const date = maintenant();
        await db.transaction().execute(async trx => {
            await trx.updateTable('pages')
                .set({ deleted_at: date, dans_arbre: 0, parent_id: null, position: null, updated_by: auteurId })
                .where('id', '=', page.id).execute();
            // Les sous-pages éventuelles deviennent non classées plutôt que de disparaître
            await trx.updateTable('pages').set({ dans_arbre: 0, parent_id: null, position: null })
                .where('parent_id', '=', page.id).execute();
        });
    }

    async function renommerPage(wikiId, slug, nouveauSlug) {
        verifierSlug(slug);
        if (typeof nouveauSlug !== 'string' || !REGEX_NOUVEAU_SLUG.test(nouveauSlug)) {
            throw new ErreurWiki(400, 'Identifiant de fichier invalide.');
        }
        if (nouveauSlug === slug) return;
        if (await trouverPage(wikiId, nouveauSlug)) throw new ErreurWiki(409, 'Un fichier porte déjà ce nom.');
        const page = await trouverPage(wikiId, slug);
        if (!page) return; // page présente seulement dans l'arbre côté front : rien à renommer en base
        const date = maintenant();
        await db.transaction().execute(async trx => {
            await trx.updateTable('pages').set({ slug: nouveauSlug, updated_at: date }).where('id', '=', page.id).execute();
            // L'ancien nom redirige vers la page ; le nouveau nom ne peut plus être une redirection
            await trx.deleteFrom('redirections').where('wiki_id', '=', wikiId).where('ancien_slug', 'in', [slug, nouveauSlug]).execute();
            await trx.insertInto('redirections').values({ wiki_id: wikiId, ancien_slug: slug, page_id: page.id, created_at: date }).execute();
        });
    }

    /** { ancienSlug: slugActuel } pour les pages renommées encore existantes */
    async function lireRedirections(wikiId) {
        const lignes = await db.selectFrom('redirections')
            .innerJoin('pages', 'pages.id', 'redirections.page_id')
            .select(['redirections.ancien_slug as ancien', 'pages.slug as actuel'])
            .where('redirections.wiki_id', '=', wikiId).where('pages.deleted_at', 'is', null)
            .execute();
        return Object.fromEntries(lignes.map(l => [l.ancien, l.actuel]));
    }

    /** Slug actuel d'une page renommée, ou null */
    async function suivreRedirection(wikiId, ancienSlug) {
        const ligne = await db.selectFrom('redirections')
            .innerJoin('pages', 'pages.id', 'redirections.page_id')
            .select('pages.slug')
            .where('redirections.wiki_id', '=', wikiId).where('redirections.ancien_slug', '=', ancienSlug)
            .where('pages.deleted_at', 'is', null)
            .executeTakeFirst();
        return ligne ? ligne.slug : null;
    }

    async function listerRevisions(wikiId, slug) {
        const page = await lirePage(wikiId, slug);
        const lignes = await db.selectFrom('revisions')
            .leftJoin('users', 'users.id', 'revisions.author_id')
            .select(['revisions.id', 'revisions.titre', 'revisions.author_id', 'revisions.created_at',
                eb => eb.fn.coalesce('users.nom', 'revisions.auteur_nom').as('auteur'),
                eb => eb.fn('length', ['revisions.contenu']).as('taille')])
            .where('revisions.page_id', '=', page.id).orderBy('revisions.id', 'desc').execute();
        return lignes.map((l, i) => ({ ...l, taille: Number(l.taille), actuelle: i === 0 }));
    }

    async function lireRevision(wikiId, revisionId) {
        const rev = await db.selectFrom('revisions')
            .leftJoin('users', 'users.id', 'revisions.author_id')
            .select(['revisions.id', 'revisions.page_id', 'revisions.titre', 'revisions.contenu', 'revisions.created_at',
                eb => eb.fn.coalesce('users.nom', 'revisions.auteur_nom').as('auteur')])
            .where('revisions.wiki_id', '=', wikiId).where('revisions.id', '=', revisionId)
            .executeTakeFirst();
        if (!rev) throw new ErreurWiki(404, 'Version introuvable.');
        return rev;
    }

    /** Remet le contenu d'une ancienne version (ce qui crée une nouvelle version : on peut toujours revenir en arrière) */
    async function restaurerRevision(wikiId, slug, revisionId, auteurId = null) {
        const page = await lirePage(wikiId, slug);
        const rev = await lireRevision(wikiId, revisionId);
        if (rev.page_id !== page.id) throw new ErreurWiki(400, "Cette version n'appartient pas à cette page.");
        await enregistrerPage(wikiId, slug, rev.contenu, auteurId);
    }

    // ---------------------------------------------------------------- Corbeille

    async function listerCorbeille(wikiId) {
        return db.selectFrom('pages').leftJoin('users', 'users.id', 'pages.updated_by')
            .select(['pages.id', 'pages.slug', 'pages.titre', 'pages.deleted_at', 'users.nom as supprime_par'])
            .where('pages.wiki_id', '=', wikiId).where('pages.deleted_at', 'is not', null)
            .orderBy('pages.deleted_at', 'desc').execute();
    }

    /** Sort une page de la corbeille ; elle revient parmi les pages « non classées » */
    async function restaurerPage(wikiId, pageId, auteurId = null) {
        const page = await db.selectFrom('pages').selectAll()
            .where('wiki_id', '=', wikiId).where('id', '=', pageId).where('deleted_at', 'is not', null).executeTakeFirst();
        if (!page) throw new ErreurWiki(404, 'Page introuvable dans la corbeille.');
        if (await trouverPage(wikiId, page.slug)) {
            throw new ErreurWiki(409, `Une page « ${page.slug} » existe déjà : renommez-la avant de restaurer celle-ci.`);
        }
        await db.updateTable('pages').set({ deleted_at: null, dans_arbre: 0, parent_id: null, position: null, updated_at: maintenant(), updated_by: auteurId })
            .where('id', '=', pageId).execute();
        return { slug: page.slug };
    }

    // ---------------------------------------------------------------- Fichiers (images)

    async function ajouterImage(wikiId, octets, auteurId = null) {
        if (octets.length > TAILLE_MAX_IMAGE) throw new ErreurWiki(413, 'Image trop volumineuse.');
        const type = detecterTypeImage(octets);
        if (!type) throw new ErreurWiki(415, 'Format non accepté : seules les images PNG, JPEG, GIF et WebP sont autorisées.');
        const cle = `uploads/img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${type.ext}`;
        await storage.ecrire(wikiId, cle, octets);
        await db.insertInto('media').values({
            wiki_id: wikiId, cle, mime: type.mime, taille: octets.length, uploader_id: auteurId, created_at: maintenant(),
        }).execute();
        return { url: `/${cle}` };
    }

    /** Enregistre un fichier existant (import). Écrase le fichier et met à jour sa fiche s'il existe déjà. */
    async function importerFichier(wikiId, cle, octets) {
        if (!REGEX_CLE_FICHIER.test(cle)) throw new ErreurWiki(400, `Nom de fichier invalide : ${cle}`);
        const mime = TYPES_MIME[path.extname(cle).toLowerCase()];
        if (!mime) throw new ErreurWiki(415, `Type de fichier non géré : ${cle}`);
        await storage.ecrire(wikiId, cle, octets);
        const existe = await db.selectFrom('media').select('id').where('wiki_id', '=', wikiId).where('cle', '=', cle).executeTakeFirst();
        if (existe) {
            await db.updateTable('media').set({ mime, taille: octets.length }).where('id', '=', existe.id).execute();
        } else {
            await db.insertInto('media').values({ wiki_id: wikiId, cle, mime, taille: octets.length, uploader_id: null, created_at: maintenant() }).execute();
        }
    }

    async function listerImagesEnvoyees(wikiId) {
        const lignes = await db.selectFrom('media').select('cle')
            .where('wiki_id', '=', wikiId).where('cle', 'like', 'uploads/%').orderBy('id').execute();
        return lignes.map(l => '/' + l.cle.split('/').map(encodeURIComponent).join('/'));
    }

    /** Fichier à servir pour une URL /uploads/… ou /media/… ; null si inconnu. */
    async function trouverFichier(wikiId, cle) {
        if (!REGEX_CLE_FICHIER.test(cle)) return null;
        const fiche = await db.selectFrom('media').select(['cle', 'mime', 'taille'])
            .where('wiki_id', '=', wikiId).where('cle', '=', cle).executeTakeFirst();
        if (!fiche) return null;
        return { ...fiche, flux: () => storage.lireFlux(wikiId, cle) };
    }

    return {
        trouverWikiParSlug, trouverWikiParId, creerWiki, listerWikis,
        lireStructure, enregistrerStructure,
        trouverPage, lirePage, enregistrerPage, supprimerPage, renommerPage, listerRevisions, lireRedirections, suivreRedirection,
        lireRevision, restaurerRevision, listerCorbeille, restaurerPage,
        ajouterImage, importerFichier, listerImagesEnvoyees, trouverFichier,
    };
}
