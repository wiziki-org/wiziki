// Identification par Ory Kratos (WIZIKI_AUTH=kratos) : un compte wiziki peut être relié à une identité Kratos.
export async function up(db) {
    await db.schema.alterTable('users').addColumn('kratos_id', 'text').execute();
    await db.schema.createIndex('users_kratos_id').unique().on('users').column('kratos_id').execute();
}

export async function down(db) {
    await db.schema.dropIndex('users_kratos_id').execute();
    await db.schema.alterTable('users').dropColumn('kratos_id').execute();
}
