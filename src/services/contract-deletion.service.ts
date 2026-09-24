import { prisma } from '../prisma';
import { AppError } from '../errors/app-error';
import { removeUploadedFile } from '../middlewares/upload.middleware';
import { getContractFinancialHistory, hasContractFinancialHistory } from './contract-financial-integrity.service';

export async function deleteContractPermanently(contractId: number, inmobiliariaId: number) {
  const filePaths = await prisma.$transaction(async tx => {
    const contract = await tx.contrato.findFirst({
      where: { id: contractId, inmobiliariaId },
      include: {
        adjuntos: { select: { rutaArchivo: true } },
        contratoRenovado: { select: { id: true } }
      }
    });

    if (!contract) {
      throw new AppError('Contrato no encontrado', { statusCode: 404, code: 'CONTRACT_NOT_FOUND' });
    }

    if (contract.estado !== 'PAPELERA') {
      throw new AppError('El contrato debe estar en la papelera antes de eliminarlo definitivamente', {
        statusCode: 409,
        code: 'CONTRACT_NOT_IN_TRASH'
      });
    }

    const dependencies = await getContractFinancialHistory(tx, contractId);

    if (hasContractFinancialHistory(dependencies)) {
      throw new AppError('El contrato posee registros financieros y debe conservarse por trazabilidad', {
        statusCode: 409,
        code: 'CONTRACT_HAS_FINANCIAL_HISTORY',
        details: dependencies
      });
    }

    if (contract.contratoAnteriorId || contract.contratoRenovado) {
      throw new AppError('El contrato forma parte de una cadena de renovación y debe conservarse por trazabilidad comercial', {
        statusCode: 409,
        code: 'CONTRACT_HAS_RENEWAL_HISTORY',
        details: {
          contratoAnteriorId: contract.contratoAnteriorId,
          contratoRenovadoId: contract.contratoRenovado?.id || null
        }
      });
    }

    await tx.contrato.delete({ where: { id: contractId } });
    return [...new Set([contract.rutaArchivoContrato, ...contract.adjuntos.map(item => item.rutaArchivo)].filter(Boolean))] as string[];
  });

  await Promise.all(filePaths.map(removeUploadedFile));
  return { deletedFiles: filePaths.length };
}
