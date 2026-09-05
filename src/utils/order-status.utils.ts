export const APPROVED_PRIMARY_STATUS = 2;

// An order is only actionable for Entur when PrimaryStatus is 2 (approved/active).
// Any other value — including undefined/null — is treated as not approved.
export const isOrderApproved = (primaryStatus: string | number | null | undefined): boolean =>
  primaryStatus !== undefined && primaryStatus !== null && Number(primaryStatus) === APPROVED_PRIMARY_STATUS;
