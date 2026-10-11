# Delivery weight units

New and updated delivery-order weighbridge fields are stored in kilograms with
`weightUnit: "kg"`. This includes quarry/site weigh-in, weigh-out, net weights,
and weight variance/tolerance fields. A five-tonne arrival tolerance is stored
as 5,000 kg.

The mobile app submits these fields with `weightUnit: "kg"`. Payloads without
a marker remain interpreted as tonnes for compatibility with older clients.
Only `kg` and `tonnes` are supported; units are never guessed from magnitude.

Existing service calculations, cached records, and delivery API responses use
tonnes and carry `weightUnit: "tonnes"`. This compatibility boundary preserves
existing reporting, purchase-order accounting, and older app screens. Operator
weighing screens format these values as kg.

Commercial quantities (`quantityOrdered`, `quantityDelivered`, material receipt
quantities, etc.) retain their existing units. They are not weighbridge fields
and must not be multiplied merely because `weightUnit` is kg.

Legacy unmarked records are read as tonnes. On a normal delivery update, all
existing weight fields are converted together in the same transaction, including
fields omitted from the incoming patch. Repeated updates do not reconvert kg
records. Historical records are not rewritten in bulk.

The Access unloading bridge normalizes stored jobs before comparing captures,
so manual and automatic readings can safely resume the same trip. The separate
Access loading-ticket workflow already stores kg and is unchanged.
