// Mise à jour du schéma : copie automatique de la base avant les migrations. Lancer avec : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouvrirSqlite, migrer, etatMigrations, sauvegarderAvantMigration } from '../src/db/index.js';

test('base neuve ou à jour : pas de copie ; mise à jour : copie avant migration, 5 copies au plus', async () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'wiziki-migrations-'));
    const sauvegardes = path.join(dossier, 'sauvegardes');
    const db = ouvrirSqlite(path.join(dossier, 'wiziki.db'));
    try {
        assert.equal(await sauvegarderAvantMigration(db, sauvegardes), null, 'base neuve');
        await migrer(db);
        assert.equal((await etatMigrations(db)).enAttente.length, 0);
        assert.equal(await sauvegarderAvantMigration(db, sauvegardes), null, 'base à jour');

        // Simule une base créée par une version précédente (dernière migration pas encore appliquée)
        const derniere = async () => {
            const { appliquees } = await etatMigrations(db);
            const nom = appliquees.at(-1);
            db.sqlite.exec('DROP INDEX IF EXISTS users_kratos_id; ALTER TABLE users DROP COLUMN kratos_id;');
            db.sqlite.prepare('DELETE FROM wiziki_migrations WHERE name = ?').run(nom);
            return nom;
        };
        for (let i = 0; i < 7; i++) {
            const nom = await derniere();
            const copie = await sauvegarderAvantMigration(db, sauvegardes);
            assert.ok(copie && fs.existsSync(copie), 'copie créée');
            assert.match(path.basename(copie), new RegExp(`^wiziki-avant-${nom}-`));
            assert.deepEqual(await migrer(db), [nom]);
            await new Promise(r => setTimeout(r, 1100)); // noms horodatés à la seconde
        }
        assert.equal(fs.readdirSync(sauvegardes).length, 5, 'seules les 5 dernières copies sont gardées');
        // La copie est une base SQLite lisible, au schéma d'avant la mise à jour
        const copie = ouvrirSqlite(path.join(sauvegardes, fs.readdirSync(sauvegardes).sort().at(-1)));
        const colonnes = copie.sqlite.prepare("select name from pragma_table_info('users')").all().map(c => c.name);
        assert.ok(!colonnes.includes('kratos_id'));
        await copie.destroy();
    } finally {
        await db.destroy();
        fs.rmSync(dossier, { recursive: true, force: true });
    }
});
