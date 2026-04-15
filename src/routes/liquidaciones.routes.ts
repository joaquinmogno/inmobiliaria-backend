import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { EstadoLiquidacion } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { auditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);

// Helper para generar concepto descriptivo de movimientos de caja
function generarConcepto(tipo: string, liquidacion: any): string {
    const dir = liquidacion.contrato?.propiedad?.direccion || 'Sin dirección';
    const periodo = new Date(liquidacion.periodo)
        .toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `${tipo} - ${dir} - Liq. ${periodo}`;
}

// Helper para recalcular totales de una liquidación
async function recalcularTotales(liquidacionId: number) {
    const movimientos = await prisma.movimiento.findMany({
        where: { liquidacionId }
    });

    let totalIngresos = new Decimal(0);
    let totalDescuentos = new Decimal(0);
    let totalDescuentosInquilino = new Decimal(0);

    movimientos.forEach(m => {
        const monto = new Decimal(m.monto.toString());
        if (m.tipo === 'INGRESO') {
            totalIngresos = totalIngresos.plus(monto);
        } else {
            totalDescuentos = totalDescuentos.plus(monto);
            // Si NO es para la inmobiliaria, es un descuento real para el inquilino (ej: un arreglo)
            if (!m.esParaInmobiliaria) {
                totalDescuentosInquilino = totalDescuentosInquilino.plus(monto);
            }
        }
    });

    const netoACobrar = totalIngresos.minus(totalDescuentosInquilino);

    return (await prisma.liquidacion.update({
        where: { id: liquidacionId },
        data: {
            totalIngresos,
            totalDescuentos,
            netoACobrar
        },
        include: {
            movimientos: true,
            contrato: {
                include: {
                    propiedad: true,
                    inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                    propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                }
            }
        }
    })) as any;
}

// Obtener todas las liquidaciones de la inmobiliaria
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, page, limit, search } = req.query;

    const pageNum = page ? parseInt(String(page)) : 1;
    const limitNum = limit ? parseInt(String(limit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    try {
        const whereClause: any = {
            inmobiliariaId,
            ...(contratoId ? { contratoId: Number(contratoId) } : {})
        };

        if (search) {
            whereClause.contrato = {
                OR: [
                    { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } },
                    { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                    { propietarios: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } }
                ]
            };
        }

        const total = await prisma.liquidacion.count({ where: whereClause });

        const liquidaciones = await prisma.liquidacion.findMany({
            where: whereClause,
            include: {
                contrato: {
                    include: {
                        propiedad: true,
                        inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                        propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                    }
                },
                pagos: true
            },
            orderBy: { periodo: 'desc' },
            skip,
            take: limitNum
        });

        res.json({
            data: liquidaciones,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching liquidaciones:', error);
        res.status(500).json({ message: 'Error al obtener liquidaciones' });
    }
});

// Obtener detalle de una liquidación
router.get('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: {
                    include: {
                        propiedad: true,
                        inquilinos: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
                        propietarios: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } }
                    }
                },
                pagos: true
            }
        }) as any;

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        res.json(liquidacion);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener detalle de liquidación' });
    }
});

// Crear una nueva liquidación (Borrador)
router.post('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, periodo, montoHonorarios, porcentajeHonorarios, cuotasIds } = req.body; // periodo: "YYYY-MM-01"

    try {
        // Verificar que el contrato existe
        const contrato = await prisma.contrato.findFirst({
            where: { id: Number(contratoId), inmobiliariaId }
        });

        if (!contrato) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        // Verificar si ya existe una liquidación para ese periodo
        const existente = await prisma.liquidacion.findFirst({
            where: { contratoId: Number(contratoId), periodo: new Date(periodo) }
        });

        if (existente) {
            return res.status(400).json({ message: 'Ya existe una liquidación para este periodo' });
        }

        const liquidacion = await prisma.liquidacion.create({
            data: {
                periodo: new Date(periodo),
                estado: 'BORRADOR',
                contratoId: Number(contratoId),
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id,
                montoHonorarios: montoHonorarios ? Number(montoHonorarios) : 0,
                porcentajeHonorarios: porcentajeHonorarios ? Number(porcentajeHonorarios) : null
            }
        });

        await prisma.movimiento.create({
            data: {
                tipo: 'INGRESO',
                concepto: 'Alquiler Mensual',
                monto: contrato.montoAlquiler,
                liquidacionId: liquidacion.id
            }
        });

        // Crear movimientos para cuotas seleccionadas
        if (cuotasIds && Array.isArray(cuotasIds) && cuotasIds.length > 0) {
            for (const cId of cuotasIds) {
                const cuota = await prisma.cuotaPlan.findUnique({
                    where: { id: Number(cId) },
                    include: { plan: true }
                });

                if (cuota && cuota.estado === 'PENDIENTE') {
                    const mov = await prisma.movimiento.create({
                        data: {
                            tipo: cuota.plan.tipoMovimiento,
                            concepto: `${cuota.plan.concepto} (Cuota ${cuota.numeroCuota})`,
                            monto: cuota.monto,
                            liquidacionId: liquidacion.id,
                            esParaInmobiliaria: cuota.plan.esParaInmobiliaria
                        }
                    });

                    await prisma.cuotaPlan.update({
                        where: { id: cuota.id },
                        data: {
                            liquidacionId: liquidacion.id,
                            movimientoId: mov.id
                        }
                    });
                }
            }
        }

        const actualizada = await recalcularTotales(liquidacion.id);
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: liquidacion.id,
            detalle: `Liquidación creada para contrato ${contratoId}, periodo ${periodo}`
        });

        res.status(201).json(actualizada);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear liquidación' });
    }
});

// Agregar un movimiento
router.post('/:id/movimientos', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { tipo, concepto, monto, observaciones } = req.body;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        const ESTADOS_EDITABLES: EstadoLiquidacion[] = ['BORRADOR', 'PENDIENTE_PAGO', 'PAGADA_POR_INQUILINO'];
        if (!ESTADOS_EDITABLES.includes(liquidacion.estado)) {
            return res.status(400).json({ message: 'No se pueden editar liquidaciones ya liquidadas' });
        }

        await prisma.movimiento.create({
            data: {
                tipo,
                concepto,
                monto: monto ? monto.toString() : 0,
                observaciones,
                liquidacionId: Number(id)
            }
        });

        const actualizada = await recalcularTotales(Number(id));
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'AGREGAR_MOVIMIENTO',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: `${tipo}: ${concepto} por monto ${monto}`
        });

        res.status(201).json(actualizada);
    } catch (error) {
        res.status(500).json({ message: 'Error al agregar movimiento' });
    }
});

// Eliminar un movimiento
router.delete('/movimientos/:movimientoId', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { movimientoId } = req.params;

    try {
        const movimiento = await prisma.movimiento.findUnique({
            where: { id: Number(movimientoId) },
            include: { liquidacion: true }
        });

        if (!movimiento || movimiento.liquidacion.inmobiliariaId !== inmobiliariaId) {
            return res.status(404).json({ message: 'Movimiento no encontrado' });
        }

        if (movimiento.liquidacion.estado === 'LIQUIDADA') {
            return res.status(400).json({ message: 'No se pueden editar liquidaciones ya liquidadas' });
        }

        await prisma.movimiento.delete({
            where: { id: Number(movimientoId) }
        });

        const actualizada = await recalcularTotales(movimiento.liquidacionId);
        res.json(actualizada);
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar movimiento' });
    }
});

// Confirmar liquidación (Borrador -> Pendiente de Pago)
router.patch('/:id/confirmar', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== 'BORRADOR') {
            return res.status(400).json({ message: 'Solo se pueden confirmar liquidaciones en estado borrador' });
        }

        const actualizada = await prisma.liquidacion.update({
            where: { id: Number(id) },
            data: {
                estado: 'PENDIENTE_PAGO',
            },
            include: { movimientos: true }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CONFIRMAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: 'Liquidación confirmada y pasada a pendiente de pago'
        });

        res.json(actualizada);
    } catch (error) {
        res.status(500).json({ message: 'Error al confirmar liquidación' });
    }
});

// Cerrar liquidación (LIQUIDADA ya no se usa aquí directamente, se usa en pagar-propietario)
// Pero mantenemos esta ruta por si se quiere forzar un cierre manual o si el usuario la usaba.
// He decidido renombrarla o ajustarla si es necesario, pero según el plan:
// PAGADA_POR_INQUILINO -> LIQUIDADA (vía pagar-propietario)
// Borrador -> Pendiente (vía confirmar)
// Pendiente -> Pagada (vía pagos)


// Actualizar honorarios de una liquidación
router.patch('/:id/honorarios', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { montoHonorarios, porcentajeHonorarios } = req.body;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        const ESTADOS_EDITABLES: EstadoLiquidacion[] = ['BORRADOR', 'PENDIENTE_PAGO', 'PAGADA_POR_INQUILINO'];
        if (!ESTADOS_EDITABLES.includes(liquidacion.estado)) {
            return res.status(400).json({ message: 'No se pueden editar liquidaciones ya liquidadas' });
        }

        const actualizada = await prisma.liquidacion.update({
            where: { id: Number(id) },
            data: {
                montoHonorarios: montoHonorarios !== undefined ? Number(montoHonorarios) : undefined,
                porcentajeHonorarios: porcentajeHonorarios !== undefined ? Number(porcentajeHonorarios) : undefined,
            },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                        propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                    } 
                }
            }
        });

        res.json(actualizada);
    } catch (error) {
        console.error('Error updates honorarios:', error);
        res.status(500).json({ message: 'Error al actualizar honorarios' });
    }
});

// Eliminar liquidación (Solo si es borrador)
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!liquidacion) {
            return res.status(404).json({ message: 'Liquidación no encontrada' });
        }

        if (liquidacion.estado !== 'BORRADOR') {
            return res.status(400).json({ message: 'Solo se pueden eliminar liquidaciones en borrador' });
        }

        await prisma.liquidacion.delete({
            where: { id: Number(id) }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_LIQUIDACION',
            entidad: 'Liquidacion',
            entidadId: Number(id)
        });

        res.json({ message: 'Liquidación eliminada' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar liquidación' });
    }
});

// Registrar pago al propietario
router.patch('/:id/pagar-propietario', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { fechaPago, metodoPago, observaciones } = req.body;

    try {
        const result = await prisma.$transaction(async (tx) => {
            const liquidacion = await tx.liquidacion.findFirst({
                where: { id: Number(id), inmobiliariaId },
                include: { contrato: true }
            });

            if (!liquidacion) {
                throw new Error('Liquidación no encontrada');
            }

            if (liquidacion.estado !== EstadoLiquidacion.PAGADA_POR_INQUILINO) {
                throw new Error('La liquidación debe estar pagada por el inquilino para poder pagar al propietario');
            }

            const montoHonorarios = new Decimal(liquidacion.montoHonorarios.toString());
            
            // Sumamos los movimientos que son para la inmobiliaria
            const movimientosInmobiliaria = await tx.movimiento.findMany({
                where: { liquidacionId: Number(id), esParaInmobiliaria: true }
            });
            const totalOtrosIngresosInmo = movimientosInmobiliaria.reduce(
                (sum, m) => sum.plus(new Decimal(m.monto.toString())), 
                new Decimal(0)
            );

            const montoPropietario = new Decimal(liquidacion.netoACobrar.toString())
                .minus(montoHonorarios)
                .minus(totalOtrosIngresosInmo);

            // 1. Actualizar liquidación
            const actualizada = await tx.liquidacion.update({
                where: { id: Number(id) },
                data: {
                    estado: 'LIQUIDADA',
                    fechaPagoPropietario: new Date(fechaPago || new Date()),
                    metodoPagoPropietario: metodoPago || 'EFECTIVO'
                }
            });

            // 2. Registrar egreso en caja con concepto descriptivo
            if (montoPropietario.greaterThan(0)) {
                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'EGRESO',
                        concepto: generarConcepto('Pago Propietario', liquidacion),
                        monto: montoPropietario,
                        fecha: new Date(fechaPago || new Date()),
                        metodoPago: metodoPago || 'EFECTIVO',
                        cuenta: (metodoPago === 'EFECTIVO') ? 'CAJA' : 'BANCO',
                        observaciones: observaciones || undefined,
                        creadoPorId: (req as AuthRequest).user!.id,
                        contratoId: liquidacion.contratoId,
                        liquidacionId: liquidacion.id
                    }
                });
            }

            return actualizada;
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'PAGO_PROPIETARIO',
            entidad: 'Liquidacion',
            entidadId: Number(id),
            detalle: `Pago al propietario registrado por liquidación ${id}`
        });

        res.json(result);
    } catch (error: any) {
        console.error(error);
        res.status(400).json({ message: error.message || 'Error al registrar pago al propietario' });
    }
});

// ─── Helpers PDF ─────────────────────────────────────────────────────────────

const formatCurrencyPdf = (amount: number) =>
    `$${amount.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDatePdf = (date: Date | string | null | undefined) => {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('es-AR', { timeZone: 'UTC' });
};

const formatPeriodPdf = (date: Date | string) =>
    new Date(date).toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ─── PDF Inquilino (Comprobante de pago) ─────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { include: { persona: true } }, 
                        propietarios: { include: { persona: true } } 
                    } 
                },
                pagos: true
            }
        });

        if (!liquidacion) return res.status(404).json({ message: 'Liquidación no encontrada' });

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="comprobante-inquilino-${id}.pdf"`);
        doc.pipe(res);

        const INDIGO = '#4F46E5';
        const GRAY = '#6B7280';
        const LIGHT_GRAY = '#F9FAFB';
        const pageWidth = doc.page.width - 100;

        // Header
        doc.rect(50, 50, pageWidth, 80).fill(INDIGO);
        doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
            .text('COMPROBANTE DE ALQUILER', 70, 68, { width: pageWidth - 20 });
        doc.fontSize(12).font('Helvetica')
            .text(`Período: ${formatPeriodPdf(liquidacion.periodo).toUpperCase()}`, 70, 95);
        doc.fontSize(10)
            .text(`N° ${String(liquidacion.id).padStart(6, '0')}  |  Estado: ${liquidacion.estado}`, 70, 112);

        // Datos contrato
        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('DATOS DEL CONTRATO', 50, 150);
        doc.moveTo(50, 164).lineTo(50 + pageWidth, 164).strokeColor(INDIGO).lineWidth(1).stroke();

        const col1 = 50, col2 = 310;
        let y = 172;

        const field = (label: string, value: string, x: number, yPos: number) => {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(label.toUpperCase(), x, yPos);
            doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text(value, x, yPos + 12);
        };

        const liqAny = liquidacion as any;
        field('Inmueble', liqAny.contrato?.propiedad.direccion || '-', col1, y);
        const pPrincipal = liqAny.contrato?.propietarios?.find((p: any) => p.esPrincipal)?.persona.nombreCompleto || '-';
        field('Propietario', pPrincipal, col2, y);
        y += 40;
        const iPrincipal = liqAny.contrato?.inquilinos?.find((i: any) => i.esPrincipal)?.persona.nombreCompleto || '-';
        field('Inquilino', iPrincipal, col1, y);
        field('Fecha de Emisión', formatDatePdf(liquidacion.fechaCreacion), col2, y);
        y += 40;
        field('Próxima Actualización', formatDatePdf(liqAny.contrato?.fechaProximaActualizacion), col1, y);
        y += 50;

        // Ingresos
        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('INGRESOS', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
        doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
            .text('CONCEPTO', 58, y + 6)
            .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 20;

        liqAny.movimientos.filter((m: any) => m.tipo === 'INGRESO').forEach((m: any) => {
            doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
            doc.text(formatCurrencyPdf(Number(m.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
            doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
            y += 20;
        });

        doc.rect(50, y, pageWidth, 20).fill('#ECFDF5');
        doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
            .text('SUBTOTAL INGRESOS', 58, y + 6)
            .text(formatCurrencyPdf(Number(liquidacion.totalIngresos)), 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 30;

        // Descuentos
        const descuentos = liquidacion.movimientos.filter(m => m.tipo === 'DESCUENTO');
        if (descuentos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('EGRESOS / DESCUENTOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
            doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
                .text('CONCEPTO', 58, y + 6)
                .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 20;

            descuentos.forEach(m => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
                doc.fillColor('#DC2626').text(`(${formatCurrencyPdf(Number(m.monto))})`, 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });

            doc.rect(50, y, pageWidth, 20).fill('#FEF2F2');
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SUBTOTAL DESCUENTOS', 58, y + 6)
                .text(`(${formatCurrencyPdf(Number(liquidacion.totalDescuentos))})`, 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 30;
        }

        // Neto
        doc.rect(50, y, pageWidth, 36).fill(INDIGO);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
            .text('NETO A PAGAR', 58, y + 12)
            .text(formatCurrencyPdf(Number(liquidacion.netoACobrar)), 50 + pageWidth - 120, y + 12, { width: 110, align: 'right' });
        y += 50;

        // Pagos
        if (liqAny.pagos && liqAny.pagos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('PAGOS REGISTRADOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            liqAny.pagos.forEach((p: any) => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica')
                    .text(formatDatePdf(p.fechaPago), 58, y + 5)
                    .text(p.metodoPago, 200, y + 5)
                    .text(p.observaciones || '-', 300, y + 5);
                doc.fillColor('#059669').font('Helvetica-Bold')
                    .text(formatCurrencyPdf(Number(p.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });
        }

        // Saldo pendiente
        const totalPagado = (liqAny.pagos || []).reduce((acc: number, p: any) => acc + Number(p.monto), 0);
        const saldoPendiente = Number(liquidacion.netoACobrar) - totalPagado;
        if (saldoPendiente > 0) {
            y += 10;
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SALDO PENDIENTE', 58, y)
                .text(formatCurrencyPdf(saldoPendiente), 50 + pageWidth - 80, y, { width: 70, align: 'right' });
        }

        // Footer
        doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(`Documento generado el ${formatDatePdf(new Date())}`, 50, doc.page.height - 60, {
                width: pageWidth, align: 'center'
            });

        doc.end();
    } catch (error) {
        console.error('Error generating PDF inquilino:', error);
        if (!res.headersSent) res.status(500).json({ message: 'Error al generar el PDF' });
    }
});

// ─── PDF Propietario (Liquidación con honorarios y datos del contrato) ────────
router.get('/:id/pdf-propietario', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                movimientos: true,
                contrato: { 
                    include: { 
                        propiedad: true, 
                        inquilinos: { include: { persona: true } }, 
                        propietarios: { include: { persona: true } } 
                    } 
                },
                pagos: true
            }
        });

        if (!liquidacion) return res.status(404).json({ message: 'Liquidación no encontrada' });

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="liquidacion-propietario-${id}.pdf"`);
        doc.pipe(res);

        const contrato = liquidacion.contrato as any;
        const TEAL = '#0F766E';
        const INDIGO = '#4F46E5';
        const GRAY = '#6B7280';
        const LIGHT_GRAY = '#F9FAFB';
        const pageWidth = doc.page.width - 100;

        // Header (color verde-teal para diferenciar del PDF del inquilino)
        doc.rect(50, 50, pageWidth, 80).fill(TEAL);
        doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
            .text('LIQUIDACIÓN — COMPROBANTE PROPIETARIO', 70, 64, { width: pageWidth - 20 });
        doc.fontSize(12).font('Helvetica')
            .text(`Período: ${formatPeriodPdf(liquidacion.periodo).toUpperCase()}`, 70, 95);
        doc.fontSize(10)
            .text(`N° ${String(liquidacion.id).padStart(6, '0')}  |  Estado: ${liquidacion.estado}`, 70, 112);

        // Datos contrato (ampliados)
        doc.fillColor(TEAL).fontSize(11).font('Helvetica-Bold').text('DATOS DEL CONTRATO', 50, 150);
        doc.moveTo(50, 164).lineTo(50 + pageWidth, 164).strokeColor(TEAL).lineWidth(1).stroke();

        const col1 = 50, col2 = 310;
        let y = 172;

        const field = (label: string, value: string, x: number, yPos: number) => {
            doc.fillColor(GRAY).fontSize(8).font('Helvetica').text(label.toUpperCase(), x, yPos);
            doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text(value, x, yPos + 12);
        };

        const liqAnyProp = liquidacion as any;
        field('Inmueble', contrato?.propiedad?.direccion || '-', col1, y);
        const pPrincipal = contrato?.propietarios?.find((p: any) => p.esPrincipal)?.persona.nombreCompleto || '-';
        field('Propietario', pPrincipal, col2, y);
        y += 40;
        const iPrincipal = contrato?.inquilinos?.find((i: any) => i.esPrincipal)?.persona.nombreCompleto || '-';
        field('Inquilino', iPrincipal, col1, y);
        field('Fecha de Emisión', formatDatePdf(liquidacion.fechaCreacion), col2, y);
        y += 40;
        field('Vencimiento del Contrato', formatDatePdf(contrato?.fechaFin), col1, y);
        field('Próxima Actualización', formatDatePdf(contrato?.fechaProximaActualizacion), col2, y);
        y += 40;

        // Tipo de ajuste y porcentaje
        const partsAjuste = [
            contrato?.tipoAjuste || null,
            contrato?.porcentajeActualizacion ? `${Number(contrato.porcentajeActualizacion)}%` : null
        ].filter(Boolean);
        field('Tipo / % de Ajuste', partsAjuste.length > 0 ? partsAjuste.join(' · ') : '-', col1, y);
        y += 50;

        // Ingresos
        const ingresosPropietario = liqAnyProp.movimientos.filter((m: any) => m.tipo === 'INGRESO' && !m.esParaInmobiliaria);
        const totalIngresosProp = ingresosPropietario.reduce((acc: number, m: any) => acc + Number(m.monto), 0);

        doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('INGRESOS', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
        doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
            .text('CONCEPTO', 58, y + 6)
            .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 20;

        ingresosPropietario.forEach((m: any) => {
            doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
            doc.text(formatCurrencyPdf(Number(m.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
            doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
            y += 20;
        });

        doc.rect(50, y, pageWidth, 20).fill('#ECFDF5');
        doc.fillColor('#065F46').fontSize(9).font('Helvetica-Bold')
            .text('SUBTOTAL INGRESOS', 58, y + 6)
            .text(formatCurrencyPdf(totalIngresosProp), 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
        y += 30;

        // Descuentos
        const descuentosPropietario = liquidacion.movimientos.filter(m => m.tipo === 'DESCUENTO' && !m.esParaInmobiliaria);
        const totalDescuentosProp = descuentosPropietario.reduce((acc: number, m: any) => acc + Number(m.monto), 0);

        if (descuentosPropietario.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('EGRESOS / DESCUENTOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            doc.rect(50, y, pageWidth, 20).fill(LIGHT_GRAY);
            doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
                .text('CONCEPTO', 58, y + 6)
                .text('MONTO', 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 20;

            descuentosPropietario.forEach(m => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica').text(m.concepto, 58, y + 5);
                doc.fillColor('#DC2626').text(`(${formatCurrencyPdf(Number(m.monto))})`, 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });

            doc.rect(50, y, pageWidth, 20).fill('#FEF2F2');
            doc.fillColor('#991B1B').fontSize(9).font('Helvetica-Bold')
                .text('SUBTOTAL DESCUENTOS', 58, y + 6)
                .text(`(${formatCurrencyPdf(totalDescuentosProp)})`, 50 + pageWidth - 80, y + 6, { width: 70, align: 'right' });
            y += 30;
        }

        const netoACobrarProp = totalIngresosProp - totalDescuentosProp;

        // Honorarios inmobiliaria
        const montoHonorarios = Number(liquidacion.montoHonorarios || 0);
        const porcentajeHonorarios = liquidacion.porcentajeHonorarios ? Number(liquidacion.porcentajeHonorarios) : null;
        const pagaHonorarios: string = contrato?.pagaHonorarios || 'INQUILINO';

        doc.fillColor(TEAL).fontSize(11).font('Helvetica-Bold').text('HONORARIOS INMOBILIARIA', 50, y);
        doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(TEAL).lineWidth(1).stroke();
        y += 22;

        doc.rect(50, y, pageWidth, 22).fill('#F0FDFA');
        const honorariosDescText = porcentajeHonorarios ? `${porcentajeHonorarios}% sobre alquiler` : 'Monto fijo';
        doc.fillColor('#134E4A').fontSize(9).font('Helvetica')
            .text(`${honorariosDescText} — Abona: ${pagaHonorarios}`, 58, y + 7);
        doc.font('Helvetica-Bold')
            .text(formatCurrencyPdf(montoHonorarios), 50 + pageWidth - 80, y + 7, { width: 70, align: 'right' });
        y += 32;

        // Neto al propietario (Se descuentan los honorarios incondicionalmente del dueño)
        const honorariosPropietario = montoHonorarios;
        const netoParaPropietario = netoACobrarProp - honorariosPropietario;

        doc.rect(50, y, pageWidth, 36).fill(TEAL);
        doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
            .text('NETO A TRANSFERIR AL PROPIETARIO', 58, y + 12)
            .text(formatCurrencyPdf(netoParaPropietario), 50 + pageWidth - 120, y + 12, { width: 110, align: 'right' });
        y += 50;

        // Pagos recibidos
        if (liquidacion.pagos && liquidacion.pagos.length > 0) {
            doc.fillColor(INDIGO).fontSize(11).font('Helvetica-Bold').text('PAGOS RECIBIDOS', 50, y);
            doc.moveTo(50, y + 14).lineTo(50 + pageWidth, y + 14).strokeColor(INDIGO).lineWidth(1).stroke();
            y += 22;

            liquidacion.pagos.forEach(p => {
                doc.fillColor('#111827').fontSize(9).font('Helvetica')
                    .text(formatDatePdf(p.fechaPago), 58, y + 5)
                    .text(p.metodoPago, 200, y + 5)
                    .text(p.observaciones || '-', 300, y + 5);
                doc.fillColor('#059669').font('Helvetica-Bold')
                    .text(formatCurrencyPdf(Number(p.monto)), 50 + pageWidth - 80, y + 5, { width: 70, align: 'right' });
                doc.moveTo(50, y + 18).lineTo(50 + pageWidth, y + 18).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
                y += 20;
            });
        }

        // Footer
        doc.fillColor(GRAY).fontSize(8).font('Helvetica')
            .text(`Documento generado el ${formatDatePdf(new Date())} — USO INTERNO`, 50, doc.page.height - 60, {
                width: pageWidth, align: 'center'
            });

        doc.end();
    } catch (error) {
        console.error('Error generating PDF propietario:', error);
        if (!res.headersSent) res.status(500).json({ message: 'Error al generar el PDF del propietario' });
    }
});

export default router;
