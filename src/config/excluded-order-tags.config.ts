// Orders carrying any of these tags belong to pupils who get a *physical* school travel card
// instead of a digital one, so they must never receive an Entur fare contract.
//
// The tag lives on the order, not the pupil (dbo.OrderTags.OrderId -> dbo.Tags.Text), so exclusion
// is per order: a pupil's other, untagged orders keep syncing normally. That matches how the rest
// of the pipeline is keyed, since a fare contract is per (studentId, applicationId).
//
// Matched against dbo.Tags.Text exactly — see buildExcludedOrderTagFilter in
// src/utils/excluded-order-tags.utils.ts for the SQL and where it is applied.
export const EXCLUDED_ORDER_TAGS: string[] = ['VGS Fysisk skolereisekort'];

// ENTUR_EXCLUDED_ORDER_TAGS overrides the list above (comma-separated), so it can be changed
// without a deploy. Read at call time, like getFareContractConfig does with its env vars.
//
// An empty or blank override means "exclude nothing", which restores the pre-tag behaviour of
// sending every eligible order. That is deliberate: it is the escape hatch if the tag filter ever
// needs to be switched off in a hurry.
// Normalising both paths — not just the env override — is what lets callers treat an empty result as
// "exclude nothing". A blank entry left in the constant above would otherwise pass a length check
// and then contribute no SQL placeholder, leaving a dangling AND behind.
export const getExcludedOrderTags = (): string[] => {
  const configured = process.env.ENTUR_EXCLUDED_ORDER_TAGS?.split(',') ?? EXCLUDED_ORDER_TAGS;

  return configured.map((tag) => String(tag).trim()).filter(Boolean);
};
