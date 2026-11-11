// Redirections : l'ancien nom d'une page renommée continue de mener à elle (liens et adresses).
import { PostgresAdapter } from 'kysely';

export async function up(db) {
    const postgres = db.getExecutor().adapter instanceof PostgresAdapter;
    await db.schema.createTable('redirections')
        .addColumn('id', 'integer', c => (postgres ? c.primaryKey().generatedByDefaultAsIdentity() : c.primaryKey().autoIncrement()))
        .addColumn('wiki_id', 'integer', c => c.notNull().references('wikis.id').onDelete('cascade'))
        .addColumn('ancien_slug', 'text', c => c.notNull())
        .addColumn('page_id', 'integer', c => c.notNull().references('pages.id').onDelete('cascade'))
        .addColumn('created_at', 'text', c => c.notNull())
        .addUniqueConstraint('redirections_wiki_slug', ['wiki_id', 'ancien_slug'])
        .execute();
}

export async function down(db) {
    await db.schema.dropTable('redirections').execute();
}
