#!/usr/bin/env node
// Point d'entrée du serveur Wiziki (mode standalone).
import { ouvrirSqlite, migrer, sauvegarderAvantMigration } from '@wiziki/adapters/db';
import path from 'node:path';
import { creerStockageDisque } from '@wiziki/adapters/storage';
import { lireConfig } from './config.js';
import { construireApp } from './app.js';

const config = lireConfig();
const db = ouvrirSqlite(config.fichierBase);
// Mise à jour : la base est d'abord copiée dans data/sauvegardes/ (5 dernières copies gardées)
const copie = await sauvegarderAvantMigration(db, path.join(config.dossierDonnees, 'sauvegardes'));
if (copie) console.log(`Base de données sauvegardée avant mise à jour : ${copie}`);
const appliquees = await migrer(db);
if (appliquees.length) console.log(`Base de données : migrations appliquées (${appliquees.join(', ')})`);

const storage = creerStockageDisque(config.dossierFichiers);
const app = await construireApp({ config, db, storage });

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
