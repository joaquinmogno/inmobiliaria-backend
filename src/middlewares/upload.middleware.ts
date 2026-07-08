import multer from 'multer';
import path from 'path';
import fs from 'fs';

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

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const authReq = req as any;
        const inmobiliariaId = authReq.user?.inmobiliariaId;

        const dir = path.join(uploadDir, `inmobiliaria-${inmobiliariaId}`);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
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
