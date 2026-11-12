// Quota d'espace des images et suppression complète d'un wiki. Lancer avec : npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { creerZip, lireZip } from '@wiziki/adapters/archive';
import { creerServiceWiki, creerServiceArchive } from '../src/index.js';

let db, dossier, storage, wikis;
const MO = 1024 * 1024;
const png = taille => { const b = Buffer.alloc(taille, 7); b[0] = 0x89; b.write('PNG', 1, 'latin1'); return b; };

before(async () => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-espace-'));
    db = ouvrirSqlite(':memory:');
    await migrer(db);
    storage = creerStockageDisque(path.join(dossier, 'files'));
    wikis = creerServiceWiki({ db, storage, quotaOctets: 1 * MO });
});

after(async () => {
    await db.destroy();
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('quota : une image qui ferait dépasser la limite est refusée', async () => {
    const w = await wikis.creerWiki({ slug: 'quota', nom: 'Quota' });
    await wikis.ajouterImage(w.id, png(600 * 1024));
    assert.equal(await wikis.espaceUtilise(w.id), 600 * 1024);
    await assert.rejects(wikis.ajouterImage(w.id, png(600 * 1024)), e => e.statut === 413 && /Espace plein/.test(e.message));
    await wikis.ajouterImage(w.id, png(300 * 1024)); // reste sous la limite
    assert.equal(await wikis.espaceUtilise(w.id), 900 * 1024);
});

test('quota : sans limite, tout passe', async () => {
    const libre = creerServiceWiki({ db, storage });
    const w = await libre.creerWiki({ slug: 'libre', nom: 'Libre' });
    await libre.ajouterImage(w.id, png(800 * 1024));
    await libre.ajouterImage(w.id, png(800 * 1024));
    assert.equal(await libre.espaceUtilise(w.id), 1600 * 1024);
});

test('quota : import d\'une archive trop lourde refusé', async () => {
    // Archive réelle : export du wiki « libre » (1,6 Mo d'images), importée dans un wiki limité à 1 Mo
    const libre = creerServiceWiki({ db, storage });
    const source = await libre.trouverWikiParSlug('libre');
    const fichiers = lireZip(creerZip(await creerServiceArchive({ db, storage, wikis: libre }).exporterWiki(source.id)));
    const w = await wikis.creerWiki({ slug: 'import', nom: 'Import' });
    await assert.rejects(creerServiceArchive({ db, storage, wikis }).importerWiki(w.id, fichiers, { remplacer: true }),
        e => e.statut === 413 && /limite/.test(e.message));
    assert.equal(await wikis.espaceUtilise(w.id), 0, 'rien n\'a été importé');
});

test('suppression d\'un wiki : pages, historique, images et fichiers disparaissent', async () => {
    const w = await wikis.creerWiki({ slug: 'a-supprimer', nom: 'À supprimer' });
    await wikis.enregistrerPage(w.id, 'accueil', '# Bonjour');
    await wikis.enregistrerPage(w.id, 'accueil', '# Bonjour 2');
    await wikis.ajouterImage(w.id, png(10 * 1024));
    const garde = await wikis.trouverWikiParSlug('quota');
    assert.ok(fs.existsSync(path.join(dossier, 'files', String(w.id))));

    await wikis.supprimerWiki(w.id);
    assert.equal(await wikis.trouverWikiParSlug('a-supprimer'), undefined);
    for (const table of ['pages', 'revisions', 'media', 'members', 'redirections']) {
        const n = await db.selectFrom(table).select(eb => eb.fn.countAll().as('n')).where('wiki_id', '=', w.id).executeTakeFirst();
        assert.equal(Number(n.n), 0, table);
    }
    assert.equal(fs.existsSync(path.join(dossier, 'files', String(w.id))), false, 'dossier des images supprimé');
    assert.ok(await wikis.trouverWikiParSlug('quota'), 'les autres wikis ne sont pas touchés');
    assert.ok(await wikis.espaceUtilise(garde.id) > 0);
});
