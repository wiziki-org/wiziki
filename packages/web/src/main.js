// Point d'entrée de l'interface (construit par Vite).
import './styles.css';
import { actions, initialiser } from './app.js';

// Un seul écouteur par type d'événement : le HTML ne contient aucun code (CSP sans 'unsafe-inline').
function appeler(nom, ...args) {
    const action = actions[nom];
    if (!action) { console.error(`Action inconnue : ${nom}`); return; }
    action(...args);
}

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    let args = [];
    if (el.dataset.args) {
        try { args = JSON.parse(el.dataset.args); } catch { console.error('data-args invalide', el); return; }
    }
    appeler(el.dataset.action, ...args);
});

document.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-entree]');
    if (el && e.key === 'Enter') { e.preventDefault(); appeler(el.dataset.entree); }
});

document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-on-input]');
    if (el) appeler(el.dataset.onInput, el.value);
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-on-change]');
    if (el) appeler(el.dataset.onChange, el.checked ?? el.value);
});

initialiser();
