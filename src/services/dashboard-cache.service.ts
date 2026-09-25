/**
 * Cada permiso de esta estructura modifica al menos un campo de la respuesta
 * del tablero. Mantenerlos tipados evita reutilizar entre usuarios una entrada
 * de caché generada con un alcance distinto.
 */
export type DashboardResultPermissions = {
  canViewSalaries: boolean;
  canViewFinancialReports: boolean;
  canViewContractReports: boolean;
  canViewDelinquencyReports: boolean;
  canViewLiquidations: boolean;
};

export const getDashboardPermissionScope = (permissions: DashboardResultPermissions) => [
  `salaries:${Number(permissions.canViewSalaries)}`,
  `financial:${Number(permissions.canViewFinancialReports)}`,
  `contracts:${Number(permissions.canViewContractReports)}`,
  `delinquency:${Number(permissions.canViewDelinquencyReports)}`,
  `liquidations:${Number(permissions.canViewLiquidations)}`
].join('|');
