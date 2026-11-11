// Tests de l'export / import d'un wiki (format ouvert). Lancer avec : npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { lireZip } from '@wiziki/adapters/archive';
import { construireApp } from '../src/app.js';
import { lireConfig } from '../src/config.js';

const MDP = 'mot-de-passe-de-test';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0f0a4e70000000049454e44ae426082', 'hex');

let app, db, dossier, cookie;

before(async () => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-archive-'));
    db = ouvrirSqlite(':memory:');
    await migrer(db);
    const config = { ...lireConfig({ ADMIN_PASSWORD: MDP, WIZIKI_DATA_DIR: dossier }), logs: 'silent' };
    app = await construireApp({ config, db, storage: creerStockageDisque(path.join(dossier, 'files')) });
    cookie = await connecter('admin', MDP);
});

after(async () => {
    await app.close();
    await db.destroy();
    fs.rmSync(dossier, { recursive: true, force: true });
});

async function connecter(identifiant, motDePasse) {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { identifiant, motDePasse } });
    assert.equal(r.statusCode, 200, `connexion ${identifiant}`);
    return r.headers['set-cookie'].split(';')[0];
}
const req = (methode, url, options = {}) => app.inject({
    method: methode, url, ...options,
    headers: { ...(options.cookie === false ? {} : { cookie: options.cookie || cookie }), ...options.headers },
});
const texte = { 'content-type': 'text/plain' };
const zip = { 'content-type': 'application/zip' };
const importer = (octets, remplacer = true, options = {}) =>
    req('POST', `/api/import${remplacer ? '?remplacer=1' : ''}`, { payload: Buffer.from(octets), headers: zip, ...options });
const archive = (fichiers) => zipSync(Object.fromEntries(Object.entries(fichiers).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v])));
const manifeste = (extra = {}) => JSON.stringify({ format: 'wiziki-export', version: 1, wiki: { nom: 'Test' }, ...extra });

test('export puis import : le wiki revient à l\'identique', async () => {
    // Un wiki avec arbre, page non classée, historique, renommage et image
    await req('POST', '/api/page/accueil', { payload: '# Accueil\n\nv1', headers: texte });
    await req('POST', '/api/page/accueil', { payload: '# Accueil\n\nv2 ![](/uploads/x.png)', headers: texte });
    await req('POST', '/api/page/enfant', { payload: 'Enfant', headers: texte });
    await req('POST', '/api/page/orpheline', { payload: 'Hors arbre', headers: texte });
    await req('POST', '/api/renommer/enfant', { payload: { nouvelId: 'sous_page' } });
    const image = (await req('POST', '/api/upload', { payload: PNG, headers: { 'content-type': 'image/png' } })).json().url;
    await req('POST', '/api/structure', { payload: {
        parametres: { nom: 'Mon wiki exporté', couleurLiens: '#ff0000' },
        arbre: [{ id: 'accueil', titre: 'Accueil', enfants: [{ id: 'sous_page', titre: 'Sous-page', enfants: [] }] }],
    } });
    await req('PUT', '/api/wiki/visibilite', { payload: { visibilite: 'prive' } });

    const avant = (await req('GET', '/api/structure')).json();
    const r = await req('GET', '/api/export');
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/zip');
    assert.match(r.headers['content-disposition'], /attachment; filename="default-\d{4}-\d\d-\d\d\.wiziki\.zip"/);

    const fichiers = lireZip(r.rawPayload);
    const m = JSON.parse(new TextDecoder().decode(fichiers.get('wiki.json')));
    assert.equal(m.format, 'wiziki-export');
    assert.equal(m.version, 1);
    assert.equal(new TextDecoder().decode(fichiers.get('pages/accueil.md')), '# Accueil\n\nv2 ![](/uploads/x.png)');
    assert.equal(m.pages.find(p => p.slug === 'accueil').revisions.length, 2);
    assert.equal(m.pages.find(p => p.slug === 'accueil').revisions[0].auteur, 'Administrateur');
    assert.deepEqual(m.redirections, { enfant: 'sous_page' });
    assert.ok(fichiers.has(image.slice(1)), 'image incluse');
    assert.ok(![...fichiers.keys()].some(k => /users|members|sessions|password/i.test(k)), 'aucun compte exporté');
    assert.doesNotMatch(new TextDecoder().decode(fichiers.get('wiki.json')), /scrypt|password_hash/);

    // Sans historique : seulement la dernière version
    const leger = lireZip((await req('GET', '/api/export?historique=0')).rawPayload);
    assert.ok(![...leger.keys()].some(k => k.startsWith('revisions/')));

    // On abîme le wiki, puis on réimporte l'export
    await req('POST', '/api/page/accueil', { payload: 'cassé', headers: texte });
    await req('POST', '/api/page/intruse', { payload: 'à disparaître', headers: texte });
    const imp = await importer(r.rawPayload);
    assert.equal(imp.statusCode, 200, imp.body);
    assert.equal(imp.json().pages, 3);
    assert.equal(imp.json().images, 1);

    const apres = (await req('GET', '/api/structure')).json();
    assert.deepEqual(apres, avant);
    assert.equal((await req('GET', '/api/page/accueil')).body, '# Accueil\n\nv2 ![](/uploads/x.png)');
    assert.equal((await req('GET', '/api/page/intruse')).statusCode, 404);
    assert.equal((await req('GET', '/enfant')).statusCode, 301, 'redirection conservée');
    assert.equal((await req('GET', image)).rawPayload.equals(PNG), true, 'image identique');
    const versions = (await req('GET', '/api/page/accueil/revisions')).json();
    assert.equal(versions.length, 2, 'historique réimporté');
    assert.equal(versions[1].auteur, 'Administrateur', "nom de l'auteur conservé");
    // Le wiki garde sa visibilité et ses membres
    assert.equal((await req('GET', '/api/structure', { cookie: false })).statusCode, 401, 'reste privé');
    assert.deepEqual((await req('GET', '/api/membres')).json().map(m => m.identifiant), ['admin']);
    await req('PUT', '/api/wiki/visibilite', { payload: { visibilite: 'public' } });
});

test('import : refusé sans confirmation si le wiki a déjà du contenu', async () => {
    const r = await importer(archive({ 'wiki.json': manifeste() }), false);
    assert.equal(r.statusCode, 409);
    assert.match(r.json().message, /remplacerait/);
});

test('export / import réservés au propriétaire', async () => {
    await req('POST', '/api/membres', { payload: { identifiant: 'edith', motDePasse: 'mot-de-passe-edith', role: 'editor' } });
    const edith = await connecter('edith', 'mot-de-passe-edith');
    assert.equal((await req('GET', '/api/export', { cookie: edith })).statusCode, 403);
    assert.equal((await importer(archive({ 'wiki.json': manifeste() }), true, { cookie: edith })).statusCode, 403);
    assert.equal((await req('GET', '/api/export', { cookie: false })).statusCode, 401);
    // CSRF : origine étrangère refusée
    const csrf = await importer(archive({ 'wiki.json': manifeste() }), true, { headers: { ...zip, origin: 'https://evil.example' } });
    assert.equal(csrf.statusCode, 403);
});

test('import : archives invalides refusées sans toucher au wiki', async () => {
    const avant = (await req('GET', '/api/structure')).json();
    const cas = [
        [Buffer.from('pas un zip'), /archive ZIP lisible/],
        [archive({ 'autre.txt': 'x' }), /wiki\.json est absent/],
        [archive({ 'wiki.json': '{ cassé' }), /illisible/],
        [archive({ 'wiki.json': JSON.stringify({ format: 'autre' }) }), /pas un export Wiziki/],
        [archive({ 'wiki.json': manifeste({ version: 99 }) }), /version plus récente/],
    ];
    for (const [octets, message] of cas) {
        const r = await importer(octets);
        assert.equal(r.statusCode, 400, String(message));
        assert.match(r.json().message, message);
    }
    assert.deepEqual((await req('GET', '/api/structure')).json(), avant);
});

test('import : chemins dangereux et fichiers non gérés ignorés', async () => {
    const r = await importer(archive({
        'wiki.json': manifeste({ pages: [{ slug: '../evil', fichier: 'pages/x.md' }, { slug: 'ok', titre: 'OK' }], arbre: [{ id: 'ok', titre: 'OK', enfants: [] }, { id: 'ok' }, { id: '../x' }] }),
        'pages/ok.md': 'contenu ok',
        'pages/ajoutee_main.md': 'page non citée dans wiki.json',
        'uploads/../../../etc/passwd.png': PNG,
        'uploads/script.js': 'alert(1)',
        'media/photo.png': PNG,
        '../hors.png': PNG,
        'divers/notes.txt': 'x',
    }));
    assert.equal(r.statusCode, 200, r.body);
    const res = r.json();
    assert.equal(res.pages, 2);
    assert.equal(res.images, 1);
    assert.ok(res.avertissements.length >= 5, res.avertissements.join('\n'));
    assert.equal((await req('GET', '/api/page/ok')).body, 'contenu ok');
    assert.equal((await req('GET', '/api/page/ajoutee_main')).body, 'page non citée dans wiki.json');
    assert.equal((await req('GET', '/media/photo.png')).statusCode, 200);
    assert.equal((await req('GET', '/uploads/script.js')).statusCode, 404);
    assert.ok(!fs.existsSync(path.join(dossier, 'etc')) && !fs.existsSync(path.join(dossier, 'hors.png')));
    // L'ancienne image (export précédent) a été supprimée du disque
    const restants = fs.readdirSync(path.join(dossier, 'files', '1', 'uploads'));
    assert.deepEqual(restants, []);
});
