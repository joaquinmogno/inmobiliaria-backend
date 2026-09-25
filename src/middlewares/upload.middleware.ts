import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const MAX_FILE_SIZE_MB = 30;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const allowedMimeTypesByExtension = new Map<string, Set<string>>([
    ['.pdf', new Set(['application/pdf'])],
    ['.doc', new Set(['application/msword'])],
    ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
    ['.jpg', new Set(['image/jpeg'])],
    ['.jpeg', new Set(['image/jpeg'])],
    ['.png', new Set(['image/png'])],
    ['.webp', new Set(['image/webp'])],
]);
const allowedExtensions = new Set(['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp']);
const allowedMainContractExtensions = new Set(['.pdf', '.doc', '.docx']);
const allowedFormatsMessage = 'PDF, DOC, DOCX, JPG, PNG o WEBP';

const hasMatchingMimeType = (extension: string, mimetype: string) => {
    return allowedMimeTypesByExtension.get(extension)?.has(mimetype) || false;
};

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const temporaryUploadDir = path.join(uploadDir, '.tmp');
if (!fs.existsSync(temporaryUploadDir)) {
    fs.mkdirSync(temporaryUploadDir, { recursive: true });
}

const staleThreshold = Date.now() - 60 * 60 * 1000;
fs.promises.readdir(temporaryUploadDir, { withFileTypes: true })
    .then(entries => Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
        const temporaryPath = path.join(temporaryUploadDir, entry.name);
        const stats = await fs.promises.stat(temporaryPath);
        if (stats.mtimeMs < staleThreshold) await fs.promises.unlink(temporaryPath);
    })))
    .catch(() => undefined);

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, temporaryUploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, `${file.fieldname}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    }

});

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.has(extension)) {
        return cb(new Error(`Tipo de archivo no permitido. Solo se aceptan ${allowedFormatsMessage}.`));
    }

    if (file.fieldname === 'pdf' && (!allowedMainContractExtensions.has(extension) || !hasMatchingMimeType(extension, file.mimetype))) {
        return cb(new Error('El contrato principal debe ser un archivo PDF, DOC o DOCX.'));
    }

    if (!hasMatchingMimeType(extension, file.mimetype)) {
        return cb(new Error(`Tipo de archivo no permitido. Solo se aceptan ${allowedFormatsMessage}.`));
    }

    cb(null, true);
};

export const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES
    }
});

export const cleanupFailedUpload = (req: Request, res: Response, next: NextFunction) => {
    res.once('finish', () => {
        if (res.statusCode >= 400 && req.file?.path) {
            fs.promises.unlink(req.file.path).catch(() => undefined);
        }
    });
    next();
};

const matchesFileSignature = async (file: Express.Multer.File) => {
    const handle = await fs.promises.open(file.path, 'r');
    const header = Buffer.alloc(16);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension === '.pdf') return header.subarray(0, 5).toString() === '%PDF-';
    if (extension === '.jpg' || extension === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    if (extension === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (extension === '.webp') return header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP';
    if (extension === '.doc') return header.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if (extension === '.docx') return header[0] === 0x50 && header[1] === 0x4b && [0x03, 0x05, 0x07].includes(header[2]);
    return false;
};

export const validateUploadedFileContent = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) return next();
    const file = req.file;
    try {
        if (!(await matchesFileSignature(file))) {
            await fs.promises.unlink(file.path).catch(() => undefined);
            req.file = undefined;
            return res.status(400).json({ message: 'El contenido real del archivo no coincide con su formato', code: 'INVALID_FILE_CONTENT' });
        }
        next();
    } catch (error) {
        await fs.promises.unlink(file.path).catch(() => undefined);
        next(error);
    }
};

export const commitUploadedFile = async (file: Express.Multer.File | undefined, inmobiliariaId: number) => {
    if (!file) return null;

    const agencyDirName = `inmobiliaria-${inmobiliariaId}`;
    const agencyDir = path.join(uploadDir, agencyDirName);
    await fs.promises.mkdir(agencyDir, { recursive: true });

    const destination = path.join(agencyDir, file.filename);
    await fs.promises.rename(file.path, destination);
    file.path = destination;
    file.destination = agencyDir;

    return `${agencyDirName}/${file.filename}`;
};

export const removeUploadedFile = async (filePath: string | null | undefined) => {
    if (!filePath) return;
    const absolutePath = path.resolve(uploadDir, filePath);
    const uploadsRoot = path.resolve(uploadDir);
    if (!absolutePath.startsWith(`${uploadsRoot}${path.sep}`)) return;
    await fs.promises.unlink(absolutePath).catch(() => undefined);
};
