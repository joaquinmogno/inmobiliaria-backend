-- CreateEnum
CREATE TYPE "TipoPropiedad" AS ENUM ('DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO');

-- CreateEnum
CREATE TYPE "EstadoPropiedad" AS ENUM ('DISPONIBLE', 'ALQUILADO', 'INACTIVO');

-- AlterTable
ALTER TABLE "Propiedad" ADD COLUMN     "estado" "EstadoPropiedad" NOT NULL DEFAULT 'DISPONIBLE',
ADD COLUMN     "observaciones" TEXT,
ADD COLUMN     "tipo" "TipoPropiedad" NOT NULL DEFAULT 'DEPARTAMENTO';
