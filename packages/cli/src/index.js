#!/usr/bin/env node
// CLI Wiziki : wiziki <commande> [options]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { creerServiceWiki, creerServiceComptes, creerServiceArchive, arbreTolerant, ROLES, REGEX_SLUG, REGEX_CLE_FICHIER, TYPES_MIME } from '@wiziki/core';
import { creerZip, lireZip } from '@wiziki/adapters/archive';
import { ouvrirSqlite, migrer, sauvegarderSqlite } from '@wiziki/adapters/db';
import { creerStockageDisque } from '@wiziki/adapters/storage';

const AIDE = `Usage : wiziki <commande> [options]

Commandes :
  migrate                         Crée ou met à jour le schéma de la base de données
  import-legacy <dossier>         Importe un wiki de l'ancienne version (pages/, media/, uploads/, structure.json)
      --wiki <slug>               Wiki de destination (défaut : default)
      --force                     Remplace le contenu du wiki s'il en a déjà
  export <fichier.zip>            Exporte le wiki (pages, arbre, images, historique) au format ouvert Wiziki
      --sans-historique           N'inclut que la dernière version de chaque page
  import <fichier.zip>            Importe un export Wiziki dans le wiki (membres et visibilité conservés)
      --force                     Remplace le contenu du wiki s'il en a déjà
  backup <fichier.db>             Copie cohérente de la base, même serveur démarré
  info                            Liste les wikis et leur contenu
  utilisateur-ajouter <identifiant>   Crée un compte et l'ajoute au wiki
      --role <owner|editor|reader>    Rôle sur le wiki (défaut : editor)
      --email <adresse>  --nom <nom affiché>
  mot-de-passe <identifiant>      Définit un nouveau mot de passe (ferme toutes ses sessions)
      Le mot de passe est lu dans $WIZIKI_NOUVEAU_MOT_DE_PASSE, sinon demandé au clavier
  utilisateurs                    Liste les comptes et leur rôle
  relier-kratos <identifiant> <id-kratos>   Relie un compte à une identité Kratos (WIZIKI_AUTH=kratos)

Options communes :
  --data <dossier>                Dossier des données (défaut : $WIZIKI_DATA_DIR ou ./data)
`;

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        data: { type: 'string' },
        wiki: { type: 'string', default: 'default' },
        force: { type: 'boolean', default: false },
        'sans-historique': { type: 'boolean', default: false },
        role: { type: 'string', default: 'editor' },
        email: { type: 'string' },
        nom: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

const [commande, ...args] = positionals;
if (!commande || opts.help) { console.log(AIDE); process.exit(commande ? 0 : 1); }

const dossierDonnees = path.resolve(opts.data || process.env.WIZIKI_DATA_DIR || './data');
const db = ouvrirSqlite(path.join(dossierDonnees, 'wiziki.db'));
const dossierFichiers = path.join(dossierDonnees, 'files');
const storage = creerStockageDisque(dossierFichiers);
const service = creerServiceWiki({ db, storage });
const comptes = creerServiceComptes({ db });
const archives = creerServiceArchive({ db, storage, wikis: service, logiciel: { nom: 'wiziki', version: lireVersion() } });

try {
    await migrer(db);
    switch (commande) {
        case 'migrate': console.log('✅ Schéma à jour.'); break;
        case 'import-legacy': await importerAncienWiki(args[0]); break;
        case 'export': await exporter(args[0]); break;
        case 'import': await importer(args[0]); break;
        case 'backup': await sauvegarde(args[0]); break;
        case 'info': await info(); break;
        case 'utilisateur-ajouter': await ajouterUtilisateur(args[0]); break;
        case 'mot-de-passe': await definirMotDePasse(args[0]); break;
        case 'utilisateurs': await listerUtilisateurs(); break;
        case 'relier-kratos': {
            if (args.length < 2) throw new Error('Usage : wiziki relier-kratos <identifiant> <id-kratos>');
            const u = await comptes.relierKratos(args[0], args[1]);
            console.log(`✅ Compte « ${u.identifiant} » relié à l'identité Kratos ${args[1]}.`);
            break;
        }
        default: console.error(`Commande inconnue : ${commande}\n`); console.log(AIDE); process.exitCode = 1;
    }
} catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}

// ---------------------------------------------------------------------------

function listerFichiersRecursif(dossier, base = dossier) {
    if (!fs.existsSync(dossier)) return [];
    return fs.readdirSync(dossier, { withFileTypes: true }).flatMap(e => {
        const complet = path.join(dossier, e.name);
        if (e.isDirectory()) return listerFichiersRecursif(complet, base);
        return e.isFile() ? [path.relative(base, complet).split(path.sep).join('/')] : [];
    });
}

async function importerAncienWiki(source) {
    if (!source) throw new Error('Indiquez le dossier de l\'ancien wiki : wiziki import-legacy <dossier>');
    source = path.resolve(source);
    const dossierPages = path.join(source, 'pages');
    if (!fs.existsSync(dossierPages)) throw new Error(`Dossier introuvable : ${dossierPages}`);

    const avertissements = [];
    const avertir = m => avertissements.push(m);

    // Wiki de destination
    let wiki = await service.trouverWikiParSlug(opts.wiki);
    if (wiki) {
        const nb = await db.selectFrom('pages').select(db.fn.countAll().as('n')).where('wiki_id', '=', wiki.id).executeTakeFirst();
        if (Number(nb.n) > 0) {
            if (!opts.force) throw new Error(`Le wiki « ${opts.wiki} » contient déjà ${nb.n} pages. Relancez avec --force pour le remplacer.`);
            await db.deleteFrom('wikis').where('id', '=', wiki.id).execute(); // cascade : pages, révisions, médias
            fs.rmSync(path.join(dossierFichiers, String(wiki.id)), { recursive: true, force: true });
            wiki = null;
        }
    }
    if (!wiki) wiki = await service.creerWiki({ slug: opts.wiki });
    const wikiId = wiki.id;

    // 1. Pages
    const fichiersPages = fs.readdirSync(dossierPages).filter(f => /\.(md|txt)$/i.test(f));
    let nbPages = 0;
    for (const fichier of fichiersPages) {
        const slug = fichier.replace(/\.(md|txt)$/i, '');
        if (!REGEX_SLUG.test(slug)) { avertir(`page ignorée (nom invalide) : ${fichier}`); continue; }
        const complet = path.join(dossierPages, fichier);
        const contenu = fs.readFileSync(complet, 'utf8');
        if (await service.trouverPage(wikiId, slug)) { avertir(`page en double (.md et .txt) ignorée : ${fichier}`); continue; }
        await service.enregistrerPage(wikiId, slug, contenu);
        // Conserver la date de dernière modification d'origine
        const date = fs.statSync(complet).mtime.toISOString();
        const page = await service.trouverPage(wikiId, slug);
        await db.updateTable('pages').set({ created_at: date, updated_at: date }).where('id', '=', page.id).execute();
        await db.updateTable('revisions').set({ created_at: date }).where('page_id', '=', page.id).execute();
        nbPages++;
    }

    // 2. Arbre et paramètres
    const fichierStructure = path.join(source, 'structure.json');
    let structure = { parametres: {}, arbre: [] };
    if (fs.existsSync(fichierStructure)) structure = JSON.parse(fs.readFileSync(fichierStructure, 'utf8'));
    else avertir('structure.json absent : toutes les pages seront « non classées »');
    const arbre = arbreTolerant(structure.arbre, avertir);
    await service.enregistrerStructure(wikiId, { parametres: structure.parametres, arbre });

    // 3. Images (media/ et uploads/)
    let nbFichiers = 0;
    for (const prefixe of ['media', 'uploads']) {
        for (const relatif of listerFichiersRecursif(path.join(source, prefixe))) {
            const cle = `${prefixe}/${relatif}`;
            if (!TYPES_MIME[path.extname(cle).toLowerCase()]) { avertir(`fichier ignoré (pas une image) : ${cle}`); continue; }
            if (!REGEX_CLE_FICHIER.test(cle)) { avertir(`fichier ignoré (nom avec caractères non gérés) : ${cle}`); continue; }
            await service.importerFichier(wikiId, cle, fs.readFileSync(path.join(source, prefixe, relatif)));
            nbFichiers++;
        }
    }

    const resultat = await service.lireStructure(wikiId, { avecOrphelins: true });
    const compter = els => els.reduce((n, e) => n + 1 + compter(e.enfants), 0);
    console.log(`✅ Import terminé dans le wiki « ${opts.wiki} » (id ${wikiId})`);
    console.log(`   ${nbPages} pages importées, ${compter(resultat.arbre)} dans l'arbre, ${resultat.orphelins.length} non classées`);
    console.log(`   ${nbFichiers} images importées`);
    if (avertissements.length) {
        console.log(`⚠️  ${avertissements.length} avertissement(s) :`);
        for (const a of avertissements) console.log(`   - ${a}`);
    }
}

function lireVersion() {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

async function exporter(destination) {
    if (!destination) throw new Error('Indiquez le fichier à créer : wiziki export <fichier.zip>');
    const wiki = await service.trouverWikiParSlug(opts.wiki);
    if (!wiki) throw new Error(`Wiki « ${opts.wiki} » introuvable.`);
    const fichiers = await archives.exporterWiki(wiki.id, { historique: !opts['sans-historique'] });
    const zip = creerZip(fichiers);
    const temporaire = `${path.resolve(destination)}.tmp`;
    fs.writeFileSync(temporaire, zip);
    fs.renameSync(temporaire, path.resolve(destination));
    const manifeste = JSON.parse(fichiers.get('wiki.json'));
    console.log(`✅ Wiki « ${wiki.slug} » exporté dans ${path.resolve(destination)} (${(zip.length / 1024 / 1024).toFixed(1)} Mo)`);
    console.log(`   ${manifeste.pages.length} pages, ${manifeste.fichiers.length} images${opts['sans-historique'] ? ', sans historique' : ', avec historique'}`);
}

async function importer(source) {
    if (!source) throw new Error('Indiquez le fichier à importer : wiziki import <fichier.zip>');
    const wiki = await wikiCible();
    const r = await archives.importerWiki(wiki.id, lireZip(fs.readFileSync(path.resolve(source))), { remplacer: opts.force });
    console.log(`✅ Import terminé dans le wiki « ${wiki.slug} » : ${r.pages} pages (${r.dansArbre} dans l'arbre), ${r.versions} versions, ${r.images} images`);
    if (r.avertissements.length) {
        console.log(`⚠️  ${r.avertissements.length} avertissement(s) :`);
        for (const a of r.avertissements) console.log(`   - ${a}`);
    }
}

async function sauvegarde(destination) {
    if (!destination) throw new Error('Indiquez le fichier de destination : wiziki backup <fichier.db>');
    await sauvegarderSqlite(db, path.resolve(destination));
    console.log(`✅ Base sauvegardée dans ${path.resolve(destination)} (les images sont dans ${dossierFichiers})`);
}

async function info() {
    for (const w of await service.listerWikis()) {
        const pages = await db.selectFrom('pages').select(db.fn.countAll().as('n')).where('wiki_id', '=', w.id).where('deleted_at', 'is', null).executeTakeFirst();
        const media = await db.selectFrom('media').select(db.fn.countAll().as('n')).where('wiki_id', '=', w.id).executeTakeFirst();
        console.log(`${w.id}\t${w.slug}\t« ${w.nom} »\t${pages.n} pages\t${media.n} images`);
    }
}

// ---------------------------------------------------------------- Comptes

async function lireMotDePasse(question) {
    if (process.env.WIZIKI_NOUVEAU_MOT_DE_PASSE) return process.env.WIZIKI_NOUVEAU_MOT_DE_PASSE;
    if (!process.stdin.isTTY) throw new Error('Définissez WIZIKI_NOUVEAU_MOT_DE_PASSE ou lancez la commande dans un terminal.');
    // Saisie masquée
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let saisie = '';
        process.stdin.on('data', function lire(octets) {
            for (const c of octets.toString('utf8')) {
                if (c === '\r' || c === '\n') {
                    process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', lire);
                    process.stdout.write('\n'); resolve(saisie); return;
                }
                if (c === '\u0003') { process.stdin.setRawMode(false); reject(new Error('Annulé.')); return; }
                if (c === '\u007f') saisie = saisie.slice(0, -1); else saisie += c;
            }
        });
    });
}

async function wikiCible() {
    // Comme le serveur : le wiki est créé s'il n'existe pas encore (installation préparée en ligne de commande)
    return (await service.trouverWikiParSlug(opts.wiki)) || service.creerWiki({ slug: opts.wiki });
}

async function ajouterUtilisateur(identifiant) {
    if (!identifiant) throw new Error('Indiquez un identifiant : wiziki utilisateur-ajouter <identifiant>');
    if (!ROLES.includes(opts.role)) throw new Error(`Rôle invalide : ${opts.role} (owner, editor ou reader)`);
    const wiki = await wikiCible();
    let u = await comptes.trouverParIdentifiant(identifiant);
    if (!u) {
        const motDePasse = await lireMotDePasse('Mot de passe du nouveau compte : ');
        u = await comptes.creerUtilisateur({ identifiant, email: opts.email, nom: opts.nom, motDePasse });
        console.log(`✅ Compte « ${u.identifiant} » créé.`);
    }
    await comptes.definirRole(wiki.id, u.id, opts.role);
    console.log(`✅ « ${u.identifiant} » est ${opts.role} du wiki « ${wiki.slug} ».`);
}

async function definirMotDePasse(identifiant) {
    if (!identifiant) throw new Error('Indiquez un identifiant : wiziki mot-de-passe <identifiant>');
    const u = await comptes.trouverParIdentifiant(identifiant);
    if (!u) throw new Error(`Compte « ${identifiant} » introuvable.`);
    await comptes.changerMotDePasse(u.id, await lireMotDePasse(`Nouveau mot de passe pour ${u.identifiant} : `));
    console.log(`✅ Mot de passe de « ${u.identifiant} » modifié, ses sessions ont été fermées.`);
}

async function listerUtilisateurs() {
    const wiki = await wikiCible();
    const membres = await comptes.listerMembres(wiki.id);
    if (!membres.length) console.log('Aucun compte. Démarrez le serveur avec ADMIN_PASSWORD, ou utilisez : wiziki utilisateur-ajouter <identifiant> --role owner');
    for (const m of membres) console.log(`${m.identifiant}\t${m.role}\t${m.email || ''}\tdernière connexion : ${m.last_login_at || 'jamais'}`);
}
