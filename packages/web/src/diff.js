// Comparaison ligne à ligne (plus longue sous-séquence commune), pour l'historique des pages.

const LIMITE_CELLULES = 6_000_000; // au-delà, comparaison simplifiée (pages énormes)

/** @returns {Array<{ type: '=' | '+' | '-', texte: string }>} */
export function diffLignes(avant, apres) {
    const a = avant.split('\n'), b = apres.split('\n');
    // Début et fin communs : retirés avant le calcul (cas courant : peu de lignes changent)
    let debut = 0;
    while (debut < a.length && debut < b.length && a[debut] === b[debut]) debut++;
    let finA = a.length, finB = b.length;
    while (finA > debut && finB > debut && a[finA - 1] === b[finB - 1]) { finA--; finB--; }
    const ma = a.slice(debut, finA), mb = b.slice(debut, finB);

    const milieu = [];
    if (ma.length * mb.length > LIMITE_CELLULES) {
        ma.forEach(t => milieu.push({ type: '-', texte: t }));
        mb.forEach(t => milieu.push({ type: '+', texte: t }));
    } else {
        const L = Array.from({ length: ma.length + 1 }, () => new Uint32Array(mb.length + 1));
        for (let i = ma.length - 1; i >= 0; i--) {
            for (let j = mb.length - 1; j >= 0; j--) {
                L[i][j] = ma[i] === mb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < ma.length && j < mb.length) {
            if (ma[i] === mb[j]) { milieu.push({ type: '=', texte: ma[i] }); i++; j++; }
            else if (L[i + 1][j] >= L[i][j + 1]) milieu.push({ type: '-', texte: ma[i++] });
            else milieu.push({ type: '+', texte: mb[j++] });
        }
        while (i < ma.length) milieu.push({ type: '-', texte: ma[i++] });
        while (j < mb.length) milieu.push({ type: '+', texte: mb[j++] });
    }
    return [
        ...a.slice(0, debut).map(t => ({ type: '=', texte: t })),
        ...milieu,
        ...a.slice(finA).map(t => ({ type: '=', texte: t })),
    ];
}

/** Ne garde que les zones modifiées, avec `contexte` lignes inchangées autour ; null = lignes masquées */
export function zonesModifiees(lignes, contexte = 2) {
    const garder = new Array(lignes.length).fill(false);
    lignes.forEach((l, i) => {
        if (l.type === '=') return;
        for (let k = Math.max(0, i - contexte); k <= Math.min(lignes.length - 1, i + contexte); k++) garder[k] = true;
    });
    const resultat = [];
    let masquees = 0;
    lignes.forEach((l, i) => {
        if (garder[i]) {
            if (masquees) { resultat.push({ type: '…', texte: `${masquees} ligne${masquees > 1 ? 's' : ''} inchangée${masquees > 1 ? 's' : ''}` }); masquees = 0; }
            resultat.push(l);
        } else masquees++;
    });
    if (masquees && resultat.length) resultat.push({ type: '…', texte: `${masquees} ligne${masquees > 1 ? 's' : ''} inchangée${masquees > 1 ? 's' : ''}` });
    return resultat;
}
