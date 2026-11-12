// Catalogues de traduction de l'interface : complets, cohérents et utilisés. Lancer avec : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fr from '../src/i18n/fr.js';
import en from '../src/i18n/en.js';

const racine = path.resolve(import.meta.dirname, '..');
const sources = fs.readdirSync(path.join(racine, 'src')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(racine, 'src', f), 'utf8')).join('\n');
const html = fs.readFileSync(path.join(racine, 'index.html'), 'utf8');
const serveur = ['core/src', 'server/src'].flatMap(d => fs.readdirSync(path.resolve(racine, '..', d)).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.resolve(racine, '..', d, f), 'utf8'))).join('\n');

const clesCode = new Set([...sources.matchAll(/\bt\(\s*'([a-z_0-9]+\.[a-z_.0-9]+)'/g)].map(m => m[1]));
// Clés passées indirectement à t() (ex. t(n > 1 ? 'js.a' : 'js.b'))
for (const m of sources.matchAll(/'((?:js|ui|kratos)\.[a-z_0-9.]+)'/g)) clesCode.add(m[1]);
// Clés construites dynamiquement : t(`js.role_${role}`), t(`kratos.groupe_${g}`)
for (const r of ['owner', 'editor', 'reader']) clesCode.add(`js.role_${r}`);
for (const g of ['profile', 'password', 'totp', 'lookup_secret']) clesCode.add(`kratos.groupe_${g}`);
const clesHtml = new Set([...html.matchAll(/data-i18n(?:-html|-placeholder|-title|-data-placeholder)?="([^"]+)"/g)].map(m => m[1]));
const codesServeur = new Set([...serveur.matchAll(/new ErreurWiki\([^;]*?,\s*'([a-z_]+)'(?:,\s*\{[^}]*\})?\);/g)].map(m => m[1]));
codesServeur.add('trop_volumineux').add('erreur_interne').add('json_invalide');

test('mêmes clés en français et en anglais (hors erreurs du serveur)', () => {
    const enSansErreurs = Object.keys(en).filter(k => !k.startsWith('erreur.')).sort();
    assert.deepEqual(enSansErreurs, Object.keys(fr).sort());
});

test('toute clé utilisée existe, toute clé existante est utilisée', () => {
    const utilisees = new Set([...clesCode, ...clesHtml]);
    assert.deepEqual([...utilisees].filter(k => !(k in fr)), [], 'clés manquantes dans fr.js');
    assert.deepEqual(Object.keys(fr).filter(k => !utilisees.has(k)), [], 'clés inutilisées dans fr.js');
});

test('chaque code d\'erreur du serveur est traduit en anglais', () => {
    assert.ok(codesServeur.size > 40, `codes trouvés : ${codesServeur.size}`);
    assert.deepEqual([...codesServeur].filter(c => !(`erreur.${c}` in en)), []);
    assert.deepEqual(Object.keys(en).filter(k => k.startsWith('erreur.') && !codesServeur.has(k.slice(7))), [], 'traductions d\'erreurs inutilisées');
});

test('mêmes variables {x} dans les deux langues', () => {
    const variables = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
    for (const k of Object.keys(fr)) assert.equal(variables(en[k]), variables(fr[k]), k);
});
