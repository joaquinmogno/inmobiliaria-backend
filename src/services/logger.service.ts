type LogLevel = 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown>;

const serializeError = (error: unknown) => {
  if (!(error instanceof Error)) return error;

  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
};

const writeLog = (level: LogLevel, message: string, meta?: LogMeta) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(meta ? {
      meta: Object.fromEntries(
        Object.entries(meta).map(([key, value]) => [key, key === 'error' ? serializeError(value) : value])
      )
    } : {})
  };

  const line = JSON.stringify(payload);

  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = {
  info: (message: string, meta?: LogMeta) => writeLog('info', message, meta),
  warn: (message: string, meta?: LogMeta) => writeLog('warn', message, meta),
  error: (message: string, meta?: LogMeta) => writeLog('error', message, meta)
};
