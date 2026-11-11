// Comptes utilisateurs, appartenance aux wikis (rôles) et sessions.
import { PostgresAdapter } from 'kysely';

export async function up(db) {
    const postgres = db.getExecutor().adapter instanceof PostgresAdapter;
    const id = c => (postgres ? c.primaryKey().generatedByDefaultAsIdentity() : c.primaryKey().autoIncrement());

    await db.schema.createTable('users')
        .addColumn('id', 'integer', id)
        .addColumn('identifiant', 'text', c => c.notNull().unique())   // nom de connexion, en minuscules
        .addColumn('email', 'text', c => c.unique())
        .addColumn('nom', 'text', c => c.notNull())                    // nom affiché
        .addColumn('password_hash', 'text', c => c.notNull())
        .addColumn('email_verifie', 'integer', c => c.notNull().defaultTo(0))
        .addColumn('desactive', 'integer', c => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', c => c.notNull())
        .addColumn('last_login_at', 'text')
        .execute();

    await db.schema.createTable('members')
        .addColumn('wiki_id', 'integer', c => c.notNull().references('wikis.id').onDelete('cascade'))
        .addColumn('user_id', 'integer', c => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('role', 'text', c => c.notNull())                   // owner | editor | reader
        .addColumn('created_at', 'text', c => c.notNull())
        .addPrimaryKeyConstraint('members_pk', ['wiki_id', 'user_id'])
        .execute();

    await db.schema.createTable('sessions')
        .addColumn('id', 'text', c => c.primaryKey())                  // empreinte SHA-256 du jeton (le jeton n'est jamais stocké)
        .addColumn('user_id', 'integer', c => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('created_at', 'text', c => c.notNull())
        .addColumn('expires_at', 'text', c => c.notNull())
        .addColumn('ip', 'text')
        .addColumn('user_agent', 'text')
        .execute();
    await db.schema.createIndex('sessions_user').on('sessions').column('user_id').execute();
}

export async function down(db) {
    for (const t of ['sessions', 'members', 'users']) await db.schema.dropTable(t).execute();
}
