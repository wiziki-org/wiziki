// Nom de l'auteur d'une version importée d'un autre wiki (son compte n'existe pas ici).
export async function up(db) {
    await db.schema.alterTable('revisions').addColumn('auteur_nom', 'text').execute();
}

export async function down(db) {
    await db.schema.alterTable('revisions').dropColumn('auteur_nom').execute();
}
