/** Argentine CBU: 7 digits + verifier, followed by 13 digits + verifier. */
const CBU_BANK_WEIGHTS = [7, 1, 3, 9, 7, 1, 3];
const CBU_ACCOUNT_WEIGHTS = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

export const normalizeCbu = (value: string) => value.normalize('NFKC').replace(/[^0-9]/g, '');

export const normalizeBankAlias = (value: string) => value.normalize('NFKC').trim().toUpperCase();

const validVerifier = (digits: string, weights: number[], verifier: string) => {
    const sum = digits.split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
    return String((10 - (sum % 10)) % 10) === verifier;
};

export const isValidCbu = (value: string) => {
    const cbu = normalizeCbu(value);
    return cbu.length === 22
        && validVerifier(cbu.slice(0, 7), CBU_BANK_WEIGHTS, cbu[7])
        && validVerifier(cbu.slice(8, 21), CBU_ACCOUNT_WEIGHTS, cbu[21]);
};

export const isValidCuit = (value: string) => {
    const cuit = value.normalize('NFKC').replace(/[^0-9]/g, '');
    if (cuit.length !== 11) return false;
    const weighted = cuit.slice(0, 10).split('').reduce((total, digit, index) => total + Number(digit) * CUIT_WEIGHTS[index], 0);
    const remainder = weighted % 11;
    const verifier = remainder === 0 ? 0 : remainder === 1 ? 9 : 11 - remainder;
    return Number(cuit[10]) === verifier;
};

export const isValidBankAlias = (value: string) => {
    const alias = normalizeBankAlias(value);
    // BCRA aliases are 6–20 characters and may use letters, numbers, dots,
    // hyphens and underscores. Separators cannot be consecutive or terminal.
    return alias.length >= 6
        && alias.length <= 20
        && /^[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/.test(alias);
};

export const maskedBankDestination = (cbu?: string | null, alias?: string | null) => {
    if (cbu) return `CBU terminado en ${normalizeCbu(cbu).slice(-4)}`;
    if (alias) return `Alias ${normalizeBankAlias(alias)}`;
    return 'sin destino bancario informado';
};
