// Tests de l'API (sans réseau : app.inject). Lancer avec : npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { construireApp } from '../src/app.js';
import { lireConfig } from '../src/config.js';

const MDP = 'mot-de-passe-de-test';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a0f0a4e70000000049454e44ae426082', 'hex');

let app, db, dossier, cookie;

before(async () => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-test-'));
    db = ouvrirSqlite(':memory:');
    await migrer(db);
    const config = { ...lireConfig({ ADMIN_PASSWORD: MDP, WIZIKI_DATA_DIR: dossier }), logs: 'silent' };
    app = await construireApp({ config, db, storage: creerStockageDisque(path.join(dossier, 'files')) });
});

after(async () => {
    await app.close();
    await db.destroy();
    fs.rmSync(dossier, { recursive: true, force: true });
});

const req = (methode, url, options = {}) => app.inject({
    method: methode, url, ...options,
    headers: { ...(options.cookie !== false && cookie ? { cookie } : {}), ...options.headers },
});
const sansSession = { cookie: false };

test('interface et en-têtes de sécurité', async () => {
    const r = await req('GET', '/');
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-security-policy'], /object-src 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.doesNotMatch(r.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
    const script = r.body.match(/src="(\/assets\/[^"]+\.js)"/);
    assert.ok(script, 'script du build référencé dans la page');
    const js = await req('GET', script[1]);
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['cache-control'], /immutable/);
});

test('connexion administrateur', async () => {
    assert.equal((await req('POST', '/api/login', { payload: { identifiant: 'admin', motDePasse: 'faux' } })).statusCode, 401);
    assert.equal((await req('POST', '/api/login', { payload: { identifiant: 'inconnu', motDePasse: MDP } })).statusCode, 401);
    const r = await req('POST', '/api/login', { payload: { identifiant: 'admin', motDePasse: MDP } });
    assert.equal(r.statusCode, 200);
    const setCookie = r.headers['set-cookie'];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(';')[0];
    const session = (await req('GET', '/api/session')).json();
    assert.equal(session.connecte, true);
    assert.equal(session.role, 'owner');
    assert.equal(session.utilisateur.identifiant, 'admin');
    assert.equal(session.installationRequise, false);
});

test('les écritures exigent une session', async () => {
    for (const [m, u, payload] of [
        ['POST', '/api/page/x', 'texte'], ['DELETE', '/api/page/x'], ['POST', '/api/structure', {}],
        ['POST', '/api/renommer/x', { nouvelId: 'y' }], ['POST', '/api/upload', PNG], ['GET', '/api/images'],
    ]) {
        const r = await req(m, u, { ...sansSession, payload });
        assert.equal(r.statusCode, 401, `${m} ${u}`);
    }
});

test('protection CSRF : origine étrangère refusée', async () => {
    const r = await req('POST', '/api/page/x', { payload: 'x', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' } });
    assert.equal(r.statusCode, 403);
});

test('page : création, lecture, révisions, renommage, suppression', async () => {
    const ecrire = (slug, texte) => req('POST', `/api/page/${slug}`, { payload: texte, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    assert.equal((await ecrire('ma_page', '# Bonjour é ✓')).statusCode, 200);
    assert.equal((await req('GET', '/api/page/ma_page')).body, '# Bonjour é ✓');
    await ecrire('ma_page', 'v2');
    assert.equal((await req('GET', '/api/page/ma_page/revisions')).json().length, 2);

    // Page hors de l'arbre = non classée
    assert.deepEqual((await req('GET', '/api/structure')).json().orphelins, ['ma_page']);
    assert.equal((await req('GET', '/api/structure', sansSession)).json().orphelins, undefined);

    assert.equal((await req('POST', '/api/renommer/ma_page', { payload: { nouvelId: '../x' } })).statusCode, 400);
    await ecrire('autre', 'a');
    assert.equal((await req('POST', '/api/renommer/ma_page', { payload: { nouvelId: 'autre' } })).statusCode, 409);
    assert.equal((await req('POST', '/api/renommer/ma_page', { payload: { nouvelId: 'ma_page2' } })).statusCode, 200);
    assert.equal((await req('GET', '/api/page/ma_page2')).body, 'v2');

    assert.equal((await req('DELETE', '/api/page/ma_page2')).statusCode, 200);
    assert.equal((await req('GET', '/api/page/ma_page2')).statusCode, 404);
    // Le même nom peut être réutilisé après suppression
    assert.equal((await ecrire('ma_page2', 'nouvelle')).statusCode, 200);
});

test('page : identifiant et taille contrôlés', async () => {
    assert.equal((await req('GET', '/api/page/..%2fx')).statusCode, 400);
    const enorme = 'a'.repeat(2 * 1024 * 1024 + 10);
    assert.equal((await req('POST', '/api/page/grosse', { payload: enorme, headers: { 'content-type': 'text/plain' } })).statusCode, 413);
});

test('arbre : enregistrement, ordre, pages créées et non classées', async () => {
    const arbre = [
        { id: 'autre', titre: 'Autre', enfants: [{ id: 'nouvelle_dans_arbre', titre: 'Nouvelle', enfants: [] }] },
        { id: 'ma_page2', titre: 'Ma page', enfants: [] },
    ];
    const parametres = { nom: 'Test', banniereActive: false, banniereUrl: '', couleurLiens: '#123456', pageAccueil: 'autre' };
    assert.equal((await req('POST', '/api/structure', { payload: { parametres, arbre } })).statusCode, 200);
    const s = (await req('GET', '/api/structure')).json();
    assert.deepEqual(s.arbre, arbre);
    assert.deepEqual(s.parametres, parametres);
    assert.deepEqual(s.orphelins, []);
    // Page présente seulement dans l'arbre : existe, vide
    assert.equal((await req('GET', '/api/page/nouvelle_dans_arbre')).body, '');

    // Retirer une page de l'arbre la rend non classée
    await req('POST', '/api/structure', { payload: { parametres, arbre: [arbre[1]] } });
    assert.deepEqual((await req('GET', '/api/structure')).json().orphelins.sort(), ['autre', 'nouvelle_dans_arbre']);
});

test('arbre : données invalides refusées', async () => {
    const r1 = await req('POST', '/api/structure', { payload: { arbre: [{ id: '../x' }] } });
    assert.equal(r1.statusCode, 400);
    const r2 = await req('POST', '/api/structure', { payload: { arbre: [{ id: 'a' }, { id: 'a' }] } });
    assert.equal(r2.statusCode, 400);
    const r3 = await req('POST', '/api/structure', { payload: '{oops', headers: { 'content-type': 'application/json' } });
    assert.equal(r3.statusCode, 400);
    // Une couleur ou un paramètre piégé est ignoré
    await req('POST', '/api/structure', { payload: { parametres: { couleurLiens: 'red;}</style><script>' }, arbre: [] } });
    assert.equal((await req('GET', '/api/structure')).json().parametres.couleurLiens, undefined);
});

test('images : vrai type vérifié, taille limitée, service des fichiers', async () => {
    const r = await req('POST', '/api/upload', { payload: PNG, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.statusCode, 200);
    const { url } = r.json();
    assert.match(url, /^\/uploads\/img_\d+_[0-9a-f]{8}\.png$/);
    const img = await req('GET', url, sansSession);
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.deepEqual((await req('GET', '/api/images')).json(), [url]);

    const html = Buffer.from('<script>alert(1)</script>............');
    assert.equal((await req('POST', '/api/upload', { payload: html, headers: { 'content-type': 'application/octet-stream' } })).statusCode, 415);
    const gros = Buffer.alloc(10 * 1024 * 1024 + 1);
    assert.equal((await req('POST', '/api/upload', { payload: gros, headers: { 'content-type': 'application/octet-stream' } })).statusCode, 413);
});

test('fichiers : pas de sortie du dossier', async () => {
    for (const u of ['/uploads/..%2f..%2fwiziki.db', '/media/../package.json', '/assets/%2e%2e/index.html', '/assets/..%2f..%2fpackage.json', '/uploads/inexistant.png']) {
        assert.equal((await req('GET', u)).statusCode, 404, u);
    }
});

test('limitation des tentatives de connexion', async () => {
    const statuts = [];
    for (let i = 0; i < 6; i++) {
        statuts.push((await req('POST', '/api/login', { ...sansSession, payload: { identifiant: 'admin', motDePasse: 'x' }, remoteAddress: '10.9.9.9' })).statusCode);
    }
    assert.deepEqual(statuts, [401, 401, 401, 401, 401, 429]);
});

test('adresse de page : interface avec titre, 404 si inconnue', async () => {
    await req('POST', '/api/page/page_adresse', { payload: 'x', headers: { 'content-type': 'text/plain' } });
    await req('POST', '/api/structure', { payload: { parametres: { nom: 'Mon <Wiki>' }, arbre: [{ id: 'page_adresse', titre: 'Une "page"', enfants: [] }] } });
    const r = await req('GET', '/page_adresse', sansSession);
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /<title>Une &quot;page&quot; — Mon &lt;Wiki&gt;<\/title>/);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.equal((await req('GET', '/page_inexistante', sansSession)).statusCode, 404);
    assert.equal((await req('GET', '/..%2fetc', sansSession)).statusCode, 404);
});

test('renommage : l\'ancien nom redirige vers la page', async () => {
    const ecrire = (slug, t) => req('POST', `/api/page/${slug}`, { payload: t, headers: { 'content-type': 'text/plain' } });
    await ecrire('avant_renommage', 'contenu');
    await req('POST', '/api/renommer/avant_renommage', { payload: { nouvelId: 'apres_renommage' } });
    const r = await req('GET', '/avant_renommage?mode=admin', sansSession);
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, '/apres_renommage?mode=admin');
    assert.equal((await req('GET', '/api/structure', sansSession)).json().redirections.avant_renommage, 'apres_renommage');
    // Une nouvelle page qui reprend l'ancien nom remplace la redirection
    await ecrire('avant_renommage', 'nouvelle page');
    assert.equal((await req('GET', '/avant_renommage', sansSession)).statusCode, 200);
    assert.equal((await req('GET', '/api/structure', sansSession)).json().redirections.avant_renommage, undefined);
});


// ---------------------------------------------------------------- Comptes et rôles

const connecter = async (identifiant, motDePasse) => {
    const r = await req('POST', '/api/login', { ...sansSession, payload: { identifiant, motDePasse }, remoteAddress: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
    assert.equal(r.statusCode, 200, `connexion ${identifiant}`);
    return r.headers['set-cookie'].split(';')[0];
};
const avec = (c, methode, url, options = {}) => app.inject({ method: methode, url, ...options, headers: { cookie: c, ...options.headers } });

test('rôles : propriétaire, éditeur, lecteur, non-membre', async () => {
    // Le propriétaire ajoute un éditeur et un lecteur (nouveaux comptes)
    assert.equal((await req('POST', '/api/membres', { payload: { identifiant: 'edith', nom: 'Edith', motDePasse: 'mot-de-passe-edith', role: 'editor' } })).statusCode, 200);
    assert.equal((await req('POST', '/api/membres', { payload: { identifiant: 'leo', motDePasse: 'mot-de-passe-leo', role: 'reader' } })).statusCode, 200);
    assert.equal((await req('POST', '/api/membres', { payload: { identifiant: 'leo', motDePasse: 'x', role: 'reader' } })).statusCode, 200, 'compte existant : simple ajout');
    assert.equal((await req('POST', '/api/membres', { payload: { identifiant: 'Mauvais Nom!', motDePasse: 'mot-de-passe-xx' } })).statusCode, 400);
    assert.equal((await req('POST', '/api/membres', { payload: { identifiant: 'court', motDePasse: 'court' } })).statusCode, 400, 'mot de passe trop court');
    const membres = (await req('GET', '/api/membres')).json();
    assert.deepEqual(membres.map(m => [m.identifiant, m.role]), [['admin', 'owner'], ['edith', 'editor'], ['leo', 'reader']]);
    assert.ok(!('password_hash' in membres[0]), "l'empreinte du mot de passe n'est jamais renvoyée");

    const edith = await connecter('edith', 'mot-de-passe-edith');
    const leo = await connecter('leo', 'mot-de-passe-leo');
    const ecrire = (c, texte) => avec(c, 'POST', '/api/page/page_roles', { payload: texte, headers: { 'content-type': 'text/plain' } });

    assert.equal((await ecrire(edith, 'par edith')).statusCode, 200, 'éditeur : écriture autorisée');
    assert.equal((await ecrire(leo, 'par leo')).statusCode, 403, 'lecteur : écriture refusée');
    assert.equal((await avec(edith, 'GET', '/api/membres')).statusCode, 403, 'éditeur : gestion des membres refusée');
    assert.ok(Array.isArray((await avec(edith, 'GET', '/api/structure')).json().orphelins), 'éditeur : voit les pages non classées');
    assert.equal((await avec(leo, 'GET', '/api/structure')).json().orphelins, undefined);

    // L'auteur est enregistré dans la révision
    const revs = (await req('GET', '/api/page/page_roles/revisions')).json();
    assert.equal(typeof revs[0].author_id, 'number');

    // Changement de rôle, retrait
    const leoId = membres.find(m => m.identifiant === 'leo').id;
    await req('PATCH', `/api/membres/${leoId}`, { payload: { role: 'editor' } });
    assert.equal((await ecrire(leo, 'par leo')).statusCode, 200, 'promu éditeur');
    await req('DELETE', `/api/membres/${leoId}`);
    assert.equal((await ecrire(leo, 'encore')).statusCode, 403, 'retiré du wiki');
});

test('le dernier propriétaire ne peut pas être retiré ni rétrogradé', async () => {
    const adminId = (await req('GET', '/api/membres')).json().find(m => m.identifiant === 'admin').id;
    assert.equal((await req('PATCH', `/api/membres/${adminId}`, { payload: { role: 'editor' } })).statusCode, 409);
    assert.equal((await req('DELETE', `/api/membres/${adminId}`)).statusCode, 409);
});

test('wiki privé : lecture réservée aux membres', async () => {
    assert.equal((await req('PUT', '/api/wiki/visibilite', { payload: { visibilite: 'prive' } })).statusCode, 200);
    assert.equal((await req('GET', '/api/structure', sansSession)).statusCode, 401);
    assert.equal((await req('GET', '/api/page/page_roles', sansSession)).statusCode, 401);
    assert.equal((await req('GET', '/api/structure')).statusCode, 200);
    // L'interface reste accessible (pour pouvoir se connecter)
    assert.equal((await req('GET', '/', sansSession)).statusCode, 200);
    await req('PUT', '/api/wiki/visibilite', { payload: { visibilite: 'public' } });
    assert.equal((await req('GET', '/api/structure', sansSession)).statusCode, 200);
});

test('sessions : déconnexion côté serveur, changement de mot de passe', async () => {
    const s1 = await connecter('edith', 'mot-de-passe-edith');
    const s2 = await connecter('edith', 'mot-de-passe-edith');
    // Changer de mot de passe ferme les autres sessions, pas la session courante
    assert.equal((await avec(s1, 'POST', '/api/compte/mot-de-passe', { payload: { actuel: 'faux', nouveau: 'nouveau-mdp-edith' } })).statusCode, 403);
    assert.equal((await avec(s1, 'POST', '/api/compte/mot-de-passe', { payload: { actuel: 'mot-de-passe-edith', nouveau: 'nouveau-mdp-edith' } })).statusCode, 200);
    assert.equal((await avec(s1, 'GET', '/api/session')).json().connecte, true);
    assert.equal((await avec(s2, 'GET', '/api/session')).json().connecte, false);
    // Déconnexion : le jeton ne vaut plus rien, même rejoué
    await avec(s1, 'POST', '/api/logout');
    assert.equal((await avec(s1, 'GET', '/api/session')).json().connecte, false);
    await connecter('edith', 'nouveau-mdp-edith');
});


// ---------------------------------------------------------------- Historique et corbeille

test('historique : liste, lecture, restauration d\'une version', async () => {
    const ecrire = t => req('POST', '/api/page/page_histo', { payload: t, headers: { 'content-type': 'text/plain' } });
    await ecrire('version 1'); await ecrire('version 2'); await ecrire('version 3');
    const revs = (await req('GET', '/api/page/page_histo/revisions')).json();
    assert.equal(revs.length, 3);
    assert.equal(revs[0].actuelle, true);
    assert.equal(revs[0].auteur, 'Administrateur');
    assert.equal(revs[2].taille, 'version 1'.length);
    const v1 = (await req('GET', `/api/revisions/${revs[2].id}`)).json();
    assert.equal(v1.contenu, 'version 1');
    assert.equal((await req('POST', '/api/page/page_histo/restaurer', { payload: { revisionId: revs[2].id } })).statusCode, 200);
    assert.equal((await req('GET', '/api/page/page_histo')).body, 'version 1');
    assert.equal((await req('GET', '/api/page/page_histo/revisions')).json().length, 4, 'la restauration est elle-même une version');
    // Une version d'une autre page ne peut pas être restaurée ici
    await req('POST', '/api/page/autre_histo', { payload: 'x', headers: { 'content-type': 'text/plain' } });
    const autre = (await req('GET', '/api/page/autre_histo/revisions')).json()[0];
    assert.equal((await req('POST', '/api/page/page_histo/restaurer', { payload: { revisionId: autre.id } })).statusCode, 400);
    assert.equal((await req('GET', `/api/revisions/${revs[0].id}`, sansSession)).statusCode, 401);
});

test('corbeille : une page supprimée peut être restaurée', async () => {
    await req('POST', '/api/page/page_corbeille', { payload: 'à garder', headers: { 'content-type': 'text/plain' } });
    await req('DELETE', '/api/page/page_corbeille');
    const corbeille = (await req('GET', '/api/corbeille')).json();
    const p = corbeille.find(x => x.slug === 'page_corbeille');
    assert.ok(p, 'page présente dans la corbeille');
    // Conflit si une page du même nom a été recréée entre-temps
    await req('POST', '/api/page/page_corbeille', { payload: 'nouvelle', headers: { 'content-type': 'text/plain' } });
    assert.equal((await req('POST', `/api/corbeille/${p.id}/restaurer`)).statusCode, 409);
    await req('DELETE', '/api/page/page_corbeille');
    assert.equal((await req('POST', `/api/corbeille/${p.id}/restaurer`)).statusCode, 200);
    assert.equal((await req('GET', '/api/page/page_corbeille')).body, 'à garder');
    assert.ok((await req('GET', '/api/structure')).json().orphelins.includes('page_corbeille'), 'revient parmi les non classées');
});
