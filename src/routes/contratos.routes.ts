import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { upload } from '../middlewares/upload.middleware';

const router = Router();

router.use(authenticateToken);

// Get all contracts
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    try {
        const contracts = await prisma.contrato.findMany({
            where: { inmobiliariaId },
            include: {
                propiedad: true,
                propietario: true,
                inquilino: true,
                adjuntos: true
            },
            orderBy: { fechaCreacion: 'desc' }
        });
        res.json(contracts);
    } catch (error) {
        console.error('Error fetching contracts:', error);
        res.status(500).json({ message: 'Error al obtener contratos' });
    }
});


function parseDateOnly(dateStr: string) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

// Create contract
router.post('/', upload.single('pdf'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const {
        fechaInicio,
        fechaFin,
        fechaActualizacion,
        observaciones,
        propiedadId,
        propietarioId,
        inquilinoId
    } = req.body;

    const pdfPath = req.file ? `inmobiliaria-${inmobiliariaId}/${req.file.filename}` : null;

    try {
        // Verify entities exist and belong to agency
        const [propiedad, propietario, inquilino] = await Promise.all([
            prisma.propiedad.findFirst({ where: { id: Number(propiedadId), inmobiliariaId } }),
            prisma.propietario.findFirst({ where: { id: Number(propietarioId), inmobiliariaId } }),
            prisma.inquilino.findFirst({ where: { id: Number(inquilinoId), inmobiliariaId } })
        ]);

        if (!propiedad || !propietario || !inquilino) {
            return res.status(400).json({ message: 'Entidades relacionadas inválidas' });
        }

        const contract = await prisma.contrato.create({
            data: {
                fechaInicio: parseDateOnly(fechaInicio),
                fechaFin: parseDateOnly(fechaFin),
                fechaProximaActualizacion: fechaActualizacion
                    ? parseDateOnly(fechaActualizacion)
                    : null,
                observaciones,
                rutaPdf: pdfPath,
                propiedadId: Number(propiedadId),
                propietarioId: Number(propietarioId),
                inquilinoId: Number(inquilinoId),
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id
            }
        });


        res.status(201).json(contract);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear contrato' });
    }
});

// Get contract details
router.get('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                propiedad: true,
                propietario: true,
                inquilino: true,
                adjuntos: true
            }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        res.json(contract);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener contrato' });
    }
});

// Add attachment
router.post('/:id/adjuntos', upload.single('archivo'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreArchivo } = req.body;

    if (!req.file) {
        return res.status(400).json({ message: 'No se subió ningún archivo' });
    }

    const filePath = `inmobiliaria-${inmobiliariaId}/${req.file.filename}`;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const attachment = await prisma.adjuntoContrato.create({
            data: {
                rutaArchivo: filePath,
                nombreArchivo: nombreArchivo || req.file.originalname,
                contratoId: Number(id)
            }
        });

        res.status(201).json(attachment);
    } catch (error) {
        res.status(500).json({ message: 'Error al subir adjunto' });
    }
});

// Soft delete (Move to trash)
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.update({
            where: { id: Number(id) },
            data: {
                estado: 'PAPELERA',
                eliminadoEn: new Date(),
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });

        res.json({ message: 'Contrato movido a la papelera' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar contrato' });
    }
});

// Restore contract
router.post('/:id/restaurar', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.update({
            where: { id: Number(id) },
            data: {
                estado: 'ACTIVO',
                eliminadoEn: null,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });

        res.json({ message: 'Contrato restaurado con éxito' });
    } catch (error) {
        res.status(500).json({ message: 'Error al restaurar contrato' });
    }
});

// Permanent delete
router.delete('/:id/permanente', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.delete({
            where: { id: Number(id) }
        });

        res.json({ message: 'Contrato eliminado permanentemente' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar contrato permanentemente' });
    }
});

export default router;
