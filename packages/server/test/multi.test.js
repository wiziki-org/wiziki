// Plusieurs wikis sur un même serveur (option `multi`), avec connexion externe par code à usage unique. Lancer avec : npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { creerServiceWiki, creerServiceComptes } from '@wiziki/core';
import { construireApp } from '../src/app.js';
import { lireConfig } from '../src/config.js';

let app, db, dossier;
const codes = new Map(); // code -> { slug, identite }

before(async () => {
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-multi-'));
    db = ouvrirSqlite(':memory:');
    await migrer(db);
    const wikis = creerServiceWiki({ db, storage: null });
    await wikis.creerWiki({ slug: 'alpha', nom: 'Alpha' });
    await wikis.creerWiki({ slug: 'beta', nom: 'Beta' });
    const config = { ...lireConfig({ WIZIKI_DATA_DIR: dossier }), logs: 'silent' };
    app = await construireApp({
        config, db, storage: creerStockageDisque(path.join(dossier, 'files')),
        multi: {
            resoudreWiki: async req => {
                const m = /^([a-z0-9-]+)\.wikis\.test$/.exec(req.hostname);
                return m ? wikis.trouverWikiParSlug(m[1]) : null;
            },
            urlConnexion: (req, w) => `https://portail.test/aller?wiki=${w.slug}`,
            urlCompte: 'https://portail.test/compte',
            contact: 'contact@exemple.org',
            urlSignalement: (req, w) => `https://portail.test/signaler?wiki=${w.slug}`,
            echangerCode: async (code, req, w) => {
                const c = codes.get(code);
                codes.delete(code);
                return c && c.slug === w.slug ? c.identite : null;
            },
        },
    });
    // Marie possède alpha (créée comme le ferait la plateforme)
    const comptes = creerServiceComptes({ db });
    const marie = await comptes.utilisateurKratos({ id: 'id-marie', email: 'marie@exemple.org', emailVerifie: true });
    const alpha = await wikis.trouverWikiParSlug('alpha');
    await comptes.definirRole(alpha.id, marie.id, 'owner');
});

after(async () => {
    await app.close();
    await db.destroy();
    fs.rmSync(dossier, { recursive: true, force: true });
});

const sur = (slug, extra = {}) => ({ host: `${slug}.wikis.test`, ...extra });
async function connecter(slug, identite) {
    const code = 'code-' + Math.random().toString(36).slice(2);
    codes.set(code, { slug, identite });
    const r = await app.inject({ method: 'GET', url: `/auth/retour?code=${code}&suite=%2Fpage%3Fmode%3Dadmin`, headers: sur(slug) });
    const cookie = [].concat(r.headers['set-cookie'] || [])[0];
    return { r, cookie: cookie ? cookie.split(';')[0] : null };
}

test('le wiki dépend de l\'adresse ; adresse inconnue → 404', async () => {
    const a = await app.inject({ method: 'GET', url: '/', headers: sur('alpha') });
    assert.equal(a.statusCode, 200);
    assert.match(a.body, /<title>Alpha<\/title>/);
    assert.match((await app.inject({ method: 'GET', url: '/', headers: sur('beta') })).body, /<title>Beta<\/title>/);
    assert.equal((await app.inject({ method: 'GET', url: '/', headers: sur('gamma') })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'autre.exemple.org' } })).statusCode, 404);
    // Wiki suspendu : page explicite, rien n'est servi
    await db.updateTable('wikis').set({ suspendu: 1 }).where('slug', '=', 'beta').execute();
    const suspendu = await app.inject({ method: 'GET', url: '/api/page/accueil', headers: sur('beta') });
    assert.equal(suspendu.statusCode, 403);
    assert.match(suspendu.body, /suspendu.*contact@exemple\.org/);
    await db.updateTable('wikis').set({ suspendu: 0 }).where('slug', '=', 'beta').execute();
});

test('session : connexion externe annoncée, pas d\'installation', async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/session', headers: sur('alpha') })).json();
    assert.equal(s.auth, 'externe');
    assert.equal(s.connexionExterne, 'https://portail.test/aller?wiki=alpha');
    assert.equal(s.compteExterne, 'https://portail.test/compte');
    assert.equal(s.signalement, 'https://portail.test/signaler?wiki=alpha');
    assert.equal(s.installationRequise, false);
});

test('retour de connexion : code valide → session sur ce wiki seulement, droits par wiki', async () => {
    const { r, cookie } = await connecter('alpha', { id: 'id-marie', email: 'marie@exemple.org', emailVerifie: true });
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, '/page?mode=admin');
    assert.ok(cookie);
    const s = (await app.inject({ method: 'GET', url: '/api/session', headers: sur('alpha', { cookie }) })).json();
    assert.equal(s.role, 'owner');
    assert.equal((await app.inject({ method: 'POST', url: '/api/page/accueil', payload: 'Alpha !', headers: sur('alpha', { cookie, 'content-type': 'text/plain' }) })).statusCode, 200);

    // Sur beta, Marie n'a aucun rôle
    const { cookie: c2 } = await connecter('beta', { id: 'id-marie', email: 'marie@exemple.org', emailVerifie: true });
    const sb = (await app.inject({ method: 'GET', url: '/api/session', headers: sur('beta', { cookie: c2 }) })).json();
    assert.equal(sb.connecte, true);
    assert.equal(sb.role, null);
    assert.equal((await app.inject({ method: 'POST', url: '/api/page/accueil', payload: 'x', headers: sur('beta', { cookie: c2, 'content-type': 'text/plain' }) })).statusCode, 403);
    // Les pages sont propres à chaque wiki
    assert.equal((await app.inject({ method: 'GET', url: '/api/page/accueil', headers: sur('beta') })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/page/accueil', headers: sur('alpha') })).body, 'Alpha !');
});

test('retour de connexion : code invalide, réutilisé ou d\'un autre wiki → aucune session', async () => {
    const inconnu = await app.inject({ method: 'GET', url: '/auth/retour?code=faux', headers: sur('alpha') });
    assert.equal(inconnu.statusCode, 302);
    assert.equal(inconnu.headers['set-cookie'], undefined);

    codes.set('pour-beta', { slug: 'beta', identite: { id: 'id-marie', email: 'marie@exemple.org', emailVerifie: true } });
    const autreWiki = await app.inject({ method: 'GET', url: '/auth/retour?code=pour-beta', headers: sur('alpha') });
    assert.equal(autreWiki.headers['set-cookie'], undefined);
    const reutilise = await app.inject({ method: 'GET', url: '/auth/retour?code=pour-beta', headers: sur('beta') });
    assert.equal(reutilise.headers['set-cookie'], undefined, 'le code a été consommé');
});

test('retour de connexion : pas de redirection vers un autre site', async () => {
    for (const suite of ['//evil.test/x', 'https://evil.test', '/\\evil.test']) {
        codes.set('c', { slug: 'alpha', identite: { id: 'id-marie', email: 'marie@exemple.org', emailVerifie: true } });
        const r = await app.inject({ method: 'GET', url: `/auth/retour?code=c&suite=${encodeURIComponent(suite)}`, headers: sur('alpha') });
        assert.equal(r.headers.location, '/', suite);
    }
});

test('membres : invitation par email seulement (pas de mot de passe local)', async () => {
    const { cookie } = await connecter('alpha', { id: 'id-marie', email: 'marie@exemple.org', emailVerifie: true });
    const h = sur('alpha', { cookie });
    const avecMdp = await app.inject({ method: 'POST', url: '/api/membres', payload: { identifiant: 'paul', motDePasse: 'mot-de-passe-de-paul' }, headers: h });
    assert.equal(avecMdp.statusCode, 400);
    const invite = await app.inject({ method: 'POST', url: '/api/membres', payload: { identifiant: 'paul@exemple.org', role: 'editor' }, headers: h });
    assert.equal(invite.statusCode, 200, invite.body);
    // Paul se connecte avec cette adresse vérifiée : il reprend l'invitation
    const { cookie: cp } = await connecter('alpha', { id: 'id-paul', email: 'paul@exemple.org', emailVerifie: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/session', headers: sur('alpha', { cookie: cp }) })).json().role, 'editor');
});
