// Schéma initial. Écrit pour fonctionner sur SQLite et PostgreSQL.
import { sql, PostgresAdapter } from 'kysely';

const estPostgres = db => db.getExecutor().adapter instanceof PostgresAdapter;

function colonneId(db) {
    return estPostgres(db)
        ? col => col.primaryKey().generatedByDefaultAsIdentity()
        : col => col.primaryKey().autoIncrement();
}

export async function up(db) {
    const id = colonneId(db);

    await db.schema.createTable('wikis')
        .addColumn('id', 'integer', id)
        .addColumn('slug', 'text', c => c.notNull().unique())
        .addColumn('nom', 'text', c => c.notNull())
        .addColumn('parametres', 'text', c => c.notNull().defaultTo('{}'))      // JSON
        .addColumn('visibilite', 'text', c => c.notNull().defaultTo('public'))  // public | prive | non_liste
        .addColumn('owner_id', 'integer')
        .addColumn('suspendu', 'integer', c => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', c => c.notNull())
        .addColumn('updated_at', 'text', c => c.notNull())
        .execute();

    await db.schema.createTable('pages')
        .addColumn('id', 'integer', id)
        .addColumn('wiki_id', 'integer', c => c.notNull().references('wikis.id').onDelete('cascade'))
        .addColumn('slug', 'text', c => c.notNull())
        .addColumn('titre', 'text', c => c.notNull())
        .addColumn('contenu', 'text', c => c.notNull().defaultTo(''))
        .addColumn('parent_id', 'integer', c => c.references('pages.id').onDelete('set null'))
        .addColumn('position', 'integer')
        .addColumn('dans_arbre', 'integer', c => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', c => c.notNull())
        .addColumn('updated_at', 'text', c => c.notNull())
        .addColumn('updated_by', 'integer')
        .addColumn('deleted_at', 'text')
        .execute();
    // Un slug est unique dans un wiki, parmi les pages non supprimées
    await sql`CREATE UNIQUE INDEX pages_wiki_slug ON pages (wiki_id, slug) WHERE deleted_at IS NULL`.execute(db);
    await db.schema.createIndex('pages_wiki_parent').on('pages').columns(['wiki_id', 'parent_id']).execute();

    await db.schema.createTable('revisions')
        .addColumn('id', 'integer', id)
        .addColumn('page_id', 'integer', c => c.notNull().references('pages.id').onDelete('cascade'))
        .addColumn('wiki_id', 'integer', c => c.notNull().references('wikis.id').onDelete('cascade'))
        .addColumn('titre', 'text', c => c.notNull())
        .addColumn('contenu', 'text', c => c.notNull())
        .addColumn('author_id', 'integer')
        .addColumn('created_at', 'text', c => c.notNull())
        .execute();
    await db.schema.createIndex('revisions_page').on('revisions').columns(['page_id', 'id']).execute();

    await db.schema.createTable('media')
        .addColumn('id', 'integer', id)
        .addColumn('wiki_id', 'integer', c => c.notNull().references('wikis.id').onDelete('cascade'))
        .addColumn('cle', 'text', c => c.notNull())          // ex. uploads/img_123.png, media/logo.png
        .addColumn('mime', 'text', c => c.notNull())
        .addColumn('taille', 'integer', c => c.notNull())
        .addColumn('uploader_id', 'integer')
        .addColumn('created_at', 'text', c => c.notNull())
        .addUniqueConstraint('media_wiki_cle', ['wiki_id', 'cle'])
        .execute();
}

export async function down(db) {
    for (const table of ['media', 'revisions', 'pages', 'wikis']) await db.schema.dropTable(table).execute();
}
