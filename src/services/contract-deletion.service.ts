import { prisma } from '../prisma';
import { AppError } from '../errors/app-error';
import { removeUploadedFile } from '../middlewares/upload.middleware';

export async function deleteContractPermanently(contractId: number, inmobiliariaId: number) {
  const filePaths = await prisma.$transaction(async tx => {
    const contract = await tx.contrato.findFirst({
      where: { id: contractId, inmobiliariaId },
      include: { adjuntos: { select: { rutaArchivo: true } } }
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

    const [liquidaciones, pagos, movimientosCaja, planesCuotas] = await Promise.all([
      tx.liquidacion.count({ where: { contratoId: contractId } }),
      tx.pago.count({ where: { contratoId: contractId } }),
      tx.movimientoCaja.count({ where: { contratoId: contractId } }),
      tx.planCuotas.count({ where: { contratoId: contractId } })
    ]);
    const dependencies = { liquidaciones, pagos, movimientosCaja, planesCuotas };

    if (Object.values(dependencies).some(count => count > 0)) {
      throw new AppError('El contrato posee registros financieros y debe conservarse por trazabilidad', {
        statusCode: 409,
        code: 'CONTRACT_HAS_FINANCIAL_HISTORY',
        details: dependencies
      });
    }

    await tx.contrato.delete({ where: { id: contractId } });
    return [contract.rutaArchivoContrato, ...contract.adjuntos.map(item => item.rutaArchivo)].filter(Boolean) as string[];
  });

  await Promise.all(filePaths.map(removeUploadedFile));
  return { deletedFiles: filePaths.length };
}
