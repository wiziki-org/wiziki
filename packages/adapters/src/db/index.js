// Accès à la base de données. Mode standalone : SQLite (un seul fichier).
// PostgreSQL (mode platform) sera ajouté ici avec le même schéma et les mêmes migrations.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import * as m001 from './migrations/001_initial.js';
import * as m002 from './migrations/002_redirections.js';
import * as m003 from './migrations/003_comptes.js';
import * as m004 from './migrations/004_auteur_importe.js';
import * as m005 from './migrations/005_kratos.js';

// Liste explicite (pas de lecture de dossier) : fonctionne aussi une fois empaqueté.
const MIGRATIONS = {
    '001_initial': m001,
    '002_redirections': m002,
    '003_comptes': m003,
    '004_auteur_importe': m004,
    '005_kratos': m005,
};

/** Ouvre (et crée si besoin) une base SQLite. `fichier` peut valoir ':memory:' pour les tests. */
export function ouvrirSqlite(fichier) {
    if (fichier !== ':memory:') fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const sqlite = new Database(fichier);
    sqlite.pragma('journal_mode = WAL');    // lectures pendant les écritures
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('synchronous = NORMAL');
    const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    db.sqlite = sqlite; // accès direct (sauvegarde à chaud, etc.)
    return db;
}

/** Applique les migrations manquantes. Renvoie la liste des migrations exécutées. */
export async function migrer(db) {
    const migrator = new Migrator({
        db,
        provider: { getMigrations: async () => MIGRATIONS },
        migrationTableName: 'wiziki_migrations',
        migrationLockTableName: 'wiziki_migrations_lock',
    });
    const { error, results } = await migrator.migrateToLatest();
    if (error) throw error;
    return (results || []).filter(r => r.status === 'Success').map(r => r.migrationName);
}

/** Sauvegarde cohérente de la base SQLite, même pendant que le serveur tourne. */
export async function sauvegarderSqlite(db, destination) {
    if (!db.sqlite) throw new Error('Sauvegarde à chaud disponible uniquement pour SQLite.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await db.sqlite.backup(destination);
}
