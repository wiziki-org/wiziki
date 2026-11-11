// Comptes, sessions et rôles. Ne connaît pas HTTP : le serveur gère les cookies.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ErreurWiki } from './validation.js';

const scrypt = promisify(crypto.scrypt);

export const ROLES = ['reader', 'editor', 'owner'];
const RANG = { reader: 1, editor: 2, owner: 3 };
export const roleSuffit = (role, minimum) => (RANG[role] || 0) >= RANG[minimum];

export const REGEX_IDENTIFIANT = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const REGEX_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const LONGUEUR_MIN_MOT_DE_PASSE = 10;
const DUREE_SESSION_MS = 30 * 24 * 3600 * 1000;

// scrypt : N=2^15, r=8, p=1 (≈ 32 Mo, ~50 ms) — paramètres stockés avec l'empreinte pour pouvoir évoluer
const PARAMS_SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hacherMotDePasse(motDePasse) {
    const sel = crypto.randomBytes(16);
    const cle = await scrypt(motDePasse.normalize('NFC'), sel, 32, PARAMS_SCRYPT);
    return `scrypt$${PARAMS_SCRYPT.N}$${PARAMS_SCRYPT.r}$${PARAMS_SCRYPT.p}$${sel.toString('base64')}$${cle.toString('base64')}`;
}

export async function verifierMotDePasse(motDePasse, empreinte) {
    const [algo, N, r, p, sel, cle] = String(empreinte).split('$');
    if (algo !== 'scrypt' || typeof motDePasse !== 'string') return false;
    const attendu = Buffer.from(cle, 'base64');
    const calcule = await scrypt(motDePasse.normalize('NFC'), Buffer.from(sel, 'base64'), attendu.length,
        { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
    return calcule.length === attendu.length && crypto.timingSafeEqual(calcule, attendu);
}

// Empreinte utilisée quand l'identifiant n'existe pas : la vérification prend le même temps (pas d'énumération des comptes)
let empreinteLeurre = null;

const empreinteJeton = jeton => crypto.createHash('sha256').update(jeton).digest('hex');
const maintenant = () => new Date().toISOString();

export function verifierNouveauMotDePasse(motDePasse) {
    if (typeof motDePasse !== 'string' || motDePasse.length < LONGUEUR_MIN_MOT_DE_PASSE) {
        throw new ErreurWiki(400, `Le mot de passe doit contenir au moins ${LONGUEUR_MIN_MOT_DE_PASSE} caractères.`);
    }
    if (motDePasse.length > 200) throw new ErreurWiki(400, 'Mot de passe trop long.');
}

export function creerServiceComptes({ db }) {

    const publicUtilisateur = u => u && { id: u.id, identifiant: u.identifiant, nom: u.nom, email: u.email };

    async function compterUtilisateurs() {
        const r = await db.selectFrom('users').select(db.fn.countAll().as('n')).executeTakeFirst();
        return Number(r.n);
    }

    async function trouverParIdentifiant(identifiant) {
        const id = String(identifiant || '').trim().toLowerCase();
        return db.selectFrom('users').selectAll()
            .where(eb => eb.or([eb('identifiant', '=', id), eb('email', '=', id)]))
            .executeTakeFirst();
    }

    // `forcer` : accepte un mot de passe plus court que le minimum (reprise de ADMIN_PASSWORD d'une installation existante)
    async function creerUtilisateur({ identifiant, email = null, nom = null, motDePasse, forcer = false }) {
        identifiant = String(identifiant || '').trim().toLowerCase();
        if (!REGEX_IDENTIFIANT.test(identifiant)) {
            throw new ErreurWiki(400, 'Identifiant invalide : 2 à 40 caractères, lettres minuscules, chiffres, « . », « _ » ou « - ».');
        }
        email = email ? String(email).trim().toLowerCase() : null;
        if (email && !REGEX_EMAIL.test(email)) throw new ErreurWiki(400, 'Adresse email invalide.');
        if (forcer) { if (typeof motDePasse !== 'string' || !motDePasse) throw new ErreurWiki(400, 'Mot de passe requis.'); }
        else verifierNouveauMotDePasse(motDePasse);
        if (await trouverParIdentifiant(identifiant)) throw new ErreurWiki(409, 'Cet identifiant est déjà utilisé.');
        if (email && await trouverParIdentifiant(email)) throw new ErreurWiki(409, 'Cette adresse email est déjà utilisée.');
        const res = await db.insertInto('users').values({
            identifiant, email, nom: (nom && String(nom).trim().slice(0, 100)) || identifiant,
            password_hash: await hacherMotDePasse(motDePasse), email_verifie: 0, desactive: 0, created_at: maintenant(),
        }).executeTakeFirstOrThrow();
        return publicUtilisateur(await db.selectFrom('users').selectAll().where('id', '=', Number(res.insertId)).executeTakeFirst());
    }

    async function changerMotDePasse(userId, nouveau, { fermerSessions = true, sessionConservee = null } = {}) {
        verifierNouveauMotDePasse(nouveau);
        await db.updateTable('users').set({ password_hash: await hacherMotDePasse(nouveau) }).where('id', '=', userId).execute();
        if (fermerSessions) {
            let q = db.deleteFrom('sessions').where('user_id', '=', userId);
            if (sessionConservee) q = q.where('id', '!=', empreinteJeton(sessionConservee));
            await q.execute();
        }
    }

    /** Vérifie identifiant + mot de passe. Renvoie l'utilisateur ou null. */
    async function authentifier(identifiant, motDePasse) {
        const u = await trouverParIdentifiant(identifiant);
        if (!u || u.desactive) {
            empreinteLeurre ??= await hacherMotDePasse(crypto.randomBytes(16).toString('hex'));
            await verifierMotDePasse(String(motDePasse || ''), empreinteLeurre);
            return null;
        }
        if (!(await verifierMotDePasse(motDePasse, u.password_hash))) return null;
        await db.updateTable('users').set({ last_login_at: maintenant() }).where('id', '=', u.id).execute();
        return publicUtilisateur(u);
    }

    // ------------------------------------------------------------ Sessions

    async function ouvrirSession(userId, { ip = null, userAgent = null } = {}) {
        const jeton = crypto.randomBytes(32).toString('base64url');
        const date = new Date();
        await db.insertInto('sessions').values({
            id: empreinteJeton(jeton), user_id: userId, created_at: date.toISOString(),
            expires_at: new Date(date.getTime() + DUREE_SESSION_MS).toISOString(),
            ip, user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
        }).execute();
        return { jeton, dureeSecondes: DUREE_SESSION_MS / 1000 };
    }

    /** Utilisateur correspondant au jeton de session, ou null */
    async function utilisateurDeSession(jeton) {
        if (typeof jeton !== 'string' || jeton.length < 20 || jeton.length > 100) return null;
        const ligne = await db.selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .select(['users.id', 'users.identifiant', 'users.nom', 'users.email', 'users.desactive', 'sessions.expires_at'])
            .where('sessions.id', '=', empreinteJeton(jeton))
            .executeTakeFirst();
        if (!ligne || ligne.desactive) return null;
        if (ligne.expires_at < maintenant()) { await fermerSession(jeton); return null; }
        return publicUtilisateur(ligne);
    }

    async function fermerSession(jeton) {
        if (typeof jeton === 'string') await db.deleteFrom('sessions').where('id', '=', empreinteJeton(jeton)).execute();
    }

    async function purgerSessionsExpirees() {
        await db.deleteFrom('sessions').where('expires_at', '<', maintenant()).execute();
    }

    // ------------------------------------------------------------ Rôles et membres

    async function role(wikiId, userId) {
        if (!userId) return null;
        const m = await db.selectFrom('members').select('role').where('wiki_id', '=', wikiId).where('user_id', '=', userId).executeTakeFirst();
        return m ? m.role : null;
    }

    async function listerMembres(wikiId) {
        return db.selectFrom('members').innerJoin('users', 'users.id', 'members.user_id')
            .select(['users.id', 'users.identifiant', 'users.nom', 'users.email', 'users.last_login_at', 'members.role', 'members.created_at'])
            .where('members.wiki_id', '=', wikiId).orderBy('members.created_at').execute();
    }

    async function nombreOwners(wikiId) {
        const r = await db.selectFrom('members').select(db.fn.countAll().as('n')).where('wiki_id', '=', wikiId).where('role', '=', 'owner').executeTakeFirst();
        return Number(r.n);
    }

    async function definirRole(wikiId, userId, nouveauRole) {
        if (!ROLES.includes(nouveauRole)) throw new ErreurWiki(400, 'Rôle invalide.');
        const actuel = await role(wikiId, userId);
        if (actuel === 'owner' && nouveauRole !== 'owner' && await nombreOwners(wikiId) <= 1) {
            throw new ErreurWiki(409, 'Le wiki doit garder au moins un propriétaire.');
        }
        if (actuel) {
            await db.updateTable('members').set({ role: nouveauRole }).where('wiki_id', '=', wikiId).where('user_id', '=', userId).execute();
        } else {
            await db.insertInto('members').values({ wiki_id: wikiId, user_id: userId, role: nouveauRole, created_at: maintenant() }).execute();
        }
    }

    async function retirerMembre(wikiId, userId) {
        if (await role(wikiId, userId) === 'owner' && await nombreOwners(wikiId) <= 1) {
            throw new ErreurWiki(409, 'Le wiki doit garder au moins un propriétaire.');
        }
        await db.deleteFrom('members').where('wiki_id', '=', wikiId).where('user_id', '=', userId).execute();
    }

    return {
        compterUtilisateurs, trouverParIdentifiant, creerUtilisateur, changerMotDePasse, authentifier,
        ouvrirSession, utilisateurDeSession, fermerSession, purgerSessionsExpirees,
        role, listerMembres, definirRole, retirerMembre,
        verifierMotDePasseUtilisateur: async (userId, motDePasse) => {
            const u = await db.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirst();
            return !!u && verifierMotDePasse(motDePasse, u.password_hash);
        },
    };
}
