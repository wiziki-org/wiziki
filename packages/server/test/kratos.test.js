// Identification par Ory Kratos (WIZIKI_AUTH=kratos), avec un faux serveur Kratos local. Lancer avec : npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { construireApp } from '../src/app.js';
import { lireConfig } from '../src/config.js';

// ------------------------------------------------------------ Faux Kratos

// jeton de session -> identité (ou 'aal2' : seconde étape requise)
const sessions = new Map();
const identite = (id, email, verifie = true) => ({
    id, traits: { email }, verifiable_addresses: [{ value: email, verified: verifie, via: 'email' }],
});
let appelsWhoami = 0;
let derniereRequete = null;
let kratosEnPanne = false;
let base;

const fauxKratos = http.createServer((req, res) => {
    if (kratosEnPanne) { req.socket.destroy(); return; }
    let corps = '';
    req.on('data', c => { corps += c; });
    req.on('end', () => {
        derniereRequete = { methode: req.method, url: req.url, entetes: req.headers, corps };
        const json = (statut, objet, entetes = {}) => {
            res.writeHead(statut, { 'content-type': 'application/json', ...entetes });
            res.end(JSON.stringify(objet));
        };
        const jeton = /ory_kratos_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        if (req.url === '/sessions/whoami') {
            appelsWhoami++;
            const s = sessions.get(jeton);
            if (s === 'aal2') return json(403, { error: { id: 'session_aal2_required' } });
            if (!s) return json(401, { error: { id: 'session_inactive' } });
            return json(200, { active: true, identity: s });
        }
        if (req.url.startsWith('/self-service/login/browser')) {
            return json(200, { id: 'flux1', ui: { action: `${base}/self-service/login?flow=flux1`, nodes: [] } },
                { 'set-cookie': ['csrf_token_abc=jeton-csrf; Path=/; HttpOnly'] });
        }
        if (req.url.startsWith('/self-service/login?flow=')) {
            return json(200, { session: { active: true } }, { 'set-cookie': ['ory_kratos_session=nouvelle; Path=/; HttpOnly'] });
        }
        if (req.url.startsWith('/self-service/logout/browser')) {
            res.writeHead(303, { location: `${base}/self-service/login/browser?x=1` });
            return res.end();
        }
        json(404, { error: { message: 'inconnu' } });
    });
});

// ------------------------------------------------------------ Wiki en mode Kratos

let app, db, dossier;

before(async () => {
    await new Promise(r => fauxKratos.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${fauxKratos.address().port}`;
    dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-kratos-'));
    db = ouvrirSqlite(':memory:');
    await migrer(db);
    const config = { ...lireConfig({ WIZIKI_DATA_DIR: dossier, WIZIKI_AUTH: 'kratos', WIZIKI_KRATOS_URL: base + '/' }), logs: 'silent' };
    app = await construireApp({ config, db, storage: creerStockageDisque(path.join(dossier, 'files')) });
});

after(async () => {
    await app.close();
    await db.destroy();
    fauxKratos.close();
    fs.rmSync(dossier, { recursive: true, force: true });
});

const avec = jeton => ({ cookie: `ory_kratos_session=${jeton}` });
const session = async jeton => (await app.inject({ method: 'GET', url: '/api/session', headers: jeton ? avec(jeton) : {} })).json();
const texte = { 'content-type': 'text/plain' };

test('configuration : valeurs de WIZIKI_AUTH contrôlées', () => {
    assert.throws(() => lireConfig({ WIZIKI_AUTH: 'ldap' }), /local.*kratos/);
    assert.throws(() => lireConfig({ WIZIKI_AUTH: 'kratos' }), /WIZIKI_KRATOS_URL/);
    assert.throws(() => lireConfig({ WIZIKI_AUTH: 'kratos', WIZIKI_KRATOS_URL: 'ftp://x' }), /invalide/);
    assert.equal(lireConfig({}).auth, 'local');
    assert.equal(lireConfig({}).kratos, null);
});

test('installation : connexion Kratos puis jeton → propriétaire', async () => {
    sessions.set('s-marie', identite('id-marie', 'marie@exemple.org'));
    const anonyme = await session();
    assert.equal(anonyme.auth, 'kratos');
    assert.equal(anonyme.installationRequise, true);

    const jeton = app.jetonInstallationPourTests();
    const sansSession = await app.inject({ method: 'POST', url: '/api/installation', payload: { jeton } });
    assert.equal(sansSession.statusCode, 401);
    const mauvais = await app.inject({ method: 'POST', url: '/api/installation', payload: { jeton: 'faux' }, headers: avec('s-marie') });
    assert.equal(mauvais.statusCode, 403);
    const ok = await app.inject({ method: 'POST', url: '/api/installation', payload: { jeton }, headers: avec('s-marie') });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['set-cookie'], undefined, 'pas de session locale : la session est celle de Kratos');

    const s = await session('s-marie');
    assert.equal(s.role, 'owner');
    assert.equal(s.utilisateur.identifiant, 'marie');
    assert.equal(s.utilisateur.email, 'marie@exemple.org');
    assert.equal(s.utilisateur.externe, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/page/accueil', payload: 'Bonjour', headers: { ...avec('s-marie'), ...texte } })).statusCode, 200);
});

test('session Kratos gardée en cache peu de temps, sessions invalides refusées', async () => {
    const avant = appelsWhoami;
    await session('s-marie');
    await session('s-marie');
    assert.equal(appelsWhoami, avant, 'whoami déjà en cache');
    const inconnue = await session('s-inconnue');
    assert.equal(inconnue.connecte, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/page/x', payload: 'x', headers: { ...avec('s-inconnue'), ...texte } })).statusCode, 401);

    sessions.set('s-2fa', 'aal2');
    const deuxEtapes = await session('s-2fa');
    assert.equal(deuxEtapes.connecte, false);
    assert.equal(deuxEtapes.secondeEtape, true);
});

test('membres : invitation par email, reliée seulement à une adresse vérifiée', async () => {
    const marie = avec('s-marie');
    const r = await app.inject({ method: 'POST', url: '/api/membres', payload: { email: 'paul@exemple.org', role: 'editor' }, headers: marie });
    assert.equal(r.statusCode, 200, r.body);

    // Quelqu'un s'inscrit avec l'adresse de Paul sans la vérifier : il n'obtient pas les droits de Paul
    sessions.set('s-usurpateur', identite('id-usurpateur', 'paul@exemple.org', false));
    const usurpateur = await session('s-usurpateur');
    assert.equal(usurpateur.connecte, true);
    assert.equal(usurpateur.role, null);
    assert.equal(usurpateur.utilisateur.email, null, "l'adresse non vérifiée n'est pas enregistrée");
    assert.notEqual(usurpateur.utilisateur.identifiant, 'paul');

    // Paul, adresse vérifiée : relié au compte invité, avec son rôle
    sessions.set('s-paul', identite('id-paul', 'Paul@Exemple.org'));
    const paul = await session('s-paul');
    assert.equal(paul.role, 'editor');
    assert.equal(paul.utilisateur.identifiant, 'paul');
    assert.equal((await app.inject({ method: 'POST', url: '/api/page/paul', payload: 'écrit par Paul', headers: { ...avec('s-paul'), ...texte } })).statusCode, 200);
    // Un éditeur ne gère pas les membres
    assert.equal((await app.inject({ method: 'GET', url: '/api/membres', headers: avec('s-paul') })).statusCode, 403);

    const membres = (await app.inject({ method: 'GET', url: '/api/membres', headers: marie })).json();
    assert.deepEqual(membres.map(m => [m.identifiant, m.role, !!m.externe]), [['marie', 'owner', true], ['paul', 'editor', true]]);
    // L'historique montre le nom de l'auteur
    assert.equal((await app.inject({ method: 'GET', url: '/api/page/paul/revisions', headers: marie })).json()[0].auteur, 'paul');
});

test('relais /kratos/ : parcours self-service seulement, cookies filtrés', async () => {
    const r = await app.inject({
        method: 'GET', url: '/kratos/self-service/login/browser?refresh=true',
        headers: { accept: 'application/json', cookie: 'wz_session=secret-du-wiki; csrf_token_abc=jeton-csrf; autre=x' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().id, 'flux1');
    assert.equal(derniereRequete.url, '/self-service/login/browser?refresh=true');
    assert.equal(derniereRequete.entetes.cookie, 'csrf_token_abc=jeton-csrf', 'la session du wiki ne part pas vers Kratos');
    assert.match(String(r.headers['set-cookie']), /^csrf_token_abc=jeton-csrf/);

    // Envoi d'un formulaire en JSON : corps transmis tel quel, cookie de session posé sur le domaine du wiki
    const corps = JSON.stringify({ method: 'password', identifier: 'marie@exemple.org', password: 'x', csrf_token: 't' });
    const envoi = await app.inject({ method: 'POST', url: '/kratos/self-service/login?flow=flux1', payload: corps, headers: { 'content-type': 'application/json', accept: 'application/json' } });
    assert.equal(envoi.statusCode, 200);
    assert.equal(derniereRequete.corps, corps);
    assert.match(String(envoi.headers['set-cookie']), /^ory_kratos_session=nouvelle/);

    // Redirection vers Kratos ramenée sur le relais
    const sortie = await app.inject({ method: 'GET', url: '/kratos/self-service/logout/browser' });
    assert.equal(sortie.statusCode, 303);
    assert.equal(sortie.headers.location, '/kratos/self-service/login/browser?x=1');

    // Tout le reste est refusé (API d'administration, sessions, chemins détournés)
    for (const url of ['/kratos/sessions/whoami', '/kratos/admin/identities', '/kratos/self-service/../admin/identities', '/kratos/identities', '/kratos/']) {
        const refus = await app.inject({ method: 'GET', url });
        assert.equal(refus.statusCode, 404, url);
    }
});

test('déconnexion : la session Kratos est oubliée tout de suite', async () => {
    sessions.set('s-courte', identite('id-paul', 'paul@exemple.org'));
    assert.equal((await session('s-courte')).connecte, true);
    sessions.delete('s-courte'); // fermée côté Kratos
    assert.equal((await session('s-courte')).connecte, true, 'encore en cache');
    await app.inject({ method: 'POST', url: '/api/logout', headers: avec('s-courte') });
    assert.equal((await session('s-courte')).connecte, false);
});

test('Kratos en panne : lecture possible, écriture refusée avec un message clair', async () => {
    kratosEnPanne = true;
    try {
        sessions.set('s-panne', identite('id-marie', 'marie@exemple.org'));
        const s = await session('s-panne');
        assert.equal(s.connecte, false);
        assert.equal(s.kratosIndisponible, true);
        assert.equal((await app.inject({ method: 'GET', url: '/api/page/accueil', headers: avec('s-panne') })).statusCode, 200);
        const ecriture = await app.inject({ method: 'POST', url: '/api/page/accueil', payload: 'x', headers: { ...avec('s-panne'), ...texte } });
        assert.equal(ecriture.statusCode, 503);
        assert.equal((await app.inject({ method: 'GET', url: '/kratos/self-service/login/browser' })).statusCode, 502);
    } finally { kratosEnPanne = false; }
});

test('compte local de secours : toujours utilisable en mode Kratos', async () => {
    const marie = avec('s-marie');
    const r = await app.inject({ method: 'POST', url: '/api/membres', payload: { identifiant: 'secours', motDePasse: 'mot-de-passe-secours', role: 'owner' }, headers: marie });
    assert.equal(r.statusCode, 200, r.body);
    kratosEnPanne = true;
    try {
        const login = await app.inject({ method: 'POST', url: '/api/login', payload: { identifiant: 'secours', motDePasse: 'mot-de-passe-secours' } });
        assert.equal(login.statusCode, 200);
        const cookie = login.headers['set-cookie'].split(';')[0];
        assert.equal((await app.inject({ method: 'POST', url: '/api/page/accueil', payload: 'réparé', headers: { cookie, ...texte } })).statusCode, 200);
    } finally { kratosEnPanne = false; }
    // Un compte Kratos n'a pas de mot de passe local : impossible de s'y connecter par /api/login
    const sansMdp = await app.inject({ method: 'POST', url: '/api/login', payload: { identifiant: 'paul', motDePasse: '!externe' } });
    assert.equal(sansMdp.statusCode, 401);
});

test('adresse vérifiée après la première connexion : l\'invitation est reprise', async () => {
    const marie = avec('s-marie');
    await app.inject({ method: 'POST', url: '/api/membres', payload: { identifiant: 'lea@exemple.org', role: 'reader' }, headers: marie });
    sessions.set('s-lea', identite('id-lea', 'lea@exemple.org', false));
    const avant = await session('s-lea');
    assert.equal(avant.role, null, 'adresse pas encore vérifiée');

    // Léa vérifie son adresse dans Kratos ; le wiki relit son identité sans attendre la fin du cache
    sessions.set('s-lea', identite('id-lea', 'lea@exemple.org', true));
    const apres = (await app.inject({ method: 'GET', url: '/api/session?rafraichir=1', headers: avec('s-lea') })).json();
    assert.equal(apres.role, 'reader');
    assert.equal(apres.utilisateur.id, avant.utilisateur.id, 'même compte, invitation fusionnée');
    assert.equal(apres.utilisateur.email, 'lea@exemple.org');
    const membres = (await app.inject({ method: 'GET', url: '/api/membres', headers: marie })).json();
    assert.equal(membres.filter(m => m.email === 'lea@exemple.org').length, 1, "l'invitation en attente a disparu");
});

test('inscription fermée par défaut : le relais refuse les parcours d\'inscription', async () => {
    assert.equal((await session()).inscription, false);
    for (const url of ['/kratos/self-service/registration/browser', '/kratos/self-service/registration?flow=x', '/kratos/self-service/registration/flows?id=x']) {
        assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url);
    }
});

test('un compte avec mot de passe n\'est jamais relié par son adresse email, seulement par wiziki relier-kratos', async () => {
    const marie = avec('s-marie');
    const r = await app.inject({ method: 'POST', url: '/api/membres', payload: { identifiant: 'chef', email: 'chef@exemple.org', motDePasse: 'mot-de-passe-du-chef', role: 'owner' }, headers: marie });
    assert.equal(r.statusCode, 200, r.body);
    // Quelqu'un crée une identité Kratos avec cette adresse, même vérifiée : aucun droit
    sessions.set('s-intrus', identite('id-intrus', 'chef@exemple.org', true));
    const intrus = await session('s-intrus');
    assert.equal(intrus.role, null);
    assert.notEqual(intrus.utilisateur.identifiant, 'chef');

    const { creerServiceComptes } = await import('@wiziki/core');
    const comptes = creerServiceComptes({ db });
    await assert.rejects(comptes.relierKratos('chef', 'pas-un-uuid'), /UUID/);
    const id = '0b7c2a9e-4f1d-4c3b-9a8e-123456789abc';
    await comptes.relierKratos('chef', id);
    sessions.set('s-chef', identite(id, 'chef@exemple.org', true));
    const chef = await session('s-chef');
    assert.equal(chef.utilisateur.identifiant, 'chef');
    assert.equal(chef.role, 'owner');
    await assert.rejects(comptes.relierKratos('marie', id), /déjà reliée/);
});
