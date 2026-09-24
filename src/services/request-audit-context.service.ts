import { AsyncLocalStorage } from 'async_hooks';

export type RequestAuditContext = {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
};

const storage = new AsyncLocalStorage<RequestAuditContext>();

export const runWithRequestAuditContext = <T>(context: RequestAuditContext, callback: () => T): T => (
  storage.run(context, callback)
);

export const getRequestAuditContext = () => storage.getStore();
