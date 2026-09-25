import { Decimal } from '@prisma/client/runtime/library';

type AdjustmentType = 'CREDITO' | 'DEBITO';
type AdjustmentAmount = Decimal | number | string;

/**
 * Convierte importes documentados (siempre positivos) en impactos contables.
 * El signo no es un dato que pueda decidir el cliente: lo determina el tipo
 * de nota para que el PDF, los saldos y el asiento de corrección coincidan.
 */
export const calculateLiquidationAdjustment = ({
    tipo,
    montoInquilino,
    montoPropietario
}: {
    tipo: AdjustmentType;
    montoInquilino: AdjustmentAmount;
    montoPropietario: AdjustmentAmount;
}) => {
    const tenantAmount = new Decimal(montoInquilino.toString());
    const ownerAmount = new Decimal(montoPropietario.toString());

    if (tenantAmount.lessThan(0) || ownerAmount.lessThan(0) || (tenantAmount.isZero() && ownerAmount.isZero())) {
        throw new Error('El ajuste debe documentar un importe positivo para el inquilino o el propietario');
    }

    const direction = tipo === 'CREDITO' ? new Decimal(-1) : new Decimal(1);
    return {
        montoInquilino: tenantAmount,
        montoPropietario: ownerAmount,
        impactoInquilino: tenantAmount.mul(direction),
        impactoPropietario: ownerAmount.mul(direction),
        // Sólo para la columna histórica. Todo cálculo nuevo usa los dos
        // importes específicos que quedan documentados arriba.
        montoHistorico: Decimal.max(tenantAmount, ownerAmount)
    };
};
