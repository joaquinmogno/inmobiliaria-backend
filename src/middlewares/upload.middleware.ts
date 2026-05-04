import multer from 'multer';
import path from 'path';
import fs from 'fs';

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const MAX_FILE_SIZE_MB = 30;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const allowedAttachmentMimeTypes = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
]);
const allowedExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);

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
        return cb(new Error('Tipo de archivo no permitido. Solo se aceptan PDF, JPG, PNG o WEBP.'));
    }

    if (file.fieldname === 'pdf' && file.mimetype !== 'application/pdf') {
        return cb(new Error('El contrato principal debe ser un archivo PDF.'));
    }

    if (!allowedAttachmentMimeTypes.has(file.mimetype)) {
        return cb(new Error('Tipo de archivo no permitido. Solo se aceptan PDF, JPG, PNG o WEBP.'));
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
