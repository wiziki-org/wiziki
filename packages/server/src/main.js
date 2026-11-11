#!/usr/bin/env node
// Point d'entrée du serveur Wiziki (mode standalone).
import { ouvrirSqlite, migrer } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { lireConfig } from './config.js';
import { construireApp } from './app.js';

const config = lireConfig();
const db = ouvrirSqlite(config.fichierBase);
const appliquees = await migrer(db);
if (appliquees.length) console.log(`Base de données : migrations appliquées (${appliquees.join(', ')})`);

const storage = creerStockageDisque(config.dossierFichiers);
const app = await construireApp({ config, db, storage });

if (!config.motDePasseAdmin) {
    app.log.warn('ADMIN_PASSWORD non défini : le wiki est en LECTURE SEULE. Définissez ADMIN_PASSWORD pour pouvoir le modifier.');
}

const arreter = async signal => {
    app.log.info(`${signal} reçu, arrêt du serveur`);
    await app.close();
    await db.destroy();
    process.exit(0);
};
process.on('SIGTERM', arreter);
process.on('SIGINT', arreter);

await app.listen({ port: config.port, host: config.hote });
console.log(`🚀 Wiziki démarré sur http://localhost:${config.port} (données : ${config.dossierDonnees})`);
