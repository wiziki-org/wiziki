// Application HTTP (Fastify). Ne démarre pas l'écoute : voir main.js (et les tests, qui utilisent app.inject()).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { creerServiceWiki, creerServiceComptes, creerServiceArchive, roleSuffit, ErreurWiki, TAILLE_MAX_PAGE, TAILLE_MAX_IMAGE } from '@wiziki/core';
import { creerZip, lireZip } from '@wiziki/adapters/archive';
import { creerClientKratos, KratosIndisponible, SecondeEtapeRequise } from '@wiziki/adapters/kratos';
import { INDEX_FILE, ASSETS_DIR, verifierBuild } from '@wiziki/web';
import { creerLimiteur, COOKIE_SESSION } from './auth.js';

const LIMITE_JSON = 1024 * 1024;
const LIMITE_IMPORT = 512 * 1024 * 1024; // archive ZIP d'un wiki complet
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const CSP = [
    "default-src 'self'",
    // Aucun script en ligne : tout le JavaScript vient de /assets (construit par Vite)
    "script-src 'self'",
    // Styles en ligne autorisés : largeur des images (style="width:…") et couleur des liens choisie dans les paramètres

    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
].join('; ');

const TYPES_STATIQUES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

/**
 * @typedef {object} OptionsMulti Plusieurs wikis servis par un même serveur (ex. une plateforme d'hébergement)
 * @property {(req: any) => Promise<any|null>} resoudreWiki wiki de la requête (ligne de la table `wikis`), ou null (404)
 * @property {(req: any, wiki: any) => string} urlConnexion page de connexion externe ; le wiki y ajoute `suite=<chemin>`
 * @property {string} [urlCompte] page « Mon compte » externe
 * @property {(code: string, req: any, wiki: any) => Promise<{ id: string, email: string|null, emailVerifie: boolean, nom?: string|null }|null>} echangerCode
 *   au retour de la connexion externe (`/auth/retour?code=…`) : identité de la personne, ou null si le code est invalide
 */

/**
 * @param {{ config: ReturnType<import('./config.js').lireConfig>, db: import('kysely').Kysely<any>, storage: any, multi?: OptionsMulti }} deps
 */
export async function construireApp({ config, db, storage, multi = null }) {
    verifierBuild();
    const service = creerServiceWiki({ db, storage });
    const comptes = creerServiceComptes({ db });
    const archives = creerServiceArchive({ db, storage, wikis: service, logiciel: { nom: 'wiziki', version: VERSION } });
    const limiteurIp = creerLimiteur();
    const limiteurCompte = creerLimiteur({ max: 10 });
    // WIZIKI_AUTH=kratos : connexion déléguée à Ory Kratos (les comptes locaux restent utilisables en secours)
    const kratos = config.kratos ? creerClientKratos({ url: config.kratos.url, cookie: config.kratos.cookie }) : null;
    // Cookies transmis à Kratos tels que reçus (sans décodage), filtrés par nom
    const cookiesBruts = (req, garder) => String(req.headers.cookie || '').split(';')
        .map(c => c.trim()).filter(c => { const i = c.indexOf('='); return i > 0 && garder(c.slice(0, i)); });
    const sessionKratos = req => {
        const c = cookiesBruts(req, n => n === kratos.nomCookie)[0];
        return c ? c.slice(c.indexOf('=') + 1) : null;
    };

    // Mode standalone : un seul wiki, créé au premier démarrage. Avec `multi`, le wiki dépend de l'adresse (voir le hook onRequest).
    let wikiUnique = null;
    if (!multi) {
        wikiUnique = await service.trouverWikiParSlug(config.slugWiki);
        if (!wikiUnique) wikiUnique = await service.creerWiki({ slug: config.slugWiki });
    }

    // Premier compte. Avec ADMIN_PASSWORD (installations existantes) : compte « admin » propriétaire, même mot de passe.
    // Sans : écran d'installation protégé par un jeton à usage unique affiché dans les journaux du serveur.
    let jetonInstallation = null;
    const messagesDemarrage = [];
    if (!multi && await comptes.compterUtilisateurs() === 0) {
        if (config.motDePasseAdmin) {
            const admin = await comptes.creerUtilisateur({ identifiant: 'admin', nom: 'Administrateur', motDePasse: config.motDePasseAdmin, forcer: true });
            await comptes.definirRole(wikiUnique.id, admin.id, 'owner');
            messagesDemarrage.push("Compte « admin » créé à partir de ADMIN_PASSWORD (propriétaire du wiki). ADMIN_PASSWORD n'est plus utilisé ensuite.");
        } else {
            jetonInstallation = crypto.randomBytes(18).toString('base64url');
            messagesDemarrage.push(kratos
                ? `Installation : ouvrez le wiki, connectez-vous avec votre compte Kratos, puis saisissez ce jeton pour devenir propriétaire : ${jetonInstallation}`
                : `Installation : ouvrez le wiki et créez le compte propriétaire avec ce jeton : ${jetonInstallation}`);
        }
    }
    if (kratos) messagesDemarrage.push(`Identification par Ory Kratos : ${config.kratos.url}`);
    const purge = setInterval(() => comptes.purgerSessionsExpirees().catch(() => {}), 6 * 3600 * 1000);
    purge.unref();

    const app = Fastify({
        logger: config.logs === 'silent' ? false : { level: config.logs },
        trustProxy: config.trustProxy,
        bodyLimit: LIMITE_JSON,
        requestTimeout: 60_000,
    });
    await app.register(cookie);

    // Wiki concerné par la requête
    app.decorateRequest('wikiId', 0);
    app.addHook('onRequest', async (req, reply) => {
        if (!multi) { req.wikiId = wikiUnique.id; return; }
        const w = await multi.resoudreWiki(req);
        if (!w) return reply.code(404).type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send('Wiki introuvable.');
        req.wikiId = w.id;
    });
    app.addHook('onClose', async () => clearInterval(purge));
    app.addHook('onReady', async () => { for (const m of messagesDemarrage) app.log.warn(m); });

    // Corps bruts : images (octets) et pages (texte). Le JSON est géré par Fastify.
    app.addContentTypeParser(['application/octet-stream', 'image/*'], { parseAs: 'buffer', bodyLimit: TAILLE_MAX_IMAGE }, (req, corps, done) => done(null, corps));
    app.removeContentTypeParser('text/plain');
    app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: TAILLE_MAX_PAGE }, (req, corps, done) => done(null, corps));
    app.addContentTypeParser(['application/zip', 'application/x-zip-compressed'], { parseAs: 'buffer', bodyLimit: LIMITE_IMPORT }, (req, corps, done) => done(null, corps));
    // Par compatibilité, tout autre type est lu tel quel
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: TAILLE_MAX_IMAGE }, (req, corps, done) => done(null, corps));

    // En-têtes de sécurité sur toutes les réponses
    app.addHook('onSend', async (req, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        reply.header('X-Frame-Options', 'SAMEORIGIN');
    });

    app.setErrorHandler((err, req, reply) => {
        let statut = err instanceof ErreurWiki ? err.statut : (err.statusCode || 500);
        let message = err.message;
        if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') { statut = 413; message = 'Contenu trop volumineux.'; }
        else if (err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') { statut = 400; message = 'JSON invalide.'; }
        if (statut >= 500) { req.log.error(err); message = 'Erreur interne du serveur.'; }
        reply.code(statut).header('Cache-Control', 'no-store').send({ ok: false, message });
    });

    // ------------------------------------------------------------ Contrôles d'accès

    /** Utilisateur connecté et son rôle sur le wiki (calculé une fois par requête) */
    async function contexte(req) {
        if (!req.contexteWiki) {
            // Session locale d'abord (comptes intégrés, ou compte de secours en mode Kratos)
            let utilisateur = await comptes.utilisateurDeSession(req.cookies[COOKIE_SESSION]);
            let kratosIndisponible = false, secondeEtape = false;
            if (!utilisateur && kratos && sessionKratos(req)) {
                try {
                    const identite = await kratos.identifier(sessionKratos(req));
                    if (identite) utilisateur = await comptes.utilisateurKratos(identite, { adressesNonVerifiees: config.kratos.adressesNonVerifiees });
                } catch (err) {
                    if (err instanceof SecondeEtapeRequise) secondeEtape = true;
                    else if (err instanceof KratosIndisponible) { kratosIndisponible = true; req.log.error(err.message); }
                    else throw err;
                }
            }
            const role = utilisateur ? await comptes.role(req.wikiId, utilisateur.id) : null;
            req.contexteWiki = { utilisateur, role, kratosIndisponible, secondeEtape };
        }
        return req.contexteWiki;
    }

    // Protection CSRF : une requête qui modifie des données doit venir de la même origine
    function verifierOrigine(req) {
        const origine = req.headers.origin;
        if (!origine) return;
        let hote;
        try { hote = new URL(origine).host; } catch { throw new ErreurWiki(403, 'Origine invalide.'); }
        if (hote !== req.host) throw new ErreurWiki(403, 'Origine non autorisée.');
    }

    /** Exige une session et un rôle minimal (reader < editor < owner) ; pour une écriture, vérifie aussi l'origine */
    async function exigerRole(req, minimum) {
        const ctx = await contexte(req);
        if (!ctx.utilisateur && ctx.kratosIndisponible) throw new ErreurWiki(503, 'Le service de connexion est momentanément indisponible.');
        if (!ctx.utilisateur) throw new ErreurWiki(401, 'Connexion requise.');
        if (!roleSuffit(ctx.role, minimum)) throw new ErreurWiki(403, "Vous n'avez pas les droits nécessaires sur ce wiki.");
        if (req.method !== 'GET' && req.method !== 'HEAD') verifierOrigine(req);
        return ctx;
    }

    /** Lecture : libre si le wiki est public, sinon réservée aux membres */
    async function exigerLecture(req) {
        const w = await service.trouverWikiParId(req.wikiId);
        if (w.visibilite === 'prive') await exigerRole(req, 'reader');
    }

    function cookieSession(req, reply, valeur, maxAge) {
        reply.setCookie(COOKIE_SESSION, valeur, {
            path: '/', httpOnly: true, sameSite: 'lax', maxAge,
            secure: req.protocol === 'https',
        });
    }

    const corpsJson = req => {
        if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
            try { return JSON.parse(req.body.toString()); } catch { throw new ErreurWiki(400, 'JSON invalide.'); }
        }
        return req.body || {};
    };

    // ------------------------------------------------------------ Interface et fichiers statiques

    let indexHtml = fs.readFileSync(INDEX_FILE, 'utf8');
    const echapper = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // L'interface, avec le titre de la page dans l'onglet (utile aussi pour les moteurs de recherche et les partages)
    async function envoyerInterface(reply, titre, statut = 200) {
        if (process.env.NODE_ENV !== 'production') indexHtml = fs.readFileSync(INDEX_FILE, 'utf8'); // rechargement en dev
        const html = indexHtml.replace(/<title>[^<]*<\/title>/, `<title>${echapper(titre)}</title>`);
        return reply.code(statut).header('Content-Security-Policy', CSP).header('Cache-Control', 'no-cache')
            .type('text/html; charset=utf-8').send(html);
    }

    app.get('/', async (req, reply) => {
        const w = await service.trouverWikiParId(req.wikiId);
        return envoyerInterface(reply, w.nom);
    });

    app.get('/favicon.ico', async (req, reply) => reply.code(404).send());
    app.get('/robots.txt', async (req, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /\n'));

    // Adresse d'une page : /<slug>
    app.get('/:slug', async (req, reply) => {
        const w = await service.trouverWikiParId(req.wikiId);
        let page = null;
        try { page = await service.trouverPage(req.wikiId, req.params.slug); } catch { /* slug invalide */ }
        if (!page) {
            // Page renommée : redirection permanente vers son nouveau nom
            const nouveau = await service.suivreRedirection(req.wikiId, req.params.slug);
            if (nouveau) {
                const requete = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
                return reply.redirect(`/${encodeURIComponent(nouveau)}${requete}`, 301);
            }
        }
        return envoyerInterface(reply, page ? `${page.titre} — ${w.nom}` : `Page introuvable — ${w.nom}`, page ? 200 : 404);
    });

    // Fichiers de l'interface (noms avec empreinte : mis en cache un an)
    app.get('/assets/*', async (req, reply) => {
        const nom = req.params['*'];
        const ext = path.extname(nom).toLowerCase();
        const complet = path.resolve(ASSETS_DIR, nom);
        if (!TYPES_STATIQUES[ext] || !complet.startsWith(ASSETS_DIR + path.sep) || !fs.existsSync(complet)) {
            return reply.code(404).send();
        }
        reply.type(TYPES_STATIQUES[ext]).header('Cache-Control', 'public, max-age=31536000, immutable');
        return reply.send(fs.createReadStream(complet));
    });

    async function servirFichier(req, reply, prefixe) {
        await exigerLecture(req);
        const fichier = await service.trouverFichier(req.wikiId, `${prefixe}/${req.params['*']}`);
        if (!fichier) return reply.code(404).send();
        reply.type(fichier.mime).header('Content-Length', fichier.taille).header('Cache-Control', 'public, max-age=86400');
        // Un SVG peut contenir du script : on l'isole s'il est ouvert directement
        if (fichier.mime === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        return reply.send(fichier.flux());
    }
    app.get('/uploads/*', (req, reply) => servirFichier(req, reply, 'uploads'));
    app.get('/media/*', (req, reply) => servirFichier(req, reply, 'media'));

    // ------------------------------------------------------------ Session, connexion, installation

    app.get('/api/session', async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        // Juste après une connexion ou une vérification d'adresse : relire l'identité auprès de Kratos, sans le cache
        if (kratos && req.query.rafraichir) kratos.oublier(sessionKratos(req));
        const { utilisateur, role, kratosIndisponible, secondeEtape } = await contexte(req);
        const w = await service.trouverWikiParId(req.wikiId);
        return {
            connecte: !!utilisateur, utilisateur, role, installationRequise: !!jetonInstallation, visibilite: w.visibilite,
            auth: multi ? 'externe' : config.auth, ...(kratos ? { kratosIndisponible, secondeEtape, inscription: config.kratos.inscription } : {}),
            ...(multi ? { connexionExterne: multi.urlConnexion(req, w), compteExterne: multi.urlCompte || null } : {}),
        };
    });

    app.post('/api/login', async (req, reply) => {
        verifierOrigine(req);
        const { identifiant, motDePasse } = corpsJson(req);
        const cleCompte = String(identifiant || '').trim().toLowerCase();
        if (limiteurIp.bloque(req.ip) || limiteurCompte.bloque(cleCompte)) throw new ErreurWiki(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
        const utilisateur = await comptes.authentifier(cleCompte, motDePasse);
        if (!utilisateur) {
            limiteurIp.echec(req.ip);
            limiteurCompte.echec(cleCompte);
            req.log.warn({ ip: req.ip, identifiant: cleCompte.slice(0, 60) }, 'échec de connexion');
            throw new ErreurWiki(401, 'Identifiant ou mot de passe incorrect.');
        }
        limiteurIp.reinitialiser(req.ip);
        limiteurCompte.reinitialiser(cleCompte);
        const { jeton, dureeSecondes } = await comptes.ouvrirSession(utilisateur.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
        cookieSession(req, reply, jeton, dureeSecondes);
        return { ok: true, utilisateur, role: await comptes.role(req.wikiId, utilisateur.id) };
    });

    app.post('/api/logout', async (req, reply) => {
        verifierOrigine(req);
        await comptes.fermerSession(req.cookies[COOKIE_SESSION]);
        if (kratos) kratos.oublier(sessionKratos(req)); // la session Kratos est fermée par le navigateur via /kratos/
        cookieSession(req, reply, '', 0);
        return { ok: true };
    });

    // Retour de la connexion externe (multi) : le code à usage unique donne l'identité, le wiki ouvre sa propre session
    if (multi) {
        app.get('/auth/retour', async (req, reply) => {
            const w = await service.trouverWikiParId(req.wikiId);
            const suite = typeof req.query.suite === 'string' && /^\/(?![/\\])/.test(req.query.suite) ? req.query.suite : '/';
            const identite = req.query.code ? await multi.echangerCode(String(req.query.code), req, w) : null;
            if (!identite) return reply.redirect(suite, 302);
            const utilisateur = await comptes.utilisateurKratos(identite);
            if (!utilisateur) return reply.redirect(suite, 302);
            const { jeton, dureeSecondes } = await comptes.ouvrirSession(utilisateur.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
            cookieSession(req, reply, jeton, dureeSecondes);
            await comptes.noterConnexion(utilisateur.id);
            return reply.header('Cache-Control', 'no-store').redirect(suite, 302);
        });
    }

    // Création du compte propriétaire sur une installation neuve (jeton affiché dans les journaux du serveur)
    app.post('/api/installation', async (req, reply) => {
        verifierOrigine(req);
        if (!jetonInstallation) throw new ErreurWiki(409, 'Ce wiki est déjà installé.');
        if (limiteurIp.bloque(req.ip)) throw new ErreurWiki(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
        const { jeton, identifiant, email, nom, motDePasse } = corpsJson(req);
        // Mode Kratos : la personne s'est d'abord connectée avec son compte Kratos, le jeton la rend propriétaire
        const ctx = kratos ? await contexte(req) : null;
        if (kratos && !ctx.utilisateur) throw new ErreurWiki(401, "Connectez-vous d'abord avec votre compte, puis saisissez le jeton.");
        const a = Buffer.from(String(jeton || '')), b = Buffer.from(jetonInstallation);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            limiteurIp.echec(req.ip);
            throw new ErreurWiki(403, "Jeton d'installation incorrect (il est affiché dans les journaux du serveur).");
        }
        const utilisateur = kratos ? ctx.utilisateur : await comptes.creerUtilisateur({ identifiant, email, nom, motDePasse });
        await comptes.definirRole(req.wikiId, utilisateur.id, 'owner');
        jetonInstallation = null;
        if (!kratos) {
            const session = await comptes.ouvrirSession(utilisateur.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
            cookieSession(req, reply, session.jeton, session.dureeSecondes);
        }
        req.log.warn({ identifiant: utilisateur.identifiant }, 'installation terminée : compte propriétaire créé');
        return { ok: true, utilisateur, role: 'owner' };
    });

    app.post('/api/compte/mot-de-passe', async req => {
        const { utilisateur } = await contexte(req);
        if (!utilisateur) throw new ErreurWiki(401, 'Connexion requise.');
        verifierOrigine(req);
        const { actuel, nouveau } = corpsJson(req);
        if (!(await comptes.verifierMotDePasseUtilisateur(utilisateur.id, actuel))) throw new ErreurWiki(403, 'Mot de passe actuel incorrect.');
        // Les sessions ouvertes sur d'autres appareils sont fermées ; celle-ci reste ouverte
        await comptes.changerMotDePasse(utilisateur.id, nouveau, { sessionConservee: req.cookies[COOKIE_SESSION] });
        return { ok: true };
    });

    // ------------------------------------------------------------ Relais vers Kratos (WIZIKI_AUTH=kratos)

    // Les parcours de connexion passent par le wiki, pour que le cookie de session Kratos soit posé sur le domaine
    // du wiki sans toucher à la configuration de Kratos. Seuls les parcours « self-service » sont exposés.
    if (kratos) {
        const cookieRelaye = nom => nom === kratos.nomCookie || /^csrf_token(_[A-Za-z0-9_-]+)?$/.test(nom);
        await app.register(async portee => {
            portee.removeAllContentTypeParsers();
            portee.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (req, corps, done) => done(null, corps));
            portee.all('/kratos/*', async (req, reply) => {
                const chemin = '/' + req.params['*'];
                if (!chemin.startsWith('/self-service/') || chemin.includes('..') || chemin.includes('//')
                    || (!config.kratos.inscription && chemin.startsWith('/self-service/registration'))) {
                    return reply.code(404).send({ ok: false, message: 'Ressource introuvable.' });
                }
                if (chemin.startsWith('/self-service/logout')) kratos.oublier(sessionKratos(req));
                // Seuls les cookies de Kratos lui sont transmis (jamais la session du wiki)
                const cookies = cookiesBruts(req, cookieRelaye).join('; ');
                const entetes = { 'X-Forwarded-For': req.ip, 'X-Forwarded-Proto': req.protocol, 'X-Forwarded-Host': req.host };
                for (const nom of ['accept', 'content-type', 'user-agent', 'accept-language']) if (req.headers[nom]) entetes[nom] = req.headers[nom];
                if (cookies) entetes.cookie = cookies;
                const requete = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
                let r;
                try {
                    r = await kratos.relayer({ methode: req.method, chemin: chemin + requete, entetes, corps: req.body });
                } catch (err) {
                    if (!(err instanceof KratosIndisponible)) throw err;
                    req.log.error(err.message);
                    return reply.code(502).send({ ok: false, message: 'Le service de connexion est momentanément indisponible.' });
                }
                reply.code(r.statut).headers(r.entetes);
                if (r.cookies.length) reply.header('set-cookie', r.cookies);
                return reply.send(r.corps);
            });
        });
    }

    // ------------------------------------------------------------ Membres du wiki (propriétaires)

    app.get('/api/membres', async (req, reply) => {
        await exigerRole(req, 'owner');
        reply.header('Cache-Control', 'no-store');
        return comptes.listerMembres(req.wikiId);
    });

    // Ajoute un membre : compte existant (identifiant ou email) ou nouveau compte avec un mot de passe initial
    app.post('/api/membres', async req => {
        await exigerRole(req, 'owner');
        const { identifiant, email, nom, motDePasse, role } = corpsJson(req);
        if (multi && motDePasse) throw new ErreurWiki(400, "Les membres se connectent avec leur compte : indiquez seulement leur adresse email.");
        let u = await comptes.trouverParIdentifiant(identifiant || email);
        if (!u && (kratos || multi) && !motDePasse) {
            // Mode Kratos : invitation par email ; le compte sera relié à la première connexion avec cette adresse (vérifiée)
            const adresse = String(email || identifiant || '').trim().toLowerCase();
            if (!adresse.includes('@')) throw new ErreurWiki(400, "Indiquez l'adresse email du membre : il se connectera avec le compte correspondant.");
            const ident = identifiant && !String(identifiant).includes('@') ? identifiant : null;
            u = await comptes.creerUtilisateur({ identifiant: ident, email: adresse, nom, externe: true });
        }
        if (!u) u = await comptes.creerUtilisateur({ identifiant, email, nom, motDePasse });
        await comptes.definirRole(req.wikiId, u.id, role || 'editor');
        return { ok: true, id: u.id };
    });

    app.patch('/api/membres/:id', async req => {
        await exigerRole(req, 'owner');
        const { role } = corpsJson(req);
        await comptes.definirRole(req.wikiId, Number(req.params.id), role);
        return { ok: true };
    });

    app.delete('/api/membres/:id', async req => {
        await exigerRole(req, 'owner');
        await comptes.retirerMembre(req.wikiId, Number(req.params.id));
        return { ok: true };
    });

    // Visibilité du wiki : public (lecture libre) ou privé (membres uniquement)
    app.put('/api/wiki/visibilite', async req => {
        await exigerRole(req, 'owner');
        const { visibilite } = corpsJson(req);
        if (!['public', 'prive'].includes(visibilite)) throw new ErreurWiki(400, 'Visibilité invalide.');
        await db.updateTable('wikis').set({ visibilite, updated_at: new Date().toISOString() }).where('id', '=', req.wikiId).execute();
        return { ok: true };
    });

    // ------------------------------------------------------------ Structure (arbre + paramètres)

    app.get('/api/structure', async (req, reply) => {
        await exigerLecture(req);
        reply.header('Cache-Control', 'no-store');
        const { role } = await contexte(req);
        return service.lireStructure(req.wikiId, { avecOrphelins: roleSuffit(role, 'editor') });
    });

    app.post('/api/structure', async req => {
        const { utilisateur } = await exigerRole(req, 'editor');
        const { parametres, arbre } = corpsJson(req);
        await service.enregistrerStructure(req.wikiId, { parametres, arbre }, utilisateur.id);
        return { status: 'ok' };
    });

    // ------------------------------------------------------------ Pages

    app.get('/api/page/:slug', async (req, reply) => {
        await exigerLecture(req);
        const page = await service.trouverPage(req.wikiId, req.params.slug);
        reply.type('text/plain; charset=utf-8').header('Cache-Control', 'no-cache');
        if (!page) return reply.code(404).send('');
        return page.contenu;
    });

    app.post('/api/page/:slug', { bodyLimit: TAILLE_MAX_PAGE }, async req => {
        const { utilisateur } = await exigerRole(req, 'editor');
        const contenu = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : '');
        await service.enregistrerPage(req.wikiId, req.params.slug, contenu, utilisateur.id);
        return { status: 'ok' };
    });

    app.delete('/api/page/:slug', async req => {
        const { utilisateur } = await exigerRole(req, 'editor');
        await service.supprimerPage(req.wikiId, req.params.slug, utilisateur.id);
        return { status: 'ok' };
    });

    app.get('/api/page/:slug/revisions', async req => {
        await exigerRole(req, 'editor');
        return service.listerRevisions(req.wikiId, req.params.slug);
    });

    app.get('/api/revisions/:id', async (req, reply) => {
        await exigerRole(req, 'editor');
        reply.header('Cache-Control', 'no-store');
        return service.lireRevision(req.wikiId, Number(req.params.id));
    });

    app.post('/api/page/:slug/restaurer', async req => {
        const { utilisateur } = await exigerRole(req, 'editor');
        const { revisionId } = corpsJson(req);
        await service.restaurerRevision(req.wikiId, req.params.slug, Number(revisionId), utilisateur.id);
        return { ok: true };
    });

    app.get('/api/corbeille', async (req, reply) => {
        await exigerRole(req, 'editor');
        reply.header('Cache-Control', 'no-store');
        return service.listerCorbeille(req.wikiId);
    });

    app.post('/api/corbeille/:id/restaurer', async req => {
        const { utilisateur } = await exigerRole(req, 'editor');
        return { ok: true, ...(await service.restaurerPage(req.wikiId, Number(req.params.id), utilisateur.id)) };
    });

    app.post('/api/renommer/:slug', async req => {
        await exigerRole(req, 'editor');
        const { nouvelId } = corpsJson(req);
        await service.renommerPage(req.wikiId, req.params.slug, nouvelId);
        return { ok: true };
    });

    // ------------------------------------------------------------ Images

    app.post('/api/upload', { bodyLimit: TAILLE_MAX_IMAGE }, async req => {
        const { utilisateur } = await exigerRole(req, 'editor');
        const octets = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        return service.ajouterImage(req.wikiId, octets, utilisateur.id);
    });

    app.get('/api/images', async req => {
        await exigerRole(req, 'editor');
        return service.listerImagesEnvoyees(req.wikiId);
    });

    // ------------------------------------------------------------ Export / import (format ouvert, docs/format-export.md)

    app.get('/api/export', async (req, reply) => {
        await exigerRole(req, 'owner');
        const historique = req.query.historique !== '0';
        const zip = creerZip(await archives.exporterWiki(req.wikiId, { historique }));
        const jour = new Date().toISOString().slice(0, 10);
        const { slug } = await service.trouverWikiParId(req.wikiId);
        const nom = `${slug.replace(/[^A-Za-z0-9_-]/g, '_')}-${jour}.wiziki.zip`;
        reply.header('Content-Type', 'application/zip')
            .header('Content-Disposition', `attachment; filename="${nom}"`)
            .header('Cache-Control', 'no-store');
        return reply.send(zip);
    });

    app.post('/api/import', { bodyLimit: LIMITE_IMPORT }, async req => {
        const { utilisateur } = await exigerRole(req, 'owner');
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErreurWiki(400, 'Envoyez le fichier .zip de l\'export.');
        const resultat = await archives.importerWiki(req.wikiId, lireZip(req.body), { remplacer: req.query.remplacer === '1', auteurId: utilisateur.id });
        req.log.warn({ utilisateur: utilisateur.identifiant, pages: resultat.pages, images: resultat.images }, 'wiki importé depuis une archive');
        return { ok: true, ...resultat };
    });

    // Accès au jeton d'installation pour les tests automatiques uniquement
    if (process.env.NODE_ENV === 'test') app.decorate('jetonInstallationPourTests', () => jetonInstallation);

    return app;
}
