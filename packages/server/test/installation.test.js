// Installation neuve (sans ADMIN_PASSWORD) : création du compte propriétaire avec le jeton des journaux
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { construireApp } from '../src/app.js';
import { lireConfig } from '../src/config.js';

test('installation : jeton exigé, puis compte propriétaire', async () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-install-'));
    const db = ouvrirSqlite(':memory:');
    await migrer(db);
    const config = { ...lireConfig({ WIZIKI_DATA_DIR: dossier }), logs: 'silent' };
    const app = await construireApp({ config, db, storage: creerStockageDisque(path.join(dossier, 'files')) });
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/api/session' })).json().installationRequise, true);
        const sansJeton = await app.inject({ method: 'POST', url: '/api/installation', payload: { jeton: 'faux', identifiant: 'moi', motDePasse: 'un-long-mot-de-passe' } });
        assert.equal(sansJeton.statusCode, 403);
        // Le jeton n'est connu que du serveur : on le récupère comme le ferait l'administrateur (journaux)
        const jeton = app.jetonInstallationPourTests();
        const ok = await app.inject({ method: 'POST', url: '/api/installation', payload: { jeton, identifiant: 'Moi', email: 'moi@exemple.org', motDePasse: 'un-long-mot-de-passe' } });
        assert.equal(ok.statusCode, 200);
        const cookie = ok.headers['set-cookie'].split(';')[0];
        const session = (await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json();
        assert.equal(session.role, 'owner');
        assert.equal(session.utilisateur.identifiant, 'moi');
        assert.equal(session.installationRequise, false);
        // Une seule installation possible
        assert.equal((await app.inject({ method: 'POST', url: '/api/installation', payload: { jeton, identifiant: 'autre', motDePasse: 'un-long-mot-de-passe' } })).statusCode, 409);
        // Connexion par email possible
        assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { identifiant: 'MOI@exemple.org', motDePasse: 'un-long-mot-de-passe' } })).statusCode, 200);
    } finally {
        await app.close();
        await db.destroy();
        fs.rmSync(dossier, { recursive: true, force: true });
    }
});
